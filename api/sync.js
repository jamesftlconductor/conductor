import { Redis } from "@upstash/redis";
import { runImport } from "./import.js";
import { runCalendarSync } from "./calendar.js";
import { runOuraSync } from "./oura-sync.js";

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
