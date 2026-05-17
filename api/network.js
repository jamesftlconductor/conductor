// The Network — household-to-household connections. A household can
// invite another household to share awareness at one of three
// permission levels:
//   watchful        — signalLoad + urgentCount + lastActive only
//   open            — signalLoad + urgentCount + active signal
//                     descriptions + upcoming deadlines
//   emergency_only  — boolean hasEmergency only
//
// Routes:
//   POST /api/network/connect    — request a connection (existing household)
//   GET  /api/network/status     — list all connected households + their summaries
//   POST /api/network/invite     — generate a network invite link
//   GET  /api/network/join       — accept an invite, creates bidirectional connection
//   POST /api/network/disconnect — break a connection (both sides)
//
// Storage:
//   household:{id}:networkConnections  — SET of JSON {connectedHouseholdId, permissionLevel, connectedAt, connectedBy}
//   network_invite:{code}              — JSON {fromHouseholdId, fromUserId, permissionLevel, expiresAt} 7d TTL

import crypto from "node:crypto";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const SEVEN_DAYS_S = 7 * 24 * 60 * 60;
const VALID_LEVELS = new Set(["watchful", "open", "emergency_only"]);

function safeJson(v) {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
}

async function resolveHouseholdId(userId) {
  if (!userId) return null;
  const hid = await redis.get(`user:${userId}:household`);
  return hid || userId;
}

// 10 hex chars from a v4 UUID, same convention as the household invite
// path. Short enough to share verbally; collision-resistant well past
// our scale.
function generateInviteCode() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

async function loadConnections(householdId) {
  const raw = await redis.smembers(`household:${householdId}:networkConnections`);
  const out = [];
  for (const r of raw || []) {
    const parsed = safeJson(r);
    if (parsed && parsed.connectedHouseholdId) out.push(parsed);
  }
  return out;
}

// Persist (or replace) a connection record. Connections are stored as
// JSON-stringified set members keyed implicitly by connectedHouseholdId
// — we drop any existing record for the same target before re-adding,
// so permission-level updates don't duplicate.
async function upsertConnection(householdId, record) {
  const key = `household:${householdId}:networkConnections`;
  const existing = await loadConnections(householdId);
  // Remove any prior record for the same target.
  for (const e of existing) {
    if (e.connectedHouseholdId === record.connectedHouseholdId) {
      await redis.srem(key, JSON.stringify(e));
    }
  }
  await redis.sadd(key, JSON.stringify(record));
}

// Build the per-connection summary at the permission level the
// requesting household is allowed to see. Reads directly from the
// connected household's signals — no Claude call, just deterministic
// data shaping.
async function buildConnectionSummary(connectedHouseholdId, permissionLevel) {
  const rawSignals = await redis.lrange(`household:${connectedHouseholdId}:signals`, 0, -1);
  const signals = [];
  for (const r of rawSignals || []) {
    const parsed = safeJson(r);
    if (parsed) signals.push(parsed);
  }
  const active = signals.filter(
    (s) => !s.state || s.state === "incoming" || s.state === "active"
  );

  // Urgent classification mirrors brief.js's classifyUrgent shape —
  // within 24h or explicitly urgent. Kept inline so this module
  // doesn't depend on brief.js's full machinery.
  const isUrgent = (s) => {
    if (s.urgent === true) return true;
    const eta = s.eta ? Date.parse(s.eta) : NaN;
    if (isNaN(eta)) return false;
    return eta - Date.now() < 24 * 60 * 60 * 1000;
  };
  const urgent = active.filter(isUrgent);

  // signalLoad classification matches brief.js's classifySignalLoad.
  let signalLoad = "clear";
  if (urgent.length >= 3) signalLoad = "heavy";
  else if (urgent.length >= 1) signalLoad = "moderate";
  else if (active.length >= 1) signalLoad = "light";

  if (permissionLevel === "emergency_only") {
    return { hasEmergency: urgent.length > 0 };
  }
  if (permissionLevel === "watchful") {
    return {
      signalLoad,
      urgentCount: urgent.length,
      lastActive: signals.length > 0 ? Math.max(...signals.map((s) => s.id || 0)) : null,
    };
  }
  // open
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const upcomingDeadlines = signals
    .filter((s) => s.type === "deadline")
    .filter((s) => {
      const eta = s.eta ? Date.parse(s.eta) : NaN;
      return !isNaN(eta) && eta - Date.now() < SEVEN_DAYS_MS && eta > Date.now() - 24 * 60 * 60 * 1000;
    })
    .slice(0, 10)
    .map((s) => ({ description: s.description, eta: s.eta }));
  return {
    signalLoad,
    urgentCount: urgent.length,
    activeSignals: active.slice(0, 20).map((s) => ({
      description: s.description,
      type: s.type,
      eta: s.eta || null,
    })),
    upcomingDeadlines,
  };
}

// ---------- route handlers ----------

