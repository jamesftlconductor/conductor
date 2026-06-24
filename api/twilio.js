// Twilio SMS integration. Two surfaces in one file:
//
//   POST /api/twilio?action=inbound  (Twilio webhook target)
//   POST /api/twilio?action=draftMessage  (mobile composer helper)
//
// sendSMS / storePendingAction are exported for /api/notify to call
// when the user fires off a Network/Crew SMS update.
//
// Required env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
// TWILIO_PHONE_NUMBER. Without all three present, sendSMS returns
// { ok: false, error: 'twilio not configured' } and the rest of the
// system continues without SMS delivery.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// SMS is sent via Twilio's REST API directly over fetch rather than the
// `twilio` SDK. This file is ESM; the SDK's lazy `require("twilio")` was
// throwing in the deployed (ESM) function, which surfaced as the misleading
// "twilio not configured" (getTwilioClient → null) even with valid creds.
// fetch + HTTP Basic auth has no such dependency-resolution surface area.
const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

function twilioAuthHeader() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) return null;
  return "Basic " + Buffer.from(`${sid}:${tok}`).toString("base64");
}

// Twilio requires the From number in E.164 (leading +). The stored env value
// may omit it (e.g. "17547143734"); normalize so sends don't 21212-fail.
function toE164(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.startsWith("+")) return "+" + s.slice(1).replace(/[^0-9]/g, "");
  return "+" + s.replace(/[^0-9]/g, "");
}

function safeJson(v) {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
}

async function resolveHouseholdId(userId) {
  if (!userId) return null;
  const hid = await redis.get(`user:${userId}:household`);
  return hid || userId;
}

// Normalize a phone number for storage / lookup. Drop everything
// except digits + leading +. We don't enforce E.164 because Twilio
// will reject malformed numbers at send time; better to accept
// what the user typed and let Twilio surface the error.
function normalizePhone(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.startsWith("+")) return "+" + s.slice(1).replace(/[^0-9]/g, "");
  return s.replace(/[^0-9]/g, "");
}

// ---------- exports for other handlers ----------

