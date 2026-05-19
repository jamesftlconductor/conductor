// Ring webhook receiver. Ring POSTs events here when motion is
// detected or the doorbell is pressed. Expected body shape (per
// Ring's developer docs):
//   { kind, doorbell_id, created_at, answered, user_id? }
//
// `kind` is one of "motion" / "ding" / "on_demand" / etc.
//
// Routing:
//   - motion: look for an active delivery signal that ETAs within
//     the next 2 hours. If one exists, write a 'delivery_detected'
//     note onto it (lastUpdate + ringDetectedAt) and push a
//     "Motion at your front door — your {sender} delivery?"
//     notification. Otherwise the motion is logged and dropped.
//   - ding:   look for any active delivery signal in the next 24h.
//     If one exists, push "Doorbell — expecting a delivery from
//     {sender}". Otherwise dropped silently.
//
// Mapping doorbell_id → userId is provider-owned: Ring's events
// reference a doorbell id but not necessarily a Conductor userId.
// We resolve via a Redis hash ring:doorbell:{doorbell_id} -> userId
// that's populated during the OAuth callback (TODO when we have
// real partner credentials — for now the events handler falls back
// to req.body.userId for testing).

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

async function resolveUserIdForDoorbell(doorbellId, fallbackUserId) {
  if (fallbackUserId) return fallbackUserId;
  if (!doorbellId) return null;
  const userId = await redis.get(`ring:doorbell:${doorbellId}`);
  return userId || null;
}

async function findActiveDeliverySignals(householdId, withinMs) {
  const raw = await redis.lrange(`household:${householdId}:signals`, 0, 199);
  const now = Date.now();
  const out = [];
  for (const r of raw || []) {
    let parsed;
    try { parsed = typeof r === "string" ? JSON.parse(r) : r; } catch { continue; }
    if (!parsed) continue;
    if (parsed.type !== "package" && parsed.type !== "delivery") continue;
    if (parsed.state && parsed.state !== "incoming" && parsed.state !== "active") continue;
    if (parsed.eta) {
      const ms = Date.parse(parsed.eta);
      if (!isNaN(ms) && ms - now > withinMs) continue;
    }
    out.push(parsed);
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed for ring events" });
  }
  const body = req.body || {};
  const { kind, doorbell_id: doorbellId, created_at: createdAt, answered, userId: bodyUserId } = body;
  if (!kind) return res.status(400).json({ error: "kind required" });

  const userId = await resolveUserIdForDoorbell(doorbellId, bodyUserId);
  if (!userId) {
    console.log(`[ring] event ${kind} dropped — no userId for doorbell ${doorbellId}`);
    return res.status(200).json({ ok: true, dropped: "no userId" });
  }
  const householdId = (await redis.get(`user:${userId}:household`)) || userId;

  if (kind === "motion") {
    const candidates = await findActiveDeliverySignals(householdId, TWO_HOURS_MS);
    if (candidates.length === 0) {
      console.log(`[ring] motion at ${doorbellId} — no matching delivery`);
      return res.status(200).json({ ok: true, matched: 0 });
    }
    // Pick the closest-ETA candidate. Stamp ringDetectedAt + a
    // lightweight note onto it. The next brief will see the note;
    // notify.js handles the push separately.
    candidates.sort((a, b) => {
      const aMs = a.eta ? Date.parse(a.eta) : 0;
      const bMs = b.eta ? Date.parse(b.eta) : 0;
      return aMs - bMs;
    });
    const target = candidates[0];
    const signalsKey = `household:${householdId}:signals`;
    const raw = await redis.lrange(signalsKey, 0, -1);
    for (let i = 0; i < raw.length; i++) {
      let parsed;
      try { parsed = typeof raw[i] === "string" ? JSON.parse(raw[i]) : raw[i]; } catch { continue; }
      if (!parsed || parsed.id !== target.id) continue;
      parsed.ringDetectedAt = createdAt || new Date().toISOString();
      parsed.lastUpdate = new Date().toLocaleString();
      // Soft note rather than full state change — the user still
      // needs to confirm receipt. notify.js can use this as a
      // trigger for an "is this your delivery?" push.
      parsed.note = `Motion detected at front door (${parsed.ringDetectedAt})`;
      await redis.lset(signalsKey, i, JSON.stringify(parsed));
      console.log(`[ring] motion matched delivery ${target.id} (${target.sender})`);
      break;
    }
    return res.status(200).json({ ok: true, matched: 1, signalId: target.id });
  }

  if (kind === "ding") {
    const candidates = await findActiveDeliverySignals(householdId, DAY_MS);
    if (candidates.length === 0) {
      return res.status(200).json({ ok: true, matched: 0 });
    }
    // Notify path (best-effort). The notify.js endpoint accepts a
    // userId + custom payload — when notify support lands, swap
    // the console.log for a real push fan-out call.
    console.log(
      `[ring] ding at ${doorbellId} — expecting ${candidates.length} deliver${candidates.length === 1 ? 'y' : 'ies'}`
    );
    return res.status(200).json({ ok: true, matched: candidates.length, answered: !!answered });
  }

  // Other event kinds (on_demand, live_view, etc.) are accepted
  // and logged but not actioned in v1.
  console.log(`[ring] event ${kind} accepted but not actioned`);
  return res.status(200).json({ ok: true, ignored: kind });
}
