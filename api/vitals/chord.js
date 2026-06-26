// Household harmony "chord" — a five-dimension wellness read mapped to a
// musical chord for the Vitals tab. Each dimension scores 0-100 from live
// Redis state; the average picks the chord. Best-effort throughout: a missing
// data source scores neutral rather than failing the whole read.

import { Redis } from "@upstash/redis";
import { loadHouseholdCalendar } from "../calendar-loader.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
const safeJson = (v) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } };

function dim(name, score) {
  const s = clamp(score);
  return { name, score: s, status: s >= 70 ? "harmony" : "tension" };
}

// Signals — fewer urgent/open is more harmonious.
async function scoreSignals(householdId) {
  try {
    const raw = await redis.lrange(`household:${householdId}:signals`, 0, -1);
    const sigs = (raw || []).map(safeJson).filter(Boolean);
    const active = sigs.filter((s) => !s.state || s.state === "incoming" || s.state === "active");
    const now = Date.now();
    const urgent = active.filter((s) => {
      const ms = s.eta ? Date.parse(s.eta) : NaN;
      return !isNaN(ms) && ms - now < 2 * DAY_MS && ms - now > -DAY_MS;
    });
    if (active.length === 0) return 95;
    return 100 - urgent.length * 18 - Math.max(0, active.length - 4) * 4;
  } catch { return 70; }
}

// Vault — overdue / imminent unhandled renewals create tension.
async function scoreVault(householdId) {
  try {
    const raw = await redis.lrange(`household:${householdId}:vault`, 0, -1);
    const items = (raw || []).map(safeJson).filter(Boolean).filter((v) => !v.handled && v.renewalDate);
    if (items.length === 0) return 90;
    const now = Date.now();
    let overdue = 0, imminent = 0;
    for (const v of items) {
      const ms = Date.parse(v.renewalDate);
      if (isNaN(ms)) continue;
      if (ms < now) overdue++;
      else if (ms - now < 14 * DAY_MS) imminent++;
    }
    return 100 - overdue * 16 - imminent * 5;
  } catch { return 80; }
}

// Health — from any member's connected health data (sleep + HRV ratio).
// Neutral 70 when nobody has connected a ring/watch.
async function scoreHealth(householdId) {
  try {
    const members = await redis.smembers(`household:${householdId}:members`);
    for (const uid of members || []) {
      const h = safeJson(await redis.get(`user:${uid}:health`));
      if (!h) continue;
      const sleep = h.sleep?.duration ?? null;
      const hrv = h.hrv?.current ?? null;
      const base = h.hrv?.baseline7d ?? null;
      let score = 72;
      if (sleep != null) score = sleep >= 7.5 ? 88 : sleep >= 6.5 ? 76 : sleep >= 5.5 ? 60 : 45;
      if (hrv != null && base) {
        const ratio = hrv / base;
        score = Math.round((score + (ratio >= 1 ? 88 : ratio >= 0.85 ? 70 : 50)) / 2);
      }
      return score;
    }
    return 70;
  } catch { return 70; }
}

// Calendar — density of the next 7 days. A packed week reads as tension.
async function scoreCalendar(householdId) {
  try {
    const events = await loadHouseholdCalendar(redis, householdId);
    if (!Array.isArray(events) || events.length === 0) return 78;
    const now = Date.now();
    const next7 = events.filter((e) => {
      const ms = Date.parse(e.start || e.date || "");
      return !isNaN(ms) && ms >= now && ms - now <= 7 * DAY_MS;
    });
    return 100 - Math.max(0, next7.length - 5) * 5;
  } catch { return 78; }
}

// Streak — momentum. A live resolution streak lifts harmony.
async function scoreStreak(householdId) {
  try {
    const data = safeJson(await redis.get(`household:${householdId}:streakData`));
    const streak = data?.currentStreak ?? 0;
    return 50 + Math.min(streak, 7) * 7; // 0 → 50, 7+ → 99
  } catch { return 55; }
}

function chordFor(overall) {
  if (overall >= 85) return "C_major";
  if (overall >= 70) return "G_major";
  if (overall >= 55) return "A_minor";
  if (overall >= 40) return "D_minor";
  return "diminished";
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  let householdId = req.query?.householdId;
  // Allow userId → household resolution as a convenience.
  if (!householdId && req.query?.userId) {
    householdId = (await redis.get(`user:${req.query.userId}:household`)) || req.query.userId;
  }
  if (!householdId) return res.status(400).json({ error: "householdId (or userId) required" });

  try {
    const [signals, vault, health, calendar, streak] = await Promise.all([
      scoreSignals(householdId),
      scoreVault(householdId),
      scoreHealth(householdId),
      scoreCalendar(householdId),
      scoreStreak(householdId),
    ]);
    const dimensions = [
      dim("Signals", signals),
      dim("Vault", vault),
      dim("Health", health),
      dim("Calendar", calendar),
      dim("Streak", streak),
    ];
    const overall = clamp(dimensions.reduce((a, d) => a + d.score, 0) / dimensions.length);
    return res.status(200).json({
      chord: chordFor(overall),
      dimensions,
      overall,
    });
  } catch (err) {
    console.error("[chord] failed:", err?.message || err);
    return res.status(500).json({ error: "Failed to compute chord" });
  }
}
