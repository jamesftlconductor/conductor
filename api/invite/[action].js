import crypto from "node:crypto";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_S = 7 * 24 * 60 * 60;
const BASE_URL = "https://conductor-ivory.vercel.app";

// 10 hex chars from a v4 UUID — collision-resistant well past our scale and
// short enough to type if someone has to. Built-in to Node, no nanoid dep.
function generateCode() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

async function handleGenerate(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { userId } = req.query;
  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ error: "userId required" });
  }

  const householdId = (await redis.get(`user:${userId}:household`)) || userId;
  const code = generateCode();
  const now = Date.now();
  const expiresAt = now + SEVEN_DAYS_MS;

  // EX duplicates the expiresAt timestamp at the Redis level so a stale
  // entry can't linger past its expiration window even if the join handler
  // forgets to check the timestamp.
  await redis.set(
    `invite:${code}`,
    JSON.stringify({
      householdId,
      createdBy: userId,
      createdAt: now,
      expiresAt,
    }),
    { ex: SEVEN_DAYS_S }
  );

  return res.status(200).json({
    code,
    expiresAt,
    inviteUrl: `${BASE_URL}/api/invite/join?code=${code}`,
  });
}

async function handleJoin(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).send("Method not allowed");
  }
  const { code } = req.query;
  if (!code || typeof code !== "string") {
    return res.status(400).send("Invite code required");
  }

  const raw = await redis.get(`invite:${code}`);
  const invite = typeof raw === "string" ? JSON.parse(raw) : raw;

  if (!invite) {
    return res.status(404).send("Invite not found or expired");
  }
  if (invite.expiresAt && Date.now() > invite.expiresAt) {
    return res.status(404).send("Invite expired");
  }

  // Funnel through the regular OAuth start so the new user grants
  // Gmail/Calendar scopes; the inviteCode rides along in OAuth state and gets
  // consumed in the callback.
  return res.redirect(`${BASE_URL}/api/auth?inviteCode=${encodeURIComponent(code)}`);
}

export default async function handler(req, res) {
  const { action } = req.query;
  if (action === "generate") return handleGenerate(req, res);
  if (action === "join") return handleJoin(req, res);
  return res.status(404).json({ error: "Unknown invite action" });
}
