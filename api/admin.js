// Admin endpoints — secret-gated diagnostics for ops.
//
// Routes:
//   GET /api/admin?action=quality&secret={ADMIN_SECRET}
//     Returns aggregate brief-quality metrics from the global queue +
//     a worst-offender breakdown across households.
//
// The secret comes from process.env.ADMIN_SECRET. When unset, the
// endpoint refuses all requests — defaults to closed.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function safeJson(v) {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const expected = process.env.ADMIN_SECRET;
  const provided = req.query?.secret;
  if (!expected || !provided || expected !== provided) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const action = req.query?.action || "quality";

  if (action === "quality") {
    const raw = await redis.lrange("global:briefQuality", 0, -1).catch(() => []);
    const records = (raw || []).map(safeJson).filter(Boolean);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const last24h = records.filter((r) => {
      const ms = Date.parse(r.timestamp || "");
      return !isNaN(ms) && ms >= cutoff;
    });
    const avg = (arr, key) =>
      arr.length
        ? Math.round(
            (arr.reduce((a, r) => a + (Number(r[key]) || 0), 0) / arr.length) * 10
          ) / 10
        : null;
    const byHouseholdMap = new Map();
    for (const r of last24h) {
      if (!r.householdId) continue;
      if (!byHouseholdMap.has(r.householdId)) {
        byHouseholdMap.set(r.householdId, []);
      }
      byHouseholdMap.get(r.householdId).push(r);
    }
    const byHousehold = Array.from(byHouseholdMap.entries())
      .map(([householdId, rs]) => ({
        householdId,
        avgScore: avg(rs, "score"),
        briefCount: rs.length,
        violationCount: rs.reduce((a, r) => a + (Number(r.violationCount) || 0), 0),
      }))
      .sort((a, b) => (a.avgScore || 0) - (b.avgScore || 0));

    const recentLowScores = records
      .filter((r) => Number(r.score) < 70)
      .slice(0, 10);

    return res.status(200).json({
      ok: true,
      last24h: {
        avgScore: avg(last24h, "score"),
        briefCount: last24h.length,
        violationCount: last24h.reduce(
          (a, r) => a + (Number(r.violationCount) || 0),
          0
        ),
        lowScoreCount: last24h.filter((r) => Number(r.score) < 70).length,
      },
      byHousehold,
      recentLowScores,
    });
  }

  return res.status(400).json({ error: "Unknown action" });
}
