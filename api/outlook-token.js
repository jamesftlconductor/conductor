// Shared Microsoft OAuth token-refresh helper. Mirrors the shape of
// api/refresh.js (getValidToken) so the import + calendar paths can
// call a single function and not worry about expiry handling.
//
// Tokens are stored at user:{userId}:outlookTokens as JSON:
//   { accessToken, refreshToken, expiresAt, email, displayName }
// Microsoft's tenant-agnostic /common/oauth2/v2.0/token endpoint
// handles both work + personal accounts.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
// Scopes mirror what api/outlook/auth.js requests. Microsoft requires
// the refresh-token grant to specify a subset of the originally-
// consented scopes; passing the full list is always safe.
const SCOPES = "Mail.Read Calendars.Read Contacts.Read offline_access";

export async function getValidOutlookToken(userId) {
  const raw = await redis.get(`user:${userId}:outlookTokens`);
  if (!raw) throw new Error("No Outlook tokens for user");
  const tokenData = typeof raw === "string" ? JSON.parse(raw) : raw;

  // Refresh 5 minutes before expiry to avoid races against Graph API
  // calls that take a few seconds.
  const fiveMin = 5 * 60 * 1000;
  if (Date.now() < tokenData.expiresAt - fiveMin) {
    return tokenData.accessToken;
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      refresh_token: tokenData.refreshToken,
      grant_type: "refresh_token",
      scope: SCOPES,
    }),
  });
  const fresh = await response.json();
  if (!fresh.access_token) {
    throw new Error(`Outlook token refresh failed: ${fresh.error_description || "no access_token"}`);
  }

  const updated = {
    ...tokenData,
    accessToken: fresh.access_token,
    // Microsoft sometimes rotates the refresh token; preserve the old
    // one when no new one is returned (their docs say either is valid).
    refreshToken: fresh.refresh_token || tokenData.refreshToken,
    expiresAt: Date.now() + (fresh.expires_in * 1000),
  };
  await redis.set(`user:${userId}:outlookTokens`, JSON.stringify(updated));
  return fresh.access_token;
}

export default async function handler(req, res) {
  // /api/outlook-token is mostly an internal helper but exposing a
  // tiny endpoint mirrors api/refresh.js — useful for smoke-testing
  // that a stored token can refresh without re-running OAuth.
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "No userId provided" });
  try {
    const accessToken = await getValidOutlookToken(userId);
    return res.status(200).json({ accessToken });
  } catch (err) {
    console.error("Outlook refresh error:", err);
    return res.status(401).json({ error: err?.message || "Failed to refresh Outlook token" });
  }
}
