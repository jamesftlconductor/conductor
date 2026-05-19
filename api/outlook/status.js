// Connection probe for the mobile Settings screen. Polled via
// useFocusEffect — same pattern as the Oura connection row.
//
// Returns { connected, email, displayName, connectedAt } when tokens
// exist; { connected: false } when none stored. Never errors on
// missing tokens — that's an expected state, not a fault.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    const raw = await redis.get(`user:${userId}:outlookTokens`);
    if (!raw) return res.status(200).json({ connected: false });
    const t = typeof raw === "string" ? JSON.parse(raw) : raw;
    return res.status(200).json({
      connected: !!t.accessToken,
      email: t.email || null,
      displayName: t.displayName || null,
      connectedAt: t.connectedAt || null,
    });
  } catch (err) {
    console.error("Outlook status error:", err);
    return res.status(500).json({ error: "status check failed" });
  }
}
