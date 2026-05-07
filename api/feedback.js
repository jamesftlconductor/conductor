import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const FEEDBACK_TRIM_TO = 200;
const VALID_BRIEF_TYPES = new Set(["takeoff", "clearance"]);
const VALID_RATINGS = new Set(["up", "down"]);

async function resolveHouseholdId(userId) {
  if (!userId) return "RangerOaks925";
  const hid = await redis.get(`user:${userId}:household`);
  return hid || "RangerOaks925";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { userId, briefType, rating, briefDate } = req.body || {};

  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ error: "Missing or invalid userId" });
  }
  if (!VALID_BRIEF_TYPES.has(briefType)) {
    return res.status(400).json({ error: "briefType must be takeoff or clearance" });
  }
  if (!VALID_RATINGS.has(rating)) {
    return res.status(400).json({ error: "rating must be up or down" });
  }

  try {
    const householdId = await resolveHouseholdId(userId);
    const listKey = `household:${householdId}:feedback`;
    const statsKey = `household:${householdId}:feedbackStats`;
    // Stat field maps {takeoff,clearance} × {up,down} to four counters that
    // brief.js / clearance.js read on every generation to tune voice.
    const statField = `${briefType}_${rating}`;

    const entry = {
      userId,
      briefType,
      rating,
      briefDate: typeof briefDate === "string" ? briefDate : null,
      receivedAt: new Date().toISOString(),
    };

    await redis.lpush(listKey, JSON.stringify(entry));
    await redis.ltrim(listKey, 0, FEEDBACK_TRIM_TO - 1);
    await redis.hincrby(statsKey, statField, 1);

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Feedback error:", error);
    return res.status(500).json({ error: "Feedback storage failed" });
  }
}