export async function sendSMS(to, body, context = {}) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = twilioAuthHeader();
  const fromNumber = toE164(process.env.TWILIO_PHONE_NUMBER);
  if (!sid || !auth || !fromNumber) {
    return { ok: false, error: "twilio not configured" };
  }
  const normalizedTo = normalizePhone(to);
  if (!normalizedTo) return { ok: false, error: "invalid phone number" };

  // Honor STOP opt-outs. Stored as a SET keyed by phone number.
  try {
    const optedOut = await redis.sismember("sms:optOuts", normalizedTo);
    if (optedOut) return { ok: false, error: "recipient opted out" };
  } catch {
    // best-effort — proceed with send
  }

  const message = String(body || "").slice(0, 320); // 2-segment cap
  try {
    const form = new URLSearchParams({
      To: normalizedTo,
      From: fromNumber,
      Body: message,
    });
    const r = await fetch(`${TWILIO_API_BASE}/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Surface Twilio's structured error verbatim — e.g. code 21608 on a
      // trial account sending to an unverified number.
      console.error(
        `[twilio] send failed ${r.status} code=${data?.code} ${data?.message}`
      );
      return {
        ok: false,
        error: data?.message || "twilio send failed",
        code: data?.code || null,
        moreInfo: data?.more_info || null,
        httpStatus: r.status,
      };
    }
    console.log(
      `[twilio] SMS ${data.sid} → ${normalizedTo} status ${data.status} (household ${context.householdId || "unknown"})`
    );
    return { ok: true, sid: data.sid, status: data.status };
  } catch (err) {
    console.error("[twilio] send failed:", err?.message || err);
    return { ok: false, error: err?.message || "twilio send failed" };
  }
}

// Persist a pending action so an inbound reply can route back to
// the right signal. 48h TTL — beyond that the user should re-send
// rather than have a stale action fire on a year-old reply.
export async function storePendingAction(phone, payload) {
  const normalized = normalizePhone(phone);
  if (!normalized) return;
  const record = {
    ...payload,
    sentAt: new Date().toISOString(),
    phone: normalized,
  };
  await redis.set(`sms:pending:${normalized}`, JSON.stringify(record), {
    ex: 48 * 60 * 60,
  });
}

// Generate a draft SMS for a given signal + recipient. Used by the
// mobile composer to pre-fill the editable message field.
async function draftMessage(signal, recipientName, fromName) {
  const prompt = `Write a brief SMS update about this household signal for ${recipientName || "a recipient"}. Maximum 140 characters. Include:
- What the signal is about
- What action is needed (if any)
- A reply keyword the recipient can use (DONE / YES / NO) if a response is expected
- Sign with: — Conductor for ${fromName || "the household"}

Signal:
- Type: ${signal.type || "unknown"}
- Description: ${signal.description || "(no description)"}
- ETA: ${signal.eta || "no date"}
- Sender: ${signal.sender || "n/a"}
- Status: ${signal.status || "n/a"}

Return only the message text — no quotes, no preface, no markdown.`;

  try {
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!apiRes.ok) return null;
    const data = await apiRes.json();
    const text = data?.content?.[0]?.text?.trim();
    return text || null;
  } catch (err) {
    console.warn("[twilio] draft failed:", err?.message || err);
    return null;
  }
}

// ---------- inbound webhook ----------

async function handleInbound(req, res) {
  // Twilio posts form-encoded — Vercel parses to req.body for
  // application/x-www-form-urlencoded as an object.
  const from = req.body?.From || req.body?.from;
  const body = (req.body?.Body || req.body?.body || "").trim();
  if (!from || !body) {
    // Twilio expects a 200 even on validation problems; an empty
    // TwiML response keeps the line quiet.
    res.setHeader("Content-Type", "text/xml");
    return res.status(200).send("<Response></Response>");
  }

  const fromPhone = normalizePhone(from);
  const upper = body.toUpperCase();
  const keyword = ["DONE", "YES", "NO", "CONFIRM", "CANCEL", "STOP"]
    .find((k) => upper.startsWith(k));

  // STOP is universal — opt out and reply per the carrier rules,
  // no further action lookup needed.
  if (keyword === "STOP") {
    try {
      await redis.sadd("sms:optOuts", fromPhone);
    } catch { /* best-effort */ }
    res.setHeader("Content-Type", "text/xml");
    return res.status(200).send(
      `<Response><Message>You've been unsubscribed from Conductor messages.</Message></Response>`
    );
  }

  // Look up the pending action for this phone.
  const pending = safeJson(await redis.get(`sms:pending:${fromPhone}`));
  if (!pending || !pending.signalId) {
    res.setHeader("Content-Type", "text/xml");
    return res.status(200).send(
      `<Response><Message>Conductor didn't have a pending action for this number. No changes made.</Message></Response>`
    );
  }

  // Map keyword → PATCH state on the signal.
  const householdId = pending.householdId;
  const userId = pending.userId;
  let stateUpdate = null;
  let confirmReply = "Got it — Conductor noted your reply.";
  if (keyword === "DONE") {
    stateUpdate = "resolved";
    confirmReply = "Got it — marked as done. ✓";
  } else if (keyword === "YES" || keyword === "CONFIRM") {
    confirmReply = "Confirmed — Conductor will hold for next steps.";
  } else if (keyword === "NO" || keyword === "CANCEL") {
    confirmReply = "Noted — Conductor will follow up differently.";
  }

  // Update the signal record. We do the LSET inline rather than
  // calling /api/signals to keep the inbound webhook self-contained
  // (Twilio retries on 5xx).
  try {
    const sigKey = `household:${householdId}:signals`;
    const rawSignals = await redis.lrange(sigKey, 0, -1);
    for (let i = 0; i < rawSignals.length; i++) {
      const s = safeJson(rawSignals[i]);
      if (!s) continue;
      if (s.id === pending.signalId || String(s.id) === String(pending.signalId)) {
        if (stateUpdate) s.state = stateUpdate;
        s.smsReplyAt = new Date().toISOString();
        s.smsReplyKeyword = keyword || body.slice(0, 40);
        s.lastUpdate = new Date().toLocaleString();
        await redis.lset(sigKey, i, JSON.stringify(s));
        break;
      }
    }
  } catch (err) {
    console.error("[twilio inbound] signal update failed:", err?.message || err);
  }

  // Consume the pending action — single-use to prevent late-fire
  // replies from re-triggering the same signal change.
  try { await redis.del(`sms:pending:${fromPhone}`); } catch { /* ignore */ }

  console.log(
    `[twilio inbound] ${fromPhone} → ${keyword || "freeform"} on signal ${pending.signalId}`
  );

  res.setHeader("Content-Type", "text/xml");
  return res.status(200).send(`<Response><Message>${confirmReply}</Message></Response>`);
}

// ---------- handler ----------

