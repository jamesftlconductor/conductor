// Red Alert — household-wide critical-event surface. POST creates an
// alert that lives at household:{id}:activeAlert (24h TTL). GET
// returns it for the current user unless they've dismissed it; DELETE
// adds the user to the dismissedBy list (per-user dismissal, not
// household-wide, so a partner who hasn't seen the overlay still gets
// it).
//
// Brief.js intercepts on the same redis key — when an active alert is
// present, the brief is overridden with a single-line RED ALERT
// notice. The mobile root layout also polls /api/alert?action=active
// and renders a fullscreen modal overlay.
//
// Triggers (sources that may POST here):
//   - api/import.js     financial anomalies > $500
//   - api/sync.js       NWS severe/extreme weather alerts
//   - manual            household member trigger (future surface)

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ALERT_TTL_S = 86400; // 24h

async function resolveHouseholdId(userId) {
  if (!userId) return null;
  const hid = await redis.get(`user:${userId}:household`);
  return hid || "RangerOaks925";
}

function safeJson(v) {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
}

// Tiny non-cryptographic id — Vercel's Node may or may not expose
// crypto.randomUUID depending on runtime. This is collision-safe for
// a per-household 24h-lived alert surface.
function alertId() {
  return `alert-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default async function handler(req, res) {
  try {
    if (req.method === "POST") {
      const { householdId, alertType, description, severity, source } = req.body || {};
      if (!householdId || !description) {
        return res.status(400).json({ error: "householdId and description required" });
      }
      const alert = {
        id: alertId(),
        householdId,
        alertType: alertType || "GENERIC",
        description: String(description).slice(0, 400),
        severity: severity || "red",
        source: source || "unknown",
        createdAt: new Date().toISOString(),
        dismissedBy: [],
      };
      await redis.set(
        `household:${householdId}:activeAlert`,
        JSON.stringify(alert),
        { ex: ALERT_TTL_S }
      );
      return res.status(201).json({ alert, success: true });
    }

    if (req.method === "GET" && req.query?.action === "active") {
      const { userId } = req.query;
      if (!userId) return res.status(400).json({ error: "userId required" });
      const householdId = await resolveHouseholdId(userId);
      if (!householdId) return res.status(200).json({ active: false });

      const raw = await redis.get(`household:${householdId}:activeAlert`);
      if (!raw) return res.status(200).json({ active: false });
      const alert = safeJson(raw);
      if (!alert) return res.status(200).json({ active: false });

      // Per-user dismissal — a household member who already tapped
      // "I'm aware" stops seeing the overlay, but the alert itself
      // remains active for anyone else in the household.
      if (Array.isArray(alert.dismissedBy) && alert.dismissedBy.includes(userId)) {
        return res.status(200).json({ active: false });
      }
      return res.status(200).json({ active: true, alert });
    }

    if (req.method === "DELETE") {
      const { householdId, alertId: targetId, userId } = req.body || {};
      if (!householdId || !userId) {
        return res.status(400).json({ error: "householdId and userId required" });
      }
      const raw = await redis.get(`household:${householdId}:activeAlert`);
      if (!raw) return res.status(200).json({ success: true });
      const alert = safeJson(raw);
      if (!alert) return res.status(200).json({ success: true });
      // Tolerant of mismatched id — if the caller's alertId is stale
      // because a newer alert replaced it, the dismissal is no-op (we
      // don't want to clear the newer alert's dismissedBy on
      // someone else's behalf).
      if (targetId && alert.id !== targetId) return res.status(200).json({ success: true });
      alert.dismissedBy = Array.from(new Set([...(alert.dismissedBy || []), userId]));
      await redis.set(
        `household:${householdId}:activeAlert`,
        JSON.stringify(alert),
        { ex: ALERT_TTL_S }
      );
      return res.status(200).json({ success: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[alert] handler error:", err?.message || err);
    return res.status(500).json({ error: "alert failed" });
  }
}

// Exported for direct in-process use from other API handlers
// (api/import.js financial anomalies, api/sync.js NWS triggers).
// Same shape as POST body. Returns the persisted alert.
export async function postAlert({ householdId, alertType, description, severity, source }) {
  if (!householdId || !description) return null;
  const alert = {
    id: alertId(),
    householdId,
    alertType: alertType || "GENERIC",
    description: String(description).slice(0, 400),
    severity: severity || "red",
    source: source || "unknown",
    createdAt: new Date().toISOString(),
    dismissedBy: [],
  };
  await redis.set(
    `household:${householdId}:activeAlert`,
    JSON.stringify(alert),
    { ex: ALERT_TTL_S }
  );
  return alert;
}

export async function getActiveAlert(householdId) {
  if (!householdId) return null;
  const raw = await redis.get(`household:${householdId}:activeAlert`);
  if (!raw) return null;
  return safeJson(raw);
}
