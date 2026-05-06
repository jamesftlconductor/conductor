import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const HOUR_MS = 60 * 60 * 1000;

function safeJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

async function listHouseholds() {
  // Mirrors sync.js: derive membership from user:*:household keys, since
  // household:{id}:members is not maintained anywhere in the codebase.
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

async function generateSummary(householdId, type) {
  const fallback = type === "takeoff"
    ? "Your morning brief is ready."
    : "Your evening brief is ready.";

  try {
    const [rawSignals, rawCalendar] = await Promise.all([
      redis.lrange(`household:${householdId}:signals`, 0, -1),
      redis.get(`household:${householdId}:calendar`),
    ]);

    const signals = (rawSignals || [])
      .map(safeJson)
      .filter(Boolean)
      .filter(s => !s.state || s.state === "incoming" || s.state === "active");

    const calendar = Array.isArray(safeJson(rawCalendar)) ? safeJson(rawCalendar) : [];

    const topSignals = signals.slice(0, 10).map(s =>
      `- ${s.description || "Unknown"} | status:${s.status || "?"} | eta:${s.eta || "?"}`
    ).join("\n");

    const now = Date.now();
    const upcomingEvents = calendar
      .filter(e => {
        const t = Date.parse(e.start);
        return !isNaN(t) && t >= now - HOUR_MS && t <= now + 24 * HOUR_MS;
      })
      .slice(0, 5)
      .map(e => `- ${e.title || "Untitled"} | ${e.start}`)
      .join("\n");

    const orientation = type === "takeoff"
      ? "Morning push: forward-looking, what to know for today."
      : "Evening push: wrap-up, what landed today and what's tomorrow.";

    const prompt = `Write a single-sentence push notification body for Conductor (a household assistant).
${orientation}
Maximum 100 characters. Calm, specific, never a list. No quotes, no preamble.

Active signals:
${topSignals || "None"}

Next 24 hours of events:
${upcomingEvents || "None"}

Return only the sentence.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
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

    const data = await response.json();
    let text = data?.content?.[0]?.text?.trim() || fallback;
    text = text.replace(/^["']+|["']+$/g, "").trim();
    if (text.length > 100) text = text.slice(0, 97) + "...";
    return text;
  } catch (err) {
    console.error("Summary generation failed:", err);
    return fallback;
  }
}

async function sendExpoPush(token, title, body) {
  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Accept-Encoding": "gzip, deflate",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to: token, title, body, sound: "default" }),
  });
  const data = await response.json().catch(() => ({}));
  // Expo always 200s on a well-formed request; per-message success lives in
  // data.data.status — "ok" or "error" (with details.error like DeviceNotRegistered).
  const ticket = data?.data;
  const delivered = response.ok && ticket?.status === "ok";
  return { ok: delivered, status: response.status, data };
}

export default async function handler(req, res) {
  const type = req.query?.type || req.body?.type;
  const householdIdInput = req.query?.householdId || req.body?.householdId;

  if (type !== "takeoff" && type !== "clearance") {
    return res.status(400).json({ error: "type must be 'takeoff' or 'clearance'" });
  }

  const title = type === "takeoff" ? "Takeoff" : "Clearance";

  try {
    const allHouseholds = await listHouseholds();
    let targets;
    if (householdIdInput) {
      const members = allHouseholds.get(householdIdInput) || [];
      targets = new Map([[householdIdInput, members]]);
    } else {
      targets = allHouseholds;
    }

    const results = [];
    let sent = 0;

    for (const [hid, members] of targets) {
      const tokensByUser = [];
      for (const userId of members) {
        const token = await redis.get(`user:${userId}:expoPushToken`);
        if (typeof token === "string" && token.length) {
          tokensByUser.push({ userId, token });
        }
      }

      if (tokensByUser.length === 0) {
        results.push({ household: hid, skipped: "no tokens", members: members.length });
        continue;
      }

      let body = await generateSummary(hid, type);

      // Carry-forward suffix on Takeoff only — if anything was flagged in last
      // night's LAST CHANCE pool and is still active this morning (the morning
      // brief stamps it on the carriedForward set), nudge the user.
      if (type === "takeoff") {
        const carriedCount = await redis.scard(`household:${hid}:carriedForward`);
        if (carriedCount > 0) {
          const suffix = " Something from yesterday is still open.";
          // Reserve room for the suffix; total stays ≤100 chars. If the base
          // body alone barely fits, trim it before appending so the suffix
          // isn't itself truncated mid-sentence.
          const budget = 100 - suffix.length;
          if (body.length > budget) {
            body = body.slice(0, Math.max(0, budget - 3)).trimEnd() + "...";
          }
          body = body + suffix;
        }
      }

      for (const { userId, token } of tokensByUser) {
        const push = await sendExpoPush(token, title, body);
        if (push.ok) {
          await redis.set(`user:${userId}:lastNotification`, Date.now());
          sent++;
        }
        results.push({
          household: hid,
          userId,
          ok: push.ok,
          status: push.status,
          body,
          expo: push.data,
        });
      }
    }

    return res.status(200).json({ type, sent, householdsTargeted: targets.size, results });
  } catch (error) {
    console.error("Notify error:", error);
    return res.status(500).json({ error: "Notify failed", message: error.message });
  }
}