export default async function handler(req, res) {
  const action = req.query?.action || req.body?.action;

  if (action === "inbound") return handleInbound(req, res);

  // Diagnostic — reports whether the TWILIO_* env vars are actually visible
  // to the running deployment and, if so, the Twilio account type ("Trial"
  // vs "Full") + status. Trial accounts can only send to verified numbers.
  // GET-friendly so it can be hit from a browser/curl without a body.
  if (action === "accountStatus") {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const tok = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER || null;
    const configured = { hasSid: !!sid, hasToken: !!tok, hasFromNumber: !!fromNumber };
    if (!sid || !tok) {
      return res.status(200).json({
        ok: false,
        configured,
        error: "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not visible to this deployment",
      });
    }
    try {
      const auth = Buffer.from(`${sid}:${tok}`).toString("base64");
      const r = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}.json`,
        { headers: { Authorization: `Basic ${auth}` } }
      );
      const data = await r.json();
      if (!r.ok) {
        return res.status(200).json({
          ok: false,
          configured,
          httpStatus: r.status,
          error: data?.message || "twilio account lookup failed",
          code: data?.code || null,
        });
      }
      return res.status(200).json({
        ok: true,
        configured,
        account: {
          type: data.type, // "Trial" or "Full"
          status: data.status, // "active", etc.
          friendlyName: data.friendly_name || null,
          fromNumber,
        },
      });
    } catch (err) {
      return res.status(200).json({
        ok: false,
        configured,
        error: err?.message || "twilio account lookup failed",
      });
    }
  }

  // Delivery confirmation — GET ?action=messageStatus&sid=SM... returns the
  // live status of a previously-sent message (queued → sending → sent →
  // delivered, or undelivered/failed with an errorCode). GET-friendly.
  if (action === "messageStatus") {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const auth = twilioAuthHeader();
    const messageSid = req.query?.sid || req.body?.sid;
    if (!accountSid || !auth) {
      return res.status(200).json({ ok: false, error: "twilio not configured" });
    }
    if (!messageSid) return res.status(400).json({ error: "sid required" });
    try {
      const r = await fetch(
        `${TWILIO_API_BASE}/Accounts/${accountSid}/Messages/${messageSid}.json`,
        { headers: { Authorization: auth } }
      );
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        return res.status(200).json({
          ok: false,
          httpStatus: r.status,
          error: data?.message || "message lookup failed",
          code: data?.code || null,
        });
      }
      return res.status(200).json({
        ok: true,
        message: {
          sid: data.sid,
          status: data.status,
          to: data.to,
          from: data.from,
          errorCode: data.error_code || null,
          errorMessage: data.error_message || null,
          dateSent: data.date_sent || null,
          price: data.price || null,
          priceUnit: data.price_unit || null,
        },
      });
    } catch (err) {
      return res.status(200).json({
        ok: false,
        error: err?.message || "message lookup failed",
      });
    }
  }

  if (action === "draftMessage") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }
    const { userId, signalId, recipientName } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId required" });
    if (signalId == null) return res.status(400).json({ error: "signalId required" });
    const householdId = await resolveHouseholdId(userId);
    if (!householdId) return res.status(400).json({ error: "no household" });
    const rawSignals = await redis.lrange(`household:${householdId}:signals`, 0, -1);
    let signal = null;
    for (const r of rawSignals || []) {
      const s = safeJson(r);
      if (s && (s.id === signalId || String(s.id) === String(signalId))) { signal = s; break; }
    }
    if (!signal) return res.status(404).json({ error: "signal not found" });

    // Resolve the requesting user's first name for the signature line.
    let fromName = "the household";
    try {
      const profileRaw = await redis.get(`user:${userId}:profile`);
      const profile = safeJson(profileRaw);
      if (profile?.name) fromName = profile.name.split(" ")[0];
    } catch { /* skip */ }

    const text = await draftMessage(signal, recipientName, fromName);
    return res.status(200).json({
      ok: true,
      draft: text || `Update: ${signal.description || "household signal"}. Reply DONE when handled. — Conductor for ${fromName}`,
    });
  }

  if (action === "send") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }
    const { userId, to, body, signalId, expectReply } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId required" });
    if (!to) return res.status(400).json({ error: "to required" });
    if (!body) return res.status(400).json({ error: "body required" });
    const householdId = await resolveHouseholdId(userId);
    const result = await sendSMS(to, body, { householdId });
    if (result.ok && signalId != null && expectReply) {
      await storePendingAction(to, { signalId, householdId, userId, action: "reply" });
    }
    return res.status(result.ok ? 200 : 502).json(result);
  }

  return res.status(400).json({
    error: "Unknown action — use ?action=inbound|draftMessage|send",
  });
}
