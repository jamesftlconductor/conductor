import { Redis } from "@upstash/redis";
import { getValidToken } from "./refresh.js";

// Gmail push notifications — subscribes a user's inbox to a Google Cloud
// Pub/Sub topic via the Gmail watch() API so new mail triggers an immediate
// import (api/gmail-push.js) instead of waiting for the hourly sync cron.
//
// Requires, on the Google Cloud side:
//   1. A Pub/Sub topic:        projects/{project}/topics/conductor-gmail
//   2. A push subscription →   https://conductor-ivory.vercel.app/api/gmail-push
//   3. The Gmail API service account (gmail-api-push@system.gserviceaccount.com)
//      granted Pub/Sub Publisher on that topic.
//
// Watches expire after 7 days; api/sync.js renews them every 6 days via
// renewGmailWatchIfDue() below.

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Full topic name. Prefer an explicit env (simplest for ops); otherwise
// build it from the GCP project id. Returns null when neither is configured
// so callers can skip cleanly rather than POSTing a malformed watch.
function resolveTopicName() {
  if (process.env.GMAIL_PUBSUB_TOPIC) return process.env.GMAIL_PUBSUB_TOPIC;
  const project =
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT_ID;
  return project ? `projects/${project}/topics/conductor-gmail` : null;
}

// Resolve the user's Gmail address from stored tokens/profile so we can
// write the reverse address→userId map that gmail-push uses.
async function resolveUserEmail(userId) {
  for (const key of [`user:${userId}:tokens`, `user:${userId}:profile`]) {
    try {
      const raw = await redis.get(key);
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (parsed?.email) return parsed.email;
    } catch {
      /* fall through */
    }
  }
  return null;
}

// RENEW_AFTER_MS — renew at 6 days so a watch never lapses inside its 7-day
// expiry. WATCH_TTL is what we stamp locally when Google doesn't echo an
// expiration (it normally does, in ms-epoch).
const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Subscribe (or re-subscribe) this user's INBOX to the Pub/Sub topic.
// Idempotent on Google's side — calling watch() again simply resets the
// 7-day clock and returns the current historyId. Returns a result object;
// throws only on missing config / token so callers can decide to swallow.
export async function setupGmailWatch(userId) {
  if (!userId) throw new Error("No userId provided");
  const topicName = resolveTopicName();
  if (!topicName) {
    console.warn("[gmail-watch] no topic configured (set GMAIL_PUBSUB_TOPIC); skipping");
    return { ok: false, skipped: "no-topic" };
  }

  const accessToken = await getValidToken(userId);
  const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/watch", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ topicName, labelIds: ["INBOX"] }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error(`[gmail-watch] watch() failed for ${userId}:`, resp.status, data?.error?.message || data);
    throw new Error(`watch failed: ${resp.status} ${data?.error?.message || ""}`.trim());
  }

  // data: { historyId, expiration } — expiration is ms-epoch as a string.
  const expiration = data.expiration ? Number(data.expiration) : Date.now() + SEVEN_DAYS_MS;
  const watchRecord = {
    historyId: data.historyId ? String(data.historyId) : null,
    expiration,
    topicName,
    updatedAt: Date.now(),
  };

  // Baseline historyId for the push handler's history.list cursor. Only
  // (re)set it when we don't already have one, so an in-flight push isn't
  // stranded by the watch refresh moving the cursor forward.
  const existingHistory = await redis.get(`user:${userId}:gmailHistoryId`);
  if (!existingHistory && watchRecord.historyId) {
    await redis.set(`user:${userId}:gmailHistoryId`, watchRecord.historyId);
  }
  await redis.set(`user:${userId}:gmailWatch`, JSON.stringify(watchRecord));

  // Reverse map so gmail-push can resolve the Pub/Sub emailAddress → userId
  // without depending on the email→userId character transform.
  const email = await resolveUserEmail(userId);
  if (email) {
    await redis.set(`gmail:address:${email.toLowerCase()}:userId`, userId);
  }

  console.log(`[gmail-watch] watching INBOX for ${userId} (historyId=${watchRecord.historyId}, exp=${new Date(expiration).toISOString()})`);
  return { ok: true, ...watchRecord };
}

// Renew if the stored watch is missing, older than 6 days, or within 24h of
// expiry. Best-effort: returns a status string and never throws so the sync
// sweep can call it per member without try/catch noise.
export async function renewGmailWatchIfDue(userId) {
  try {
    const hasTokens = await redis.exists(`user:${userId}:tokens`);
    if (!hasTokens) return "no-tokens";
    const raw = await redis.get(`user:${userId}:gmailWatch`);
    const watch = (() => {
      if (!raw) return null;
      try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
    })();
    const now = Date.now();
    const due =
      !watch ||
      typeof watch.updatedAt !== "number" ||
      now - watch.updatedAt >= SIX_DAYS_MS ||
      (typeof watch.expiration === "number" && watch.expiration - now <= 24 * 60 * 60 * 1000);
    if (!due) return "fresh";
    await setupGmailWatch(userId);
    return "renewed";
  } catch (err) {
    console.warn(`[gmail-watch] renew failed for ${userId}:`, err?.message || err);
    return "error";
  }
}

// HTTP entry — POST { userId } to set up a watch on demand (called
// fire-and-forget from api/callback.js after OAuth completes).
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "No userId provided" });
  try {
    const result = await setupGmailWatch(userId);
    return res.status(200).json(result);
  } catch (error) {
    console.error("[gmail-watch] setup error:", error?.message || error);
    return res.status(500).json({ error: "watch setup failed", message: error?.message });
  }
}
