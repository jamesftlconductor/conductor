// Shared Ring OAuth token-refresh helper. Mirrors api/refresh.js
// (Google) and api/outlook-token.js (Microsoft). Tokens stored at
// user:{userId}:ringTokens.
//
// Ring's developer OAuth surface is gated behind partner approval —
// the credentials and endpoint paths below are based on the public
// documentation as of 2025. When partner access is granted the
// constants here may need light adjustment, but the surrounding
// flow (auth/callback/status/disconnect + events webhook) is
// stable.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TOKEN_URL = "https://oauth.ring.com/oauth/token";
// Ring's documented OAuth scopes are minimal — `client` covers basic
// device access. Push event registration is a separate enrollment.
const SCOPES = "client";

export async function getValidRingToken(userId) {
  const raw = await redis.get(`user:${userId}:ringTokens`);
  if (!raw) throw new Error("No Ring tokens for user");
  const tokenData = typeof raw === "string" ? JSON.parse(raw) : raw;

  const fiveMin = 5 * 60 * 1000;
  if (Date.now() < tokenData.expiresAt - fiveMin) {
    return tokenData.accessToken;
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.RING_CLIENT_ID,
      client_secret: process.env.RING_CLIENT_SECRET,
      refresh_token: tokenData.refreshToken,
      grant_type: "refresh_token",
      scope: SCOPES,
    }),
  });
  const fresh = await response.json();
  if (!fresh.access_token) {
    throw new Error(`Ring token refresh failed: ${fresh.error_description || "no access_token"}`);
  }
  const updated = {
    ...tokenData,
    accessToken: fresh.access_token,
    refreshToken: fresh.refresh_token || tokenData.refreshToken,
    expiresAt: Date.now() + ((fresh.expires_in || 3600) * 1000),
  };
  await redis.set(`user:${userId}:ringTokens`, JSON.stringify(updated));
  return fresh.access_token;
}

export default async function handler(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "No userId provided" });
  try {
    const accessToken = await getValidRingToken(userId);
    return res.status(200).json({ accessToken });
  } catch (err) {
    console.error("Ring refresh error:", err);
    return res.status(401).json({ error: err?.message || "Failed to refresh Ring token" });
  }
}
