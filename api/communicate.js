// Outbound email — two delivery paths in one file:
//
//   Gmail (user-from):  contractor requests, family updates where the
//                      message should arrive in someone's inbox as
//                      coming from the household member themselves.
//                      Requires the gmail.send OAuth scope; until
//                      that scope is added to the consent screen +
//                      users re-authenticate, the send call will
//                      403 with a clear error that callers can
//                      surface.
//   Resend (branded):   weekly summaries, network updates, anything
//                      that should arrive from Conductor. Uses a
//                      brand-aligned HTML template (dark + brass +
//                      off-white).
//
// Three actions on this single route:
//   POST /api/communicate?action=draft
//        body { userId, recipientEmail, recipientName, subject?,
//               context?, communicationType }
//        Generates a Haiku-drafted subject + body. No send.
//   POST /api/communicate?action=send
//        body { userId, recipientEmail, subject, body, signalId?,
//               via: 'gmail' | 'resend' }
//        Routes by `via`. Sent records persist to
//        household:{id}:sentCommunications (LPUSH, capped at 200).
//   POST /api/communicate?action=preview-html
//        body { subject, body }
//        Returns the Resend HTML template wrapped around the body
//        text — used by the mobile composer's preview pane.

import { Redis } from "@upstash/redis";
import { getValidToken } from "./refresh.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Lazy-loaded Resend client. Without RESEND_API_KEY we skip the
// branded path and surface a clear error instead of crashing.
let resendClient = null;
function getResend() {
  if (resendClient) return resendClient;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Resend } = require("resend");
    resendClient = new Resend(key);
    return resendClient;
  } catch (err) {
    console.error("[communicate] resend init failed:", err?.message);
    return null;
  }
}

async function resolveHouseholdId(userId) {
  if (!userId) return null;
  const hid = await redis.get(`user:${userId}:household`);
  return hid || userId;
}

function safeJson(v) {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
}

// ---------- Draft generation ----------

// Per-type prompt nuance. The schema returned is identical so the
// caller doesn't have to switch on type.
const DRAFT_INSTRUCTIONS = {
  contractor_request:
    "Professional service request email. Polite, concise, asks for what the household needs. Includes a request for a quote or scheduling window. Sign off with the household member's first name.",
  network_update:
    "Warm family update email. Personal tone — like writing to family. Keep it short, no jargon. Sign off with the household member's first name.",
  family_summary:
    "Weekly summary email for a non-app family member. Calm + reflective tone. 3-5 short sentences covering what the household handled this week.",
  general:
    "General household communication. Match tone to the context provided.",
};

async function generateDraft({ communicationType, recipientName, fromName, subject, context }) {
  const instruction = DRAFT_INSTRUCTIONS[communicationType] || DRAFT_INSTRUCTIONS.general;
  const prompt = `Write a household email. Return ONLY the structured JSON via the tool.

Recipient: ${recipientName || "(not specified)"}
From: ${fromName || "the household"}
Existing subject hint (use or refine): ${subject || "(none)"}
Context (what the email is about): ${context || "(none)"}

Style instructions:
${instruction}

Output guidelines:
- Subject: short, < 60 chars, no quotes.
- Body: plain text with single newlines between paragraphs. No markdown, no signatures with multiple lines beyond one closing.
- 3-5 short paragraphs max for non-summary types; family_summary may be a single paragraph.
- Sign off naturally — "— ${fromName || "James"}" or similar.`;

  const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      tools: [
        {
          name: "record_email_draft",
          description: "Record a drafted email's subject + body.",
          input_schema: {
            type: "object",
            properties: {
              subject: { type: "string" },
              body: { type: "string" },
            },
            required: ["subject", "body"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "record_email_draft" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!apiRes.ok) {
    const t = await apiRes.text().catch(() => "");
    console.error("[communicate] Anthropic non-ok", apiRes.status, t.slice(0, 200));
    return null;
  }
  const data = await apiRes.json();
  const tool = (data?.content || []).find((b) => b?.type === "tool_use");
  if (!tool) {
    console.error("[communicate] no tool_use in response, stop_reason:", data?.stop_reason);
    return null;
  }
  return tool.input;
}

// ---------- Branded HTML template (Resend) ----------

function brandedHtml(bodyText) {
  // Plain-text body → simple <p>-per-paragraph HTML. The visual
  // shell matches the rest of Conductor: dark bg, brass accents,
  // off-white text. Wide-supported web-safe stack since email
  // clients are unforgiving with system fonts.
  const paragraphs = String(bodyText || "")
    .split(/\n\s*\n/)
    .map((p) => `<p>${p.replace(/\n/g, "<br/>").replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`)
    .join("\n");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#0f0f0f;color:#f5f0eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;">
  <div style="max-width:560px;margin:0 auto;padding:40px 28px;">
    <div style="color:#b8960c;font-size:11px;letter-spacing:4px;font-weight:600;text-transform:uppercase;margin-bottom:10px;">CONDUCTOR</div>
    <hr style="border:0;height:1px;background:rgba(184,150,12,0.4);margin:0 0 28px;" />
    <div style="color:#f5f0eb;font-size:14px;line-height:1.7;">
      ${paragraphs}
    </div>
    <hr style="border:0;height:1px;background:rgba(255,255,255,0.06);margin:40px 0 14px;" />
    <div style="color:#5a5855;font-size:10px;letter-spacing:2px;">
      conductor — household intelligence
    </div>
    <div style="color:#5a5855;font-size:10px;margin-top:10px;">
      <a href="https://conductor-ivory.vercel.app/api/privacy" style="color:#5a5855;">Privacy</a>
      &nbsp;·&nbsp;
      <a href="mailto:support@conductor.app?subject=Unsubscribe" style="color:#5a5855;">Unsubscribe</a>
    </div>
  </div>
</body></html>`;
}

// ---------- Gmail send (user-from) ----------

// Build an RFC 2822 message and base64url-encode for Gmail's
// users.messages.send endpoint. The recipient sees "From: {user's
// Gmail address}" — no Conductor branding, just the household
// member's own email.
async function sendViaGmail({ userId, recipientEmail, subject, body, fromName }) {
  const accessToken = await getValidToken(userId);
  // Pull the user's Gmail address from their stored profile.
  let fromEmail = null;
  try {
    const profile = safeJson(await redis.get(`user:${userId}:profile`));
    fromEmail = profile?.email || null;
  } catch { /* skip */ }
  if (!fromEmail) return { ok: false, error: "no email on user profile" };

  const fromHeader = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  const raw = [
    `From: ${fromHeader}`,
    `To: ${recipientEmail}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    ``,
    body,
  ].join("\r\n");
  const base64url = Buffer.from(raw, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: base64url }),
    }
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    if (res.status === 403 || /insufficient.*scope/i.test(errText)) {
      return {
        ok: false,
        status: 403,
        error: "Gmail send permission not granted. Re-authenticate Conductor with the gmail.send scope to enable user-from sending.",
        detail: errText.slice(0, 200),
      };
    }
    return { ok: false, status: res.status, error: errText.slice(0, 200) };
  }
  const data = await res.json();
  return { ok: true, messageId: data.id, via: "gmail" };
}