async function handleConnect(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { userId, targetHouseholdId, permissionLevel } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  if (!targetHouseholdId) return res.status(400).json({ error: "targetHouseholdId required" });
  const level = permissionLevel || "watchful";
  if (!VALID_LEVELS.has(level)) {
    return res.status(400).json({
      error: `permissionLevel must be one of: ${[...VALID_LEVELS].join(", ")}`,
    });
  }
  const fromHouseholdId = await resolveHouseholdId(userId);
  if (!fromHouseholdId) return res.status(400).json({ error: "userId has no household" });
  if (fromHouseholdId === targetHouseholdId) {
    return res.status(400).json({ error: "Cannot connect a household to itself" });
  }

  const now = new Date().toISOString();
  const record = {
    connectedHouseholdId: targetHouseholdId,
    permissionLevel: level,
    connectedAt: now,
    connectedBy: userId,
  };
  await upsertConnection(fromHouseholdId, record);

  // Best-effort notification placeholder — when the push wiring grows
  // a "network" type it can pick this up. For v1 we just log.
  console.log(
    `[network] ${fromHouseholdId} → ${targetHouseholdId} at ${level}`
  );

  return res.status(200).json({ ok: true, fromHouseholdId, record });
}

async function handleStatus(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { userId } = req.query || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  const householdId = await resolveHouseholdId(userId);
  if (!householdId) return res.status(400).json({ error: "userId has no household" });

  const connections = await loadConnections(householdId);
  const decorated = [];
  for (const conn of connections) {
    const summary = await buildConnectionSummary(
      conn.connectedHouseholdId,
      conn.permissionLevel
    );
    decorated.push({ ...conn, summary });
  }
  return res.status(200).json({ household: householdId, connections: decorated });
}

async function handleInvite(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { userId, inviteEmail, permissionLevel } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  const level = permissionLevel || "open";
  if (!VALID_LEVELS.has(level)) {
    return res.status(400).json({
      error: `permissionLevel must be one of: ${[...VALID_LEVELS].join(", ")}`,
    });
  }
  const fromHouseholdId = await resolveHouseholdId(userId);
  if (!fromHouseholdId) return res.status(400).json({ error: "userId has no household" });

  const code = generateInviteCode();
  const expiresAt = Date.now() + SEVEN_DAYS_S * 1000;
  const record = {
    fromHouseholdId,
    fromUserId: userId,
    inviteEmail: inviteEmail || null,
    permissionLevel: level,
    createdAt: Date.now(),
    expiresAt,
  };
  await redis.set(`network_invite:${code}`, JSON.stringify(record), { ex: SEVEN_DAYS_S });
  const inviteUrl = `https://conductor-ivory.vercel.app/api/network/join?code=${code}`;
  return res.status(200).json({ ok: true, code, expiresAt, inviteUrl });
}

async function handleJoin(req, res) {
  const { code, userId } = req.query || {};
  if (!code) return res.status(400).json({ error: "code required" });
  if (!userId) return res.status(400).json({ error: "userId required" });

  const raw = await redis.get(`network_invite:${code}`);
  const invite = safeJson(raw);
  if (!invite) return res.status(404).json({ error: "Invite not found or expired" });
  if (invite.expiresAt && Date.now() > invite.expiresAt) {
    return res.status(410).json({ error: "Invite expired" });
  }

  const acceptingHouseholdId = await resolveHouseholdId(userId);
  if (!acceptingHouseholdId) {
    return res.status(400).json({ error: "userId has no household" });
  }
  if (acceptingHouseholdId === invite.fromHouseholdId) {
    return res.status(400).json({ error: "Cannot accept your own household's invite" });
  }

  const now = new Date().toISOString();
  const level = invite.permissionLevel || "open";

  // Bidirectional connection — each household sees the other.
  await upsertConnection(invite.fromHouseholdId, {
    connectedHouseholdId: acceptingHouseholdId,
    permissionLevel: level,
    connectedAt: now,
    connectedBy: invite.fromUserId,
    via: "invite",
  });
  await upsertConnection(acceptingHouseholdId, {
    connectedHouseholdId: invite.fromHouseholdId,
    permissionLevel: level,
    connectedAt: now,
    connectedBy: userId,
    via: "invite",
  });

  // Consume the invite — single-use semantics.
  await redis.del(`network_invite:${code}`);
  console.log(
    `[network] join: ${invite.fromHouseholdId} ↔ ${acceptingHouseholdId} at ${level}`
  );

  return res.status(200).json({
    ok: true,
    connectedTo: invite.fromHouseholdId,
    permissionLevel: level,
  });
}

