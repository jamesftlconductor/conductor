// Oura Ring OAuth flow. Two routes via the Vercel dynamic-segment file
// pattern (mirrors api/invite/[action].js):
//   GET /api/oura/auth?userId=...     → redirect to Oura authorize URL
//   GET /api/oura/callback?code=...&state=... → exchange code for tokens
//
// Stored token shape at user:{userId}:ouraTokens:
//   { accessToken, refreshToken, expiresAt }
//
// Requires env: OURA_CLIENT_ID, OURA_CLIENT_SECRET.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const OURA_AUTH_URL = "https://cloud.ouraring.com/oauth/authorize";
const OURA_TOKEN_URL = "https://api.ouraring.com/oauth/token";
const REDIRECT_URI = "https://conductor-ivory.vercel.app/api/oura/callback";
const SCOPES = "daily heartrate personal session sleep workout";

async function handleAuth(req, res) {
  const { userId } = req.query || {};
  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ error: "userId required" });
  }
  if (!process.env.OURA_CLIENT_ID) {
    return res.status(500).json({ error: "Oura integration not configured" });
  }
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.OURA_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state: userId,
  });
  res.setHeader("Location", `${OURA_AUTH_URL}?${params.toString()}`);
  return res.status(302).end();
}

async function handleCallback(req, res) {
  const { code, state } = req.query || {};
  if (!code || typeof code !== "string") {
    return res.status(400).json({ error: "code required" });
  }
  if (!state || typeof state !== "string") {
    return res.status(400).json({ error: "state (userId) required" });
  }
  if (!process.env.OURA_CLIENT_ID || !process.env.OURA_CLIENT_SECRET) {
    return res.status(500).json({ error: "Oura integration not configured" });
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: process.env.OURA_CLIENT_ID,
    client_secret: process.env.OURA_CLIENT_SECRET,
  });

  let data;
  try {
    const response = await fetch(OURA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    data = await response.json();
    if (!response.ok || !data?.access_token) {
      console.error("[oura/callback] token exchange failed", response.status, data);
      return res.status(502).json({ error: "Oura token exchange failed" });
    }
  } catch (err) {
    console.error("[oura/callback] error:", err?.message || err);
    return res.status(502).json({ error: "Oura token exchange error" });
  }

  // Oura's expires_in is seconds-from-now. Store an absolute expiry
  // timestamp so the sync layer can refresh without doing the math each
  // time. 60s safety margin since the token can be near-expiry when we
  // try to use it.
  const expiresAt = Date.now() + Math.max(0, (data.expires_in ?? 3600) * 1000) - 60_000;

  await redis.set(
    `user:${state}:ouraTokens`,
    JSON.stringify({
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      expiresAt,
    })
  );

  // Use the existing success page so the post-connect UX matches
  // Google's OAuth completion.
  res.setHeader("Location", "/api/success?connected=oura");
  return res.status(302).end();
}

async function handleStatus(req, res) {
  const { userId } = req.query || {};
  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ error: "userId required" });
  }
  const exists = await redis.exists(`user:${userId}:ouraTokens`);
  return res.status(200).json({ connected: exists > 0 });
}

async function handleDisconnect(req, res) {
  const { userId } = req.query || req.body || {};
  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ error: "userId required" });
  }
  await redis.del(`user:${userId}:ouraTokens`);
  return res.status(200).json({ disconnected: true });
}

export default async function handler(req, res) {
  const action = req.query?.action;
  if (action === "auth") return handleAuth(req, res);
  if (action === "callback") return handleCallback(req, res);
  if (action === "status") return handleStatus(req, res);
  if (action === "disconnect") return handleDisconnect(req, res);
  return res.status(404).json({ error: "Unknown action" });
}