// ---------- Resend send (branded) ----------

async function sendViaResend({ recipientEmail, subject, body }) {
  const client = getResend();
  if (!client) {
    return { ok: false, error: "resend not configured (set RESEND_API_KEY)" };
  }
  try {
    const result = await client.emails.send({
      from: "Conductor <hello@conductor.app>",
      to: recipientEmail,
      subject,
      html: brandedHtml(body),
      text: body,
    });
    return {
      ok: true,
      messageId: result?.data?.id || result?.id || null,
      via: "resend",
    };
  } catch (err) {
    return { ok: false, error: err?.message || "resend send failed" };
  }
}

// ---------- Persistence ----------

async function recordSent(householdId, payload) {
  const record = {
    ...payload,
    sentAt: new Date().toISOString(),
  };
  const key = `household:${householdId}:sentCommunications`;
  await redis.lpush(key, JSON.stringify(record));
  await redis.ltrim(key, 0, 199);
}

// ---------- Handler ----------

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const action = req.query?.action || req.body?.action;
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });

  if (action === "draft") {
    const { recipientName, recipientEmail, subject, context, communicationType } = req.body || {};
    let fromName = null;
    try {
      const profile = safeJson(await redis.get(`user:${userId}:profile`));
      if (profile?.name) fromName = profile.name.split(" ")[0];
    } catch { /* skip */ }
    const draft = await generateDraft({
      communicationType,
      recipientName,
      fromName,
      subject,
      context,
    });
    if (!draft) {
      return res.status(502).json({ error: "draft generation failed" });
    }
    return res.status(200).json({
      ok: true,
      subject: draft.subject,
      body: draft.body,
      recipientEmail: recipientEmail || null,
    });
  }

  if (action === "preview-html") {
    const { body } = req.body || {};
    return res.status(200).json({ html: brandedHtml(body || "") });
  }

  if (action === "send") {
    const {
      recipientEmail,
      subject,
      body,
      signalId,
      via,
    } = req.body || {};
    if (!recipientEmail) return res.status(400).json({ error: "recipientEmail required" });
    if (!subject) return res.status(400).json({ error: "subject required" });
    if (!body) return res.status(400).json({ error: "body required" });
    // User-initiated emails default to the member's own Gmail account; only
    // an explicit via:"resend" routes through the branded Conductor sender
    // (system mail). The mobile composer always sends `via` explicitly, so
    // this default only governs callers that omit it.
    const channel = via === "resend" ? "resend" : "gmail";

    let fromName = null;
    try {
      const profile = safeJson(await redis.get(`user:${userId}:profile`));
      if (profile?.name) fromName = profile.name.split(" ")[0];
    } catch { /* skip */ }

    let result;
    if (channel === "gmail") {
      result = await sendViaGmail({ userId, recipientEmail, subject, body, fromName });
    } else {
      result = await sendViaResend({ recipientEmail, subject, body });
    }

    if (result.ok) {
      const householdId = await resolveHouseholdId(userId);
      if (householdId) {
        await recordSent(householdId, {
          userId,
          recipientEmail,
          subject,
          via: channel,
          messageId: result.messageId || null,
          signalId: signalId ?? null,
        });
      }
      return res.status(200).json({ ok: true, ...result });
    }
    return res.status(result.status || 502).json({ ok: false, ...result });
  }

  return res.status(400).json({
    error: "Unknown action — use draft|send|preview-html",
  });
}
