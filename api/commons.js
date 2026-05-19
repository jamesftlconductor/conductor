// Anonymous provider aggregation. Every household resolution lands a
// stripped-down record in commons:providers:{provider}:{region} so
// future intelligence queries can answer "how long does this provider
// take to wrap up" without ever joining back to a household identity.
//
// Extracted from signals.js so the import/tracking/AMZL/flight
// auto-resolve paths can call it without a cross-module require
// loop.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function safeJson(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

// Mirror of normalizeProvider in signals.js — kept here in full so
// commons.js can be imported without dragging signals.js along. If
// the canonical implementation ever shifts, both must be updated.
function normalizeProvider(name) {
  if (!name) return "";
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b(inc|llc|corp|co|ltd|company)\b\.?/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

export async function writeCommonsRecord(householdId, signal) {
  try {
    if (!signal || !signal.sender) return;
    const provider = normalizeProvider(signal.sender);
    if (!provider) return;
    const created =
      typeof signal.createdAt === "number"
        ? signal.createdAt
        : Date.parse(signal.createdAt || "");
    const resolved =
      typeof signal.id === "number" && signal.id > 1e12 ? signal.id : Date.now();
    if (isNaN(created) || created < 0) return;
    const resolutionDays = Math.max(
      0,
      Math.floor((Date.now() - created) / (24 * 60 * 60 * 1000))
    );
    let region = "generic";
    try {
      const raw = await redis.get(`household:${householdId}:location`);
      const loc = safeJson(raw);
      if (loc?.marketRegion) region = loc.marketRegion;
    } catch { /* skip */ }
    const key = `commons:providers:${provider}:${region}`;
    const record = {
      resolutionDays,
      signalType: signal.type || "unknown",
      resolvedAt: new Date(resolved).toISOString(),
    };
    await redis.lpush(key, JSON.stringify(record));
    await redis.ltrim(key, 0, 99);
    console.log(`[commons] wrote entry for ${signal.sender} in ${region} (key=${key})`);
  } catch (err) {
    console.warn("[commons] write failed:", err?.message);
  }
}

// Companion: log a memory entry for auto-resolves so the Took Care Of
// band can surface them. Distinct from signals.js writeMemoryEntry —
// this variant runs without an authenticated userId (carrier tracking,
// status-update trigger, AMZL parse). Stamps source + resolvedBy so
// the autoResolutions wasAutomatic filter classifies correctly.
export async function logAutoResolvedMemory(householdId, signal, sourceTag) {
  try {
    if (!signal) return;
    const lastUpdateMs =
      typeof signal.lastUpdate === "string" ? Date.parse(signal.lastUpdate) : NaN;
    const daysInSystem = !isNaN(lastUpdateMs)
      ? Math.max(0, Math.round((Date.now() - lastUpdateMs) / (24 * 60 * 60 * 1000)))
      : null;
    const entry = {
      signalId: signal.id ?? null,
      description: signal.description ?? null,
      type: signal.type ?? null,
      sender: signal.sender ?? null,
      eta: signal.eta ?? null,
      action: "resolved",
      actionAt: signal.resolvedAt || new Date().toISOString(),
      userId: signal.userId ?? null,
      source: sourceTag || "auto",
      resolvedBy: sourceTag || "auto",
      daysInSystem,
    };
    const memKey = `household:${householdId}:memory`;
    await redis.lpush(memKey, JSON.stringify(entry));
    await redis.ltrim(memKey, 0, 999);
  } catch (err) {
    console.warn("[commons] memory log write failed:", err?.message);
  }
}
