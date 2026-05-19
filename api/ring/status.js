// Ring connection probe for the mobile Settings screen.
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    const raw = await redis.get(`user:${userId}:ringTokens`);
    if (!raw) return res.status(200).json({ connected: false });
    const t = typeof raw === "string" ? JSON.parse(raw) : raw;
    return res.status(200).json({
      connected: !!t.accessToken,
      connectedAt: t.connectedAt || null,
    });
  } catch (err) {
    console.error("Ring status error:", err);
    return res.status(500).json({ error: "status check failed" });
  }
}
