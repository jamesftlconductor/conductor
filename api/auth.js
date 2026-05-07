export default async function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = "https://conductor-ivory.vercel.app/api/callback";

  const scopes = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
    "email",
    "profile",
  ].join(" ");

  // The inviteCode (if present) rides through Google's OAuth flow inside the
  // state parameter so the callback can consume it after we know who the
  // authenticated user is. Google preserves state verbatim across the redirect.
  const inviteCode =
    typeof req.query.inviteCode === "string" && req.query.inviteCode.length > 0
      ? req.query.inviteCode
      : null;
  const state = JSON.stringify({ inviteCode });

  const authUrl =
    `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${clientId}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `response_type=code&` +
    `scope=${encodeURIComponent(scopes)}&` +
    `access_type=offline&` +
    `prompt=consent&` +
    `state=${encodeURIComponent(state)}`;

  return res.redirect(authUrl);
}
