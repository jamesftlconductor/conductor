// Shared Nextdoor OAuth token-refresh helper. Mirrors the shape of
// api/refresh.js (Google), api/outlook-token.js (Microsoft), and
// api/ring-token.js (Ring). Tokens stored at user:{userId}:nextdoorTokens.
//
// Nextdoor's Partner API is gated behind partner approval. The
// endpoint paths used here come from their public OAuth documentation
// as of 2025. When partner access is granted, the surrounding flow
// (auth/callback/status/disconnect + scan) is stable regardless of
// any minor URL or scope tweaks Nextdoor ships.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TOKEN_URL = "https://auth.nextdoor.com/v2/token";
// Scopes mirror the spec; surface them in one place so auth.js and
// the refresh path can't drift.
const SCOPES = "read:neighborhood_posts read:local_deals";

export async function getValidNextdoorToken(userId) {
  const raw = await redis.get(`user:${userId}:nextdoorTokens`);
  if (!raw) throw new Error("No Nextdoor tokens for user");
  const tokenData = typeof raw === "string" ? JSON.parse(raw) : raw;

  const fiveMin = 5 * 60 * 1000;
  if (Date.now() < tokenData.expiresAt - fiveMin) {
    return tokenData.accessToken;
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.NEXTDOOR_CLIENT_ID,
      client_secret: process.env.NEXTDOOR_CLIENT_SECRET,
      refresh_token: tokenData.refreshToken,
      grant_type: "refresh_token",
      scope: SCOPES,
    }),
  });
  const fresh = await response.json();
  if (!fresh.access_token) {
    throw new Error(`Nextdoor token refresh failed: ${fresh.error_description || "no access_token"}`);
  }
  const updated = {
    ...tokenData,
    accessToken: fresh.access_token,
    // Nextdoor may rotate the refresh token; keep the old one if not.
    refreshToken: fresh.refresh_token || tokenData.refreshToken,
    expiresAt: Date.now() + ((fresh.expires_in || 3600) * 1000),
  };
  await redis.set(`user:${userId}:nextdoorTokens`, JSON.stringify(updated));
  return fresh.access_token;
}

export default async function handler(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "No userId provided" });
  try {
    const accessToken = await getValidNextdoorToken(userId);
    return res.status(200).json({ accessToken });
  } catch (err) {
    console.error("Nextdoor refresh error:", err);
    return res.status(401).json({ error: err?.message || "Failed to refresh Nextdoor token" });
  }
}
