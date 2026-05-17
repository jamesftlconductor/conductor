// API key management for the inbound /api/ingest endpoint. One key per
// household, idempotent on regeneration (subsequent GETs return the
// same key, not a fresh one — flip to POST when rotation is needed).
//
// GET /api/ingest/key?userId={userId}
//   → returns { apiKey, householdId } for the user's household,
//     generating the key on first request.

import crypto from "node:crypto";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function resolveHouseholdId(userId) {
  if (!userId) return null;
  const hid = await redis.get(`user:${userId}:household`);
  return hid || userId;
}

// 32 hex chars from two UUID v4s concatenated — 128 bits of entropy,
// the practical sweet spot for a copy-paste-friendly API key.
function generateApiKey() {
  return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "").slice(0, 32);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { userId } = req.query || {};
  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ error: "userId required" });
  }

  const householdId = await resolveHouseholdId(userId);
  if (!householdId) {
    return res.status(400).json({ error: "userId not associated with a household" });
  }

  const key = `household:${householdId}:apiKey`;
  let apiKey = await redis.get(key);
  if (!apiKey) {
    apiKey = generateApiKey();
    await redis.set(key, apiKey);
    console.log(`[ingest/key] generated apiKey for household=${householdId}`);
  }

  return res.status(200).json({ apiKey, householdId });
}
