import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

export default async function handler(req, res) {
  const { email, householdId, mode } = req.query;

  // Prefer the human-readable household name when one was set during
  // creation; fall back to the household id (for legacy households that
  // pre-date :name) or a generic label.
  let householdName = "";
  if (typeof householdId === "string" && householdId.length > 0) {
    const stored = await redis.get(`household:${householdId}:name`);
    householdName = (typeof stored === "string" && stored.length > 0)
      ? stored
      : householdId;
  }

  const safeName = escapeHtml(householdName);
  let heading;
  let body;
  let status;
  if (mode === "join" && householdName) {
    heading = `You've joined ${safeName}.`;
    body = "Conductor will start syncing your signals.<br>Your first Takeoff will be ready shortly.";
    status = `✓ Joined ${safeName}`;
  } else if (householdName) {
    heading = `Welcome to ${safeName}.`;
    body = "Conductor is syncing your signals.<br>Your first Takeoff will be ready shortly.";
    status = "✓ Gmail + Calendar connected";
  } else {
    heading = "You're connected.";
    body = "Conductor is syncing your signals.<br>Your first Takeoff will be ready shortly.";
    status = "✓ Gmail + Calendar connected";
  }

  return res.status(200).send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Conductor</title>
      <style>
        body {
          background: #0f0f0f;
          color: #f0ede8;
          font-family: -apple-system, sans-serif;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          margin: 0;
          padding: 32px;
          text-align: center;
        }
        .logo {
          width: 64px;
          height: 64px;
          background: #f0ede8;
          border-radius: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 32px;
          font-weight: 700;
          color: #0f0f0f;
          margin-bottom: 24px;
        }
        h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; }
        p { color: #8a8780; font-size: 16px; line-height: 1.6; margin-bottom: 32px; }
        .email { color: #f0ede8; font-size: 14px; margin-bottom: 32px; }
        .status {
          background: rgba(74, 222, 128, 0.1);
          color: #4ade80;
          padding: 12px 24px;
          border-radius: 8px;
          font-size: 14px;
        }
      </style>
    </head>
    <body>
      <div class="logo">C</div>
      <h1>${heading}</h1>
      <p>${body}</p>
      <div class="email">${escapeHtml(email || "")}</div>
      <div class="status">${status}</div>
    </body>
    </html>
  `);
}