// Vault sharing — copy a vault item from the requesting household
// into a connected household's :sharedVault list. Validates that an
// active connection exists between the two households before copying.
//
// Categories that read as family-shareable (insurance, emergency,
// medical, legal, registration) are honored as-is. Anything else
// still flows through — the caller chose to share it, no need to
// gatekeep beyond connection presence.
async function handleShareVault(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { userId, vaultItemId, targetHouseholdId, permissionLevel } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  if (vaultItemId == null) return res.status(400).json({ error: "vaultItemId required" });
  if (!targetHouseholdId) return res.status(400).json({ error: "targetHouseholdId required" });
  const level = permissionLevel === "edit" ? "edit" : "view";

  const sourceHouseholdId = await resolveHouseholdId(userId);
  if (!sourceHouseholdId) return res.status(400).json({ error: "no household" });
  if (sourceHouseholdId === targetHouseholdId) {
    return res.status(400).json({ error: "Cannot share with your own household" });
  }

  // Validate the connection exists from source → target. We accept
  // any permission level — sharing a vault item is opt-in per item,
  // not gated by the connection's awareness level.
  const connections = await loadConnections(sourceHouseholdId);
  const linked = connections.some((c) => c.connectedHouseholdId === targetHouseholdId);
  if (!linked) {
    return res.status(400).json({ error: "Not connected to that household" });
  }

  // Find the vault item to copy.
  const sourceVaultKey = `household:${sourceHouseholdId}:vault`;
  const rawVault = await redis.lrange(sourceVaultKey, 0, -1);
  let item = null;
  for (const r of rawVault || []) {
    const parsed = safeJson(r);
    if (!parsed) continue;
    if (parsed.id === vaultItemId || String(parsed.id) === String(vaultItemId)) {
      item = parsed;
      break;
    }
  }
  if (!item) return res.status(404).json({ error: "vault item not found" });

  // Look up source household name for the badge on the target side.
  const sourceName =
    (await redis.get(`household:${sourceHouseholdId}:name`)) || sourceHouseholdId;

  const copy = {
    ...item,
    id: Date.now() + Math.floor(Math.random() * 1000),
    sharedFrom: {
      householdId: sourceHouseholdId,
      householdName: sourceName,
      sharedAt: new Date().toISOString(),
      originalId: item.id,
      permissionLevel: level,
    },
  };
  await redis.lpush(`household:${targetHouseholdId}:sharedVault`, JSON.stringify(copy));

  // Best-effort notification to the target household (no push if
  // the type=tracking notify is unavailable — keeps the share path
  // unblocked).
  try {
    await fetch("https://conductor-ivory.vercel.app/api/notify?type=tracking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        householdId: targetHouseholdId,
        title: "A vault item was shared with you",
        body: item.description || "From a connected household",
      }),
    });
  } catch {
    // ignore
  }

  console.log(
    `[network] vault share: ${sourceHouseholdId} → ${targetHouseholdId} item=${item.id}`
  );
  return res.status(200).json({ ok: true, sharedItemId: copy.id, sharedFrom: copy.sharedFrom });
}

async function handleSharedVault(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { userId } = req.query || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  const householdId = await resolveHouseholdId(userId);
  if (!householdId) return res.status(400).json({ error: "no household" });
  const raw = await redis.lrange(`household:${householdId}:sharedVault`, 0, -1);
  const items = (raw || []).map(safeJson).filter(Boolean);
  return res.status(200).json({ household: householdId, items, count: items.length });
}

async function handleDisconnect(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { userId, targetHouseholdId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  if (!targetHouseholdId) return res.status(400).json({ error: "targetHouseholdId required" });
  const householdId = await resolveHouseholdId(userId);
  if (!householdId) return res.status(400).json({ error: "userId has no household" });

  async function removeFor(srcHid, dstHid) {
    const existing = await loadConnections(srcHid);
    for (const e of existing) {
      if (e.connectedHouseholdId === dstHid) {
        await redis.srem(`household:${srcHid}:networkConnections`, JSON.stringify(e));
      }
    }
  }
  await removeFor(householdId, targetHouseholdId);
  await removeFor(targetHouseholdId, householdId);
  return res.status(200).json({ ok: true });
}

// ---------- export helpers (consumed by brief.js) ----------

// Reads connections for a household and builds summaries at each
// connection's permission level. Returns []  when no connections.
// Brief.js uses this to render the NETWORK section in the prompt.
export async function loadNetworkContext(householdId) {
  const connections = await loadConnections(householdId);
  if (connections.length === 0) return [];
  const out = [];
  for (const c of connections) {
    try {
      const summary = await buildConnectionSummary(
        c.connectedHouseholdId,
        c.permissionLevel
      );
      out.push({ ...c, summary });
    } catch (err) {
      console.warn(
        `[network] summary failed for ${c.connectedHouseholdId}:`,
        err?.message || err
      );
    }
  }
  return out;
}

// Default handler — routes by ?action= param. Kept on a single file
// per the Vercel function-limit convention; alternative would be
// api/network/[action].js as a dynamic route.
export default async function handler(req, res) {
  const action = req.query?.action || req.body?.action;
  if (action === "connect") return handleConnect(req, res);
  if (action === "status") return handleStatus(req, res);
  if (action === "invite") return handleInvite(req, res);
  if (action === "join") return handleJoin(req, res);
  if (action === "disconnect") return handleDisconnect(req, res);
  if (action === "share-vault") return handleShareVault(req, res);
  if (action === "shared-vault") return handleSharedVault(req, res);
  return res.status(404).json({ error: "Unknown action — use ?action=connect|status|invite|join|disconnect|share-vault|shared-vault" });
}
