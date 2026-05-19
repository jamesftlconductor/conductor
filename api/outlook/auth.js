// Microsoft OAuth v2 entry — mirrors api/auth.js for Google.
//
// Tenant-agnostic /common endpoint accepts both work and personal
// accounts. offline_access is required to receive a refresh token.
// The userId rides through Microsoft's `state` param (verbatim,
// preserved across redirects) so the callback knows whose tokens to
// store. Outlook is a SECONDARY connection — the user must already
// have authenticated via Google first — so we don't carry an invite
// code through this flow.

export default async function handler(req, res) {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({
      error: "MICROSOFT_CLIENT_ID not set — Outlook integration is credential-gated.",
    });
  }
  const redirectUri =
    process.env.OUTLOOK_REDIRECT_URI ||
    "https://conductor-ivory.vercel.app/api/outlook/callback";

  const userId = typeof req.query.userId === "string" ? req.query.userId : "";
  if (!userId) {
    return res.status(400).json({ error: "userId required" });
  }
  // State carries the userId verbatim so the callback can associate
  // the returned tokens with the right Conductor user.
  const state = JSON.stringify({ userId });

  // Mail.Read + Calendars.Read for the import path. Contacts.Read so
  // future "who is this from" surfacing can resolve display names.
  // offline_access is mandatory for refresh tokens.
  const scopes = ["Mail.Read", "Calendars.Read", "Contacts.Read", "offline_access"].join(" ");

  const authUrl =
    `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?` +
    `client_id=${encodeURIComponent(clientId)}&` +
    `response_type=code&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `response_mode=query&` +
    `scope=${encodeURIComponent(scopes)}&` +
    `state=${encodeURIComponent(state)}`;

  return res.redirect(authUrl);
}
