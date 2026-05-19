// Microsoft OAuth callback — exchanges the authorization code for
// access + refresh tokens, fetches the Graph /me profile for display
// metadata, and stores everything at user:{userId}:outlookTokens.
//
// Unlike the Google callback this is a SECONDARY connection — the
// userId was already established via Google sign-in and travels
// through the OAuth state param. No household provisioning happens
// here; the user already has one.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const PROFILE_URL = "https://graph.microsoft.com/v1.0/me";

export default async function handler(req, res) {
  const { code, error, error_description, state: stateRaw } = req.query;

  if (error) {
    return res.redirect(
      `conductorapp://auth?outlookError=${encodeURIComponent(error_description || error)}`
    );
  }
  if (!code) {
    return res.status(400).json({ error: "No code provided" });
  }

  let userId = null;
  if (stateRaw) {
    try {
      const parsed = typeof stateRaw === "string" ? JSON.parse(stateRaw) : stateRaw;
      if (parsed && typeof parsed.userId === "string" && parsed.userId.length > 0) {
        userId = parsed.userId;
      }
    } catch {
      // ignore — proceed only if we got a userId somehow
    }
  }
  if (!userId) {
    return res.status(400).json({ error: "userId missing from state" });
  }

  const redirectUri =
    process.env.OUTLOOK_REDIRECT_URI ||
    "https://conductor-ivory.vercel.app/api/outlook/callback";

  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.MICROSOFT_CLIENT_ID,
        client_secret: process.env.MICROSOFT_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      console.error("Outlook token exchange failed:", tokens);
      return res.status(400).json({ error: "Failed to get Outlook tokens", detail: tokens });
    }

    // Pull profile so the Settings row can show the connected email +
    // display name. Best-effort: a missing profile shouldn't block the
    // token write.
    let email = null;
    let displayName = null;
    try {
      const profRes = await fetch(PROFILE_URL, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (profRes.ok) {
        const prof = await profRes.json();
        email = prof.userPrincipalName || prof.mail || null;
        displayName = prof.displayName || null;
      }
    } catch (profErr) {
      console.warn("[outlook] profile fetch failed:", profErr?.message || profErr);
    }

    const tokenData = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in * 1000),
      email,
      displayName,
      connectedAt: Date.now(),
    };
    await redis.set(`user:${userId}:outlookTokens`, JSON.stringify(tokenData));

    // Trigger an initial Outlook import in the background. Mirrors
    // the post-callback onboard kick on the Google side. Fire-and-
    // forget; failures are visible in logs but don't block the
    // success redirect.
    const baseUrl = "https://conductor-ivory.vercel.app";
    fetch(`${baseUrl}/api/outlook-import?userId=${encodeURIComponent(userId)}`, {
      method: "GET",
    }).catch((err) => console.error("Outlook initial sync trigger error:", err));

    // Redirect back into the mobile app. The Settings screen polls
    // /api/outlook/status so it will flip to Connected within a
    // refresh cycle.
    return res.redirect(`conductorapp://settings?outlookConnected=1`);
  } catch (err) {
    console.error("Outlook callback error:", err);
    return res.status(500).json({ error: "Outlook authentication failed" });
  }
}
