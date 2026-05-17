// Hourly follow-up notifications for signals whose ETA passed 1-3 hours
// ago without the user resting or holding them. signals.js queues
// eligible IDs into household:{id}:pendingFollowups at brief/mobile read
// time; this cron consumes the queue, generates a one-sentence check-in
// per signal via Claude Haiku, sends a push, and removes the entry.
//
// Cron: "0 * * * *" → /api/followup (every hour, top of the hour)

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export const config = { maxDuration: 60 };

// Same household enumeration trick notify.js + sync.js use: SCAN every
// user:*:household pointer and group by the household ID those pointers
// resolve to. The :members set isn't reliable for this.
async function listHouseholds() {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, { match: "user:*:household", count: 100 });
    cursor = next;
    if (batch?.length) keys.push(...batch);
  } while (cursor !== "0" && cursor !== 0);

  const map = new Map();
  for (const key of keys) {
    const userId = key.slice("user:".length, -":household".length);
    const hid = (await redis.get(key)) || userId;
    if (!map.has(hid)) map.set(hid, []);
    map.get(hid).push(userId);
  }
  return map;
}

async function sendExpoPush(token, title, body, extras = {}) {
  // extras may carry { categoryId, data } so iOS shows the
  // SIGNAL_FOLLOWUP action buttons (Done ✓ / Still open) and the
  // mobile response listener can route the tap to PATCH the signal.
  const payload = { to: token, title, body, sound: "default" };
  if (extras.categoryId) payload.categoryId = extras.categoryId;
  if (extras.data && typeof extras.data === "object") payload.data = extras.data;
  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  const ticket = data?.data;
  const delivered = response.ok && ticket?.status === "ok";
  return { ok: delivered, status: response.status, data };
}

async function generateFollowUpSentence(signal) {
  const desc = signal.description || "Unknown signal";
  const sender = signal.sender || "Unknown";
  const eta = signal.eta || "Unknown";
  const prompt = `Write one sentence checking in on this signal: ${desc} from ${sender}. ETA was ${eta}. Did it happen? Suggest either Rest (it's done) or Hold (still pending). Maximum 15 words.`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 80,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("[followup] Anthropic error", res.status, errText.slice(0, 200));
      return `Did the ${desc} arrive? Rest or Hold?`;
    }
    const data = await res.json();
    const text = data?.content?.[0]?.text?.trim();
    if (!text) return `Did the ${desc} arrive? Rest or Hold?`;
    // Strip wrapping quotes Claude sometimes adds despite the "one sentence" framing.
    return text.replace(/^["'""]+|["'""]+$/g, "").trim();
  } catch (err) {
    console.error("Follow-up generation failed:", err?.message || err);
    return `Did the ${desc} arrive? Rest or Hold?`;
  }
}

export default async function handler(req, res) {
  try {
    const householdsMap = await listHouseholds();
    const results = [];
    let sent = 0;

    for (const [hid, members] of householdsMap) {
      const pendingIds = await redis.smembers(`household:${hid}:pendingFollowups`);
      if (!pendingIds || pendingIds.length === 0) continue;

      // Build a signalId → record map once per household so we can look
      // up each pending ID without an O(n*m) re-scan.
      const rawSignals = await redis.lrange(`household:${hid}:signals`, 0, -1);
      const signalMap = new Map();
      for (const r of rawSignals) {
        try {
          const s = JSON.parse(r);
          signalMap.set(String(s.id), s);
        } catch { /* skip malformed */ }
      }

      // Collect every push token owned by household members. Follow-ups
      // go to everyone in the household — a signal that needs checking
      // is shared visibility regardless of which member imported it.
      const tokens = [];
      for (const userId of members) {
        const t = await redis.get(`user:${userId}:expoPushToken`);
        if (typeof t === "string" && t.length > 0) {
          tokens.push({ userId, token: t });
        }
      }

      for (const sigId of pendingIds) {
        const signal = signalMap.get(String(sigId));
        // Signal vanished from the list — drop the queue entry.
        if (!signal) {
          await redis.srem(`household:${hid}:pendingFollowups`, sigId);
          results.push({ household: hid, signalId: sigId, skipped: "signal not found" });
          continue;
        }
        // Resolved or expired between queueing and now — drop.
        if (signal.state === "resolved" || signal.state === "expired") {
          await redis.srem(`household:${hid}:pendingFollowups`, sigId);
          results.push({ household: hid, signalId: sigId, skipped: `state=${signal.state}` });
          continue;
        }
        // No tokens — drop the queue entry rather than retry forever.
        if (tokens.length === 0) {
          await redis.srem(`household:${hid}:pendingFollowups`, sigId);
          results.push({ household: hid, signalId: sigId, skipped: "no tokens" });
          continue;
        }

        const body = await generateFollowUpSentence(signal);
        for (const { userId, token } of tokens) {
          const push = await sendExpoPush(token, "Quick check", body, {
            categoryId: "SIGNAL_FOLLOWUP",
            data: {
              type: "followup",
              signalId: signal.id,
              householdId: hid,
              userId,
            },
          });
          if (push.ok) {
            sent++;
            await redis.set(`user:${userId}:lastNotification`, Date.now());
          }
          results.push({
            household: hid,
            signalId: sigId,
            userId,
            ok: push.ok,
            status: push.status,
            body,
          });
        }
        // Always remove from queue after attempting send — even on push
        // failure. We'd rather miss a follow-up than spam the user on
        // every hourly run with the same checkin.
        await redis.srem(`household:${hid}:pendingFollowups`, sigId);
      }
    }

    return res.status(200).json({ sent, householdsScanned: householdsMap.size, results });
  } catch (error) {
    console.error("Followup error:", error);
    return res.status(500).json({ error: "Followup failed", message: error.message });
  }
}
