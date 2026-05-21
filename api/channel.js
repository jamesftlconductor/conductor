// In-app Crew Channel — household-scoped message log with per-user
// unread counters. Backed by:
//   household:{id}:channel              LPUSH/LRANGE 200-capped message list
//   household:{id}:channel:unread:{uid} INCR/SET per-recipient counter
//
// Endpoints (all routed by req.url path):
//   GET   /api/channel                  — list recent messages
//   POST  /api/channel                  — append message + bump unreads
//   GET   /api/channel/unread           — current user's unread count
//   POST  /api/channel/read             — clear current user's counter
//
// Conductor system messages use senderId='conductor', senderName='Conductor'
// — the mobile renderer detects this and applies the muted-italic style.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const CHANNEL_CAP = 199; // LTRIM 0..199 keeps 200 messages
const RECENT_LIMIT = 50;

async function resolveHouseholdId(userId) {
  if (!userId) return null;
  const hid = await redis.get(`user:${userId}:household`);
  return hid || "RangerOaks925";
}

// Scan the user:*:household keyspace to list members of a household.
// Matches the pattern already used by signals.js cache invalidation.
async function householdMembers(householdId) {
  const members = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, {
      match: "user:*:household",
      count: 100,
    });
    cursor = next;
    for (const key of batch || []) {
      const stored = await redis.get(key);
      if (stored === householdId) {
        const userId = key.slice("user:".length, -":household".length);
        members.push(userId);
      }
    }
  } while (cursor !== "0" && cursor !== 0);
  return members;
}

async function senderDisplayName(userId) {
  if (userId === "conductor") return "Conductor";
  try {
    const raw = await redis.get(`user:${userId}:preferences`);
    const prefs = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (prefs?.displayName) return prefs.displayName;
    if (prefs?.firstName) return prefs.firstName;
  } catch { /* ignore */ }
  // Last resort: derive a friendly handle from the userId. Strip the
  // gmail-suffix that appears in our test users so the name reads as
  // a first name rather than a slug.
  return userId.replace(/_totalhome_gmail_com$/, "").replace(/_/g, " ");
}

function safeJsonParse(v) {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
}

async function handleGetMessages(req, res, householdId, userId) {
  const since = typeof req.query?.since === "string" ? Date.parse(req.query.since) : NaN;
  const raw = await redis.lrange(`household:${householdId}:channel`, 0, RECENT_LIMIT - 1);
  const messages = (raw || [])
    .map((v) => safeJsonParse(v))
    .filter(Boolean)
    .filter((m) => {
      if (isNaN(since)) return true;
      const ms = Date.parse(m.createdAt || "");
      return !isNaN(ms) && ms > since;
    });
  // Newest-first is the natural LPUSH order; the inverted FlatList on
  // the mobile side renders accordingly without an extra reverse.
  return res.status(200).json({ messages, count: messages.length });
}

async function handlePostMessage(req, res, householdId, userId) {
  const { text, attachedSignalId, mediaUrl, mediaType, senderId: overrideSender } = req.body || {};
  const isConductor = overrideSender === "conductor";
  const finalSenderId = isConductor ? "conductor" : userId;
  if (!text && !mediaUrl && !attachedSignalId) {
    return res.status(400).json({ error: "text, mediaUrl, or attachedSignalId required" });
  }
  const senderName = await senderDisplayName(finalSenderId);
  // Tiny UUID-ish — Vercel's Node runtime doesn't always have
  // crypto.randomUUID in older versions. This is collision-safe for
  // human-readable channels (we'd need 1e9 messages/sec to clash).
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const message = {
    id,
    householdId,
    senderId: finalSenderId,
    senderName,
    text: typeof text === "string" ? text : null,
    attachedSignalId: attachedSignalId || null,
    mediaUrl: mediaUrl || null,
    mediaType: mediaType || null,
    createdAt: new Date().toISOString(),
    readBy: [finalSenderId],
  };
  const key = `household:${householdId}:channel`;
  await redis.lpush(key, JSON.stringify(message));
  await redis.ltrim(key, 0, CHANNEL_CAP);

  // Bump unread for every other household member. The sender's own
  // counter is intentionally left untouched — sent messages don't
  // count as unread to the sender.
  try {
    const members = await householdMembers(householdId);
    for (const m of members) {
      if (m === finalSenderId) continue;
      await redis.incr(`household:${householdId}:channel:unread:${m}`);
    }
  } catch (err) {
    console.warn("[channel] unread bump failed:", err?.message || err);
  }

  return res.status(201).json({ message, success: true });
}

async function handleUnread(req, res, householdId, userId) {
  const raw = await redis.get(`household:${householdId}:channel:unread:${userId}`);
  const count = Number(raw) || 0;
  return res.status(200).json({ count });
}

async function handleMarkRead(req, res, householdId, userId) {
  await redis.set(`household:${householdId}:channel:unread:${userId}`, 0);
  return res.status(200).json({ success: true });
}

export default async function handler(req, res) {
  try {
    // Path discrimination — the file maps to /api/channel and also
    // serves /api/channel/unread / /api/channel/read by inspecting
    // the trailing URL segment. Cleaner than a single endpoint with
    // verb conventions because each surface has distinct payloads.
    const urlPath = (req.url || "").split("?")[0];
    const tail = urlPath.replace(/^.*\/api\/channel\/?/, "").replace(/\/$/, "");

    const userId = req.method === "GET"
      ? req.query?.userId
      : req.body?.userId;
    if (!userId) return res.status(400).json({ error: "userId required" });
    const householdId = await resolveHouseholdId(userId);
    if (!householdId) return res.status(400).json({ error: "no household" });

    if (tail === "unread" && req.method === "GET") {
      return handleUnread(req, res, householdId, userId);
    }
    if (tail === "read" && (req.method === "POST" || req.method === "DELETE")) {
      return handleMarkRead(req, res, householdId, userId);
    }
    if (tail === "" || tail === undefined) {
      if (req.method === "GET") return handleGetMessages(req, res, householdId, userId);
      if (req.method === "POST") return handlePostMessage(req, res, householdId, userId);
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[channel] handler error:", err?.message || err);
    return res.status(500).json({ error: "channel failed" });
  }
}
