// Deletes the user's Outlook tokens. No Microsoft-side revoke call —
// Microsoft expires unused refresh tokens automatically (~90d), and
// removing the local copy is what flips the Settings row back to
// "Connect Outlook".
//
// Idempotent: a missing-tokens DEL is a no-op success.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    await redis.del(`user:${userId}:outlookTokens`);
    // Also drop the lastOutlookSync stamp so a subsequent reconnect
    // starts a fresh window rather than picking up where the previous
    // connection left off.
    await redis.del(`user:${userId}:outlookLastSync`);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Outlook disconnect error:", err);
    return res.status(500).json({ error: "disconnect failed" });
  }
}
