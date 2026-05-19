// Nextdoor connection probe for the mobile Settings screen. Returns
// the neighborhood label so the row can render "✓ Nextdoor —
// {neighborhood name}" once connected.
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    const raw = await redis.get(`user:${userId}:nextdoorTokens`);
    if (!raw) return res.status(200).json({ connected: false });
    const t = typeof raw === "string" ? JSON.parse(raw) : raw;
    return res.status(200).json({
      connected: !!t.accessToken,
      neighborhood: t.neighborhood || null,
      connectedAt: t.connectedAt || null,
    });
  } catch (err) {
    console.error("Nextdoor status error:", err);
    return res.status(500).json({ error: "status check failed" });
  }
}
