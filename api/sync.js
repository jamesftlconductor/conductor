import { Redis } from "@upstash/redis";
import { runImport } from "./import.js";
import { runCalendarSync } from "./calendar.js";
import { runOuraSync } from "./oura-sync.js";

// Anticipated-signal generator. Reads household:{id}:patterns; for each
// pattern whose last signal is overdue by >20% of its interval, drops
// an "anticipated" signal into :signals so the brief can surface the
// missing recurring item softly. Idempotent — re-checks for existing
// anticipated entries before adding a new one.
async function generateAnticipatedSignals(redis, householdId) {
  const patternsRaw = await redis.hgetall(`household:${householdId}:patterns`);
  if (!patternsRaw || Object.keys(patternsRaw).length === 0) return 0;

  const signalsKey = `household:${householdId}:signals`;
  const rawSignals = await redis.lrange(signalsKey, 0, 199);
  const existingSignals = [];
  for (const r of rawSignals || []) {
    try { existingSignals.push(typeof r === "string" ? JSON.parse(r) : r); } catch { /* skip */ }
  }

  let created = 0;
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  for (const [patternKey, value] of Object.entries(patternsRaw)) {
    let pattern;
    try { pattern = typeof value === "string" ? JSON.parse(value) : value; } catch { continue; }
    if (!pattern || !pattern.sender || !pattern.type || !pattern.intervalDays) continue;
    const intervalMs = pattern.intervalDays * DAY_MS;
    const lastMs = pattern.lastSignalAt || 0;
    if (!lastMs) continue;
    const overdueBy = now - (lastMs + intervalMs);
    if (overdueBy < intervalMs * 0.2) continue;

    // Skip if there's already an anticipated signal for this pattern,
    // or a real signal arrived since the pattern was last updated.
    const alreadyAnticipated = existingSignals.some((s) =>
      s.anticipated === true && s.type === pattern.type &&
      typeof s.sender === "string" && s.sender.toLowerCase().trim() === pattern.senderKey
    );
    if (alreadyAnticipated) continue;
    const recentReal = existingSignals.some((s) =>
      !s.anticipated && s.type === pattern.type &&
      typeof s.sender === "string" && s.sender.toLowerCase().trim() === pattern.senderKey &&
      (s.id || 0) > lastMs
    );
    if (recentReal) continue;

    const desc = pattern.description
      ? `Expected: ${pattern.description} from ${pattern.sender}`
      : `Expected: ${pattern.sender} (${pattern.type})`;
    const expectedByDate = new Date(lastMs + intervalMs).toISOString();
    const signal = {
      id: now + created,
      description: desc,
      type: "anticipated",
      sender: pattern.sender,
      eta: expectedByDate,
      expectedByDate,
      state: "incoming",
      source: "anticipated",
      confidence: 6,
      anticipated: true,
      lastUpdate: new Date(now).toLocaleString(),
    };
    await redis.lpush(signalsKey, JSON.stringify(signal));
    created++;
    console.log(
      `[anticipated] ${householdId}: ${pattern.sender} (${pattern.type}) — overdue by ${Math.round(overdueBy / DAY_MS)}d`
    );
  }
  return created;
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function scanHouseholdKeys() {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, {
      match: "user:*:household",
      count: 100,
    });
    cursor = next;
    if (batch && batch.length) keys.push(...batch);
  } while (cursor !== "0" && cursor !== 0);
  return keys;
}

export default async function handler(req, res) {
  const errors = [];
  let signalsImported = 0;

  try {
    const keys = await scanHouseholdKeys();

    // Group members by householdId. Falls back to userId-as-household when the
    // stored value is empty, matching the convention used elsewhere in the API.
    const households = new Map();
    for (const key of keys) {
      const userId = key.slice("user:".length, -":household".length);
      let householdId;
      try {
        householdId = (await redis.get(key)) || userId;
      } catch (err) {
        errors.push({ stage: "resolve-household", userId, message: err.message });
        continue;
      }
      if (!households.has(householdId)) households.set(householdId, []);
      households.get(householdId).push(userId);
    }

    for (const [householdId, members] of households) {
      for (const userId of members) {
        try {
          const result = await runImport(userId);
          if (typeof result?.imported === "number") {
            signalsImported += result.imported;
          }
        } catch (err) {
          errors.push({ stage: "import", householdId, userId, message: err.message });
        }
      }

      // Multi-driver calendar sync — every member's tokens drive their
      // own runCalendarSync, writing to a per-user calendar key
      // (household:{id}:calendar:{userId}). The 23h cooldown is now
      // per-user, so each member's call independently skips or runs.
      // Consumers merge the per-user keys via api/calendar-loader.js.
      for (const userId of members) {
        try {
          await runCalendarSync(userId);
        } catch (err) {
          errors.push({ stage: "calendar", householdId, userId, message: err.message });
        }
      }

      // Per-member Oura sync — only fires for users who have completed
      // the OAuth flow (user:{id}:ouraTokens exists). runOuraSync is
      // best-effort: token expiry triggers a refresh, individual
      // endpoint failures (ring out of sync, network blip) leave the
      // corresponding section null in the merged health snapshot.
      for (const userId of members) {
        try {
          const hasTokens = await redis.exists(`user:${userId}:ouraTokens`);
          if (!hasTokens) continue;
          await runOuraSync(userId);
        } catch (err) {
          errors.push({ stage: "oura", householdId, userId, message: err.message });
        }
      }

      // Anticipated-signal generation — reads :patterns built by
      // import.js's detectAndStampRecurring and adds a soft
      // "anticipated" signal when a recurring sender is overdue.
      try {
        await generateAnticipatedSignals(redis, householdId);
      } catch (err) {
        errors.push({ stage: "anticipated", householdId, message: err.message });
      }

      try {
        await redis.set(`household:${householdId}:lastSync`, Date.now());
      } catch (err) {
        errors.push({ stage: "stamp-lastSync", householdId, message: err.message });
      }
    }

    return res.status(200).json({
      "householdsSync'd": households.size,
      signalsImported,
      errors,
    });
  } catch (error) {
    console.error("Sync error:", error);
    return res.status(500).json({
      error: "Sync failed",
      message: error.message,
      "householdsSync'd": 0,
      signalsImported,
      errors,
    });
  }
}
