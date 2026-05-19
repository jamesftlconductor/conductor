// Delete the user's Nextdoor tokens + the per-user lastScan marker
// so a reconnect starts a fresh window. Idempotent.
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    await redis.del(`user:${userId}:nextdoorTokens`);
    await redis.del(`user:${userId}:nextdoorLastScan`);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Nextdoor disconnect error:", err);
    return res.status(500).json({ error: "disconnect failed" });
  }
}
