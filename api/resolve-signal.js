// Canonical signal resolution — the single path that reconciles all four
// stores when a signal is resolved, so a resolution can never "stick" in one
// store while lingering in another (the root cause behind signals that
// reappear after being resolved). Every resolve entry point — the PATCH
// handler, import status-updates, flight-landed, the brief staleness sweep,
// the Twilio DONE reply — routes through here.
//
// Depends ONLY on commons.js (a leaf module) to avoid a circular import with
// signals.js, which calls resolveSignal. Enrichments that live in signals.js
// (streak / weekly symphony / caught-moment / channel auto-post) stay there
// and run after this returns for the PATCH path — they are not duplicated here.

import { Redis } from "@upstash/redis";
import { writeCommonsRecord, logAutoResolvedMemory } from "./commons.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function safeParse(v) {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
}

// Conservative description match for the :vault reconciliation. Normalizes to
// lowercased alphanumerics and only matches on equality or strong containment
// (both sides long enough that accidental overlap is unlikely) so we never
// mark the WRONG vault item handled off a loose word match.
function vaultDescMatches(signalDesc, vaultDesc) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const a = norm(signalDesc);
  const b = norm(vaultDesc);
  if (!a || !b || a.length < 8 || b.length < 8) return false;
  if (a === b) return true;
  if (a.length >= 12 && b.length >= 12 && (a.includes(b) || b.includes(a))) return true;
  return false;
}

// Household-wide brief cache bust — mirrors invalidateBriefCache in signals.js
// (kept here to avoid importing signals.js). Scans membership and clears every
// member's cached Takeoff/Clearance/Midday, plus the acting user directly
// (a user with no user:{id}:household key is missed by the scan).
async function bustHouseholdBriefCache(householdId, actingUserId) {
  const members = new Set();
  if (actingUserId) members.add(actingUserId);
  try {
    let cursor = "0";
    do {
      const [next, batch] = await redis.scan(cursor, { match: "user:*:household", count: 100 });
      cursor = next;
      for (const key of batch || []) {
        const uid = key.slice("user:".length, -":household".length);
        const hid = await redis.get(key);
        if ((hid || uid) === householdId) members.add(uid);
      }
    } while (cursor !== "0" && cursor !== 0);
  } catch (err) {
    console.warn("[resolve] member scan failed:", err?.message || err);
  }
  const dels = [];
  for (const uid of members) {
    dels.push(redis.del(`user:${uid}:currentTakeoff`));
    dels.push(redis.del(`user:${uid}:currentClearance`));
    dels.push(redis.del(`user:${uid}:currentMidday`));
  }
  await Promise.all(dels).catch(() => {});
}

/**
 * Resolve a signal everywhere at once.
 *
 * @param {string} householdId
 * @param {string|number} signalId
 * @param {string|null} userId   acting user (resolvedBy + direct cache bust)
 * @param {object} options       { reason = 'user', note = null }
 * @returns {Promise<{ resolved: boolean, signalId, stores: string[] }>}
 */
export async function resolveSignal(householdId, signalId, userId, options = {}) {
  const { reason = "user", note = null } = options;
  if (!householdId || signalId === undefined || signalId === null) {
    return { resolved: false, signalId, stores: [] };
  }
  const idStr = String(signalId);
  const now = new Date();
  const stores = [];
  let resolvedSignal = null;
  // True when the signal was ALREADY resolved before this call — used to make
  // the longitudinal writes (memory + Commons) fire exactly once per real
  // resolution, so a re-resolve (or a caller that pre-set the state) can't
  // double-log. The store reconciliation below still runs idempotently.
  let alreadyResolved = false;

  // 1. :signals — stamp resolved metadata (idempotent; owns the resolve stamp
  //    so callers don't need to pre-set the state).
  try {
    const sigKey = `household:${householdId}:signals`;
    const raw = await redis.lrange(sigKey, 0, -1);
    for (let i = 0; i < raw.length; i++) {
      const s = safeParse(raw[i]);
      if (!s || (s.id !== signalId && String(s.id) !== idStr)) continue;
      alreadyResolved = s.state === "resolved";
      s.state = "resolved";
      if (!s.resolvedAt) s.resolvedAt = now.toISOString();
      s.resolvedBy = userId || s.resolvedBy || reason;
      s.resolveReason = reason;
      if (note) s.resolveNote = note;
      s.lastUpdate = now.toLocaleString();
      await redis.lset(sigKey, i, JSON.stringify(s));
      resolvedSignal = s;
      stores.push("signals");
      break;
    }
  } catch (err) {
    console.warn("[resolve] :signals update failed:", err?.message || err);
  }

  // 2. :missedCues — remove any copies of this signal (stale snapshots).
  try {
    const mcKey = `household:${householdId}:missedCues`;
    const raw = await redis.lrange(mcKey, 0, -1);
    const survivors = [];
    let removed = 0;
    for (const r of raw) {
      const e = safeParse(r);
      if (e && (e.id === signalId || String(e.id) === idStr)) { removed++; continue; }
      survivors.push(typeof r === "string" ? r : JSON.stringify(r));
    }
    if (removed > 0) {
      await redis.del(mcKey);
      const CHUNK = 50;
      for (let i = 0; i < survivors.length; i += CHUNK) {
        if (survivors.slice(i, i + CHUNK).length) await redis.rpush(mcKey, ...survivors.slice(i, i + CHUNK));
      }
      stores.push("missedCues");
    }
  } catch (err) {
    console.warn("[resolve] :missedCues reconcile failed:", err?.message || err);
  }

  // 3. :vault — mark matching unhandled items handled (conservative desc match).
  if (resolvedSignal?.description) {
    try {
      const vaultKey = `household:${householdId}:vault`;
      const raw = await redis.lrange(vaultKey, 0, -1);
      let updated = 0;
      for (let i = 0; i < raw.length; i++) {
        const v = safeParse(raw[i]);
        if (!v || v.handled === true) continue;
        if (vaultDescMatches(resolvedSignal.description, v.description)) {
          v.handled = true;
          v.handledAt = now.toISOString();
          await redis.lset(vaultKey, i, JSON.stringify(v));
          updated++;
          console.log(`[resolve] vault item handled via signal match: "${(v.description || "").slice(0, 60)}"`);
        }
      }
      if (updated > 0) stores.push("vault");
    } catch (err) {
      console.warn("[resolve] :vault reconcile failed:", err?.message || err);
    }
  }

  // 4. :memory — append the resolution event (Took Care Of / Compass feed).
  //    Only on a genuine transition so a re-resolve doesn't duplicate entries.
  if (resolvedSignal && !alreadyResolved) {
    try {
      await logAutoResolvedMemory(householdId, resolvedSignal, reason);
      stores.push("memory");
    } catch (err) {
      console.warn("[resolve] :memory write failed:", err?.message || err);
    }
  }

  // 5. Bust brief cache for all household members (+ acting user).
  try { await bustHouseholdBriefCache(householdId, userId); } catch (err) {
    console.warn("[resolve] cache bust failed:", err?.message || err);
  }

  // 6. Commons — anonymous resolution aggregation (once per real resolution).
  if (resolvedSignal && !alreadyResolved) {
    try { await writeCommonsRecord(householdId, resolvedSignal); } catch (err) {
      console.warn("[resolve] commons write failed:", err?.message || err);
    }
  }

  console.log(`[resolve] ${householdId} signal ${idStr} (${reason}) → stores: ${stores.join(", ") || "none"}`);
  return { resolved: stores.includes("signals"), signalId, stores, signal: resolvedSignal };
}
