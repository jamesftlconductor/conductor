import { Redis } from "@upstash/redis";
import { getValidToken } from "./refresh.js";

// Gmail push receiver — the HTTP endpoint a Google Cloud Pub/Sub push
// subscription POSTs to whenever a watched inbox changes. The notification
// carries only { emailAddress, historyId }; we resolve the user, walk the
// Gmail history since our last cursor to confirm new mail arrived (and log
// it), advance the cursor, then trigger the normal import pipeline so the
// new messages run through the exact same classification + dedup path as the
// hourly sync. Net effect: a signal appears within seconds of the email
// landing instead of waiting for the next cron tick.

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const BASE_URL = "https://conductor-ivory.vercel.app";

// Pub/Sub wraps the payload as { message: { data: base64(JSON) }, ... }.
// Returns { emailAddress, historyId } or null when the envelope is malformed.
function decodeNotification(body) {
  try {
    const data = body?.message?.data;
    if (!data) return null;
    const json = Buffer.from(data, "base64").toString("utf-8");
    const parsed = JSON.parse(json);
    if (!parsed?.emailAddress) return null;
    return { emailAddress: parsed.emailAddress, historyId: parsed.historyId ? String(parsed.historyId) : null };
  } catch {
    return null;
  }
}

// emailAddress → userId. Prefer the reverse map written at watch setup;
// fall back to the deterministic transform api/callback.js uses.
async function resolveUserId(emailAddress) {
  try {
    const mapped = await redis.get(`gmail:address:${emailAddress.toLowerCase()}:userId`);
    if (mapped) return typeof mapped === "string" ? mapped : String(mapped);
  } catch {
    /* fall through */
  }
  return emailAddress.replace(/[@.]/g, "_");
}

// Walk Gmail history since startHistoryId, collecting added message ids.
// Best-effort and bounded — used for logging + to know whether to bother
// importing; the import sweep itself is what actually parses the mail.
async function collectAddedMessageIds(accessToken, startHistoryId) {
  const ids = new Set();
  let pageToken = null;
  let pages = 0;
  do {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
    url.searchParams.set("startHistoryId", startHistoryId);
    url.searchParams.set("historyTypes", "messageAdded");
    url.searchParams.set("labelId", "INBOX");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const resp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) {
      // 404 = historyId too old / expired; caller will fall back to a sweep.
      return { ids: [...ids], stale: resp.status === 404 };
    }
    const data = await resp.json().catch(() => ({}));
    for (const h of data.history || []) {
      for (const m of h.messagesAdded || []) {
        if (m?.message?.id) ids.add(m.message.id);
      }
    }
    pageToken = data.nextPageToken || null;
    pages += 1;
  } while (pageToken && pages < 10);
  return { ids: [...ids], stale: false };
}

export default async function handler(req, res) {
  // Pub/Sub only ever POSTs. Always ACK (200) on anything we can't act on so
  // Pub/Sub doesn't enter a redelivery loop over a permanent condition.
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Optional shared-secret gate — set GMAIL_PUSH_SECRET and configure the
  // subscription's push endpoint with ?token=... to reject spoofed posts.
  const secret = process.env.GMAIL_PUSH_SECRET;
  if (secret && req.query?.token !== secret) {
    console.warn("[gmail-push] rejected: bad/missing token");
    return res.status(204).end();
  }

  const note = decodeNotification(req.body);
  if (!note) {
    console.warn("[gmail-push] undecodable notification; acking");
    return res.status(204).end();
  }

  try {
    const userId = await resolveUserId(note.emailAddress);

    // Respect the real-time toggle (Settings → What Conductor Sees). Default
    // ON — only an explicit false disables push-driven imports.
    try {
      const prefsRaw = await redis.get(`user:${userId}:preferences`);
      const prefs = typeof prefsRaw === "string" ? JSON.parse(prefsRaw) : prefsRaw;
      if (prefs && prefs.realtimeEmail === false) {
        console.log(`[gmail-push] real-time disabled for ${userId}; acking`);
        return res.status(204).end();
      }
    } catch {
      /* preference read failure shouldn't block real-time import */
    }

    // Cursor walk — log what arrived and detect a stale cursor.
    let added = [];
    const startHistoryId = await redis.get(`user:${userId}:gmailHistoryId`);
    if (startHistoryId) {
      try {
        const token = await getValidToken(userId);
        const walk = await collectAddedMessageIds(token, String(startHistoryId));
        added = walk.ids;
        if (walk.stale) console.log(`[gmail-push] ${userId}: history cursor stale, falling back to full sweep`);
      } catch (err) {
        console.warn(`[gmail-push] history walk failed for ${userId}:`, err?.message || err);
      }
    }

    // Advance the cursor to the notification's historyId so the next push
    // walks only from here forward.
    if (note.historyId) {
      await redis.set(`user:${userId}:gmailHistoryId`, note.historyId);
    }

    // Trigger the real import. Fire-and-forget to /api/import so we ACK the
    // Pub/Sub push immediately (the function returns before the import work,
    // matching the onboard-trigger pattern in callback.js) — the import runs
    // the new INBOX mail through the same label-gated, dedup-guarded pipeline.
    fetch(`${BASE_URL}/api/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    }).catch((err) => console.error("[gmail-push] import trigger failed:", err?.message || err));

    console.log(`[gmail-push] ${userId}: ${added.length} new inbox message(s), import triggered`);
    return res.status(200).json({ ok: true, userId, newMessages: added.length });
  } catch (error) {
    // Still ACK so Pub/Sub doesn't hammer us; the next sync cron is the
    // safety net for anything missed here.
    console.error("[gmail-push] handler error:", error?.message || error);
    return res.status(204).end();
  }
}
