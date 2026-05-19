// Delete the user's Ring tokens. Idempotent.
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    await redis.del(`user:${userId}:ringTokens`);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Ring disconnect error:", err);
    return res.status(500).json({ error: "disconnect failed" });
  }
}
