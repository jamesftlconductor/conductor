import { Redis } from "@upstash/redis";
import { runImport } from "./import.js";
import { runCalendarSync } from "./calendar.js";

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

      // runCalendarSync skips internally if the household synced in the last 23h.
      // Use the first member's tokens to drive the sync (calendar is per-household).
      const driver = members[0];
      try {
        await runCalendarSync(driver);
      } catch (err) {
        errors.push({ stage: "calendar", householdId, userId: driver, message: err.message });
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
