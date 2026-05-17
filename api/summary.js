// Shareable summary endpoint.
//
// GET /api/summary?userId={userId}&period=week|month
//
// Compiles a flat stats payload for the mobile "summary card" screen,
// which renders these numbers into a screenshot-friendly card and
// hands them to the native share sheet. Period is rolling from now —
// week = last 7 days, month = last 30 days.

import { Redis } from "@upstash/redis";
import { loadRecentCaughtMoments } from "./signals.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DAY_MS = 24 * 60 * 60 * 1000;

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

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { userId, period } = req.query || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  const periodKey = period === "month" ? "month" : "week";
  const windowMs = (periodKey === "month" ? 30 : 7) * DAY_MS;

  const householdId = await resolveHouseholdId(userId);
  if (!householdId) return res.status(400).json({ error: "no household" });

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - windowMs);
  const startMs = startDate.getTime();

  // Pull memory + streak + caught moments + vault in parallel.
  const [rawMemory, rawStreak, rawName, caughtMoments] = await Promise.all([
    redis.lrange(`household:${householdId}:memory`, 0, -1).catch(() => []),
    redis.get(`household:${householdId}:streakData`).catch(() => null),
    redis.get(`household:${householdId}:name`).catch(() => null),
    loadRecentCaughtMoments(householdId, periodKey === "month" ? 30 : 7).catch(() => []),
  ]);
  const memory = (rawMemory || []).map(safeJson).filter(Boolean);
  const streak = safeJson(rawStreak) || {};
  const householdName =
    (typeof rawName === "string" && rawName) || householdId;

  // Filter memory to the period window.
  const inWindow = memory.filter((e) => {
    const ms = Date.parse(e?.actionAt || "");
    return !isNaN(ms) && ms >= startMs && ms <= endDate.getTime();
  });

  let signalsRested = 0;
  let signalsLapsed = 0;
  let deadlinesCaught = 0;
  let birthdaysRemembered = 0;
  for (const e of inWindow) {
    if (e.action === "resolved") {
      signalsRested++;
      if (e.type === "deadline") deadlinesCaught++;
      const isBirthday =
        e.type === "birthday" ||
        /birthday|anniversary/i.test(String(e.description || ""));
      if (isBirthday) birthdaysRemembered++;
    } else if (e.action === "expired" || e.action === "lapsed") {
      signalsLapsed++;
    }
  }

  // Top caught moment within the period — smallest daysBeforeExpiry
  // wins, mirroring the Week in Review pick logic.
  const inWindowCaught = (caughtMoments || []).filter((c) => {
    const ms = Date.parse(c?.resolvedAt || "");
    return !isNaN(ms) && ms >= startMs && ms <= endDate.getTime();
  });
  let topCaughtMoment = null;
  if (inWindowCaught.length > 0) {
    const top = inWindowCaught
      .slice()
      .sort((a, b) => (a.daysBeforeExpiry ?? 99) - (b.daysBeforeExpiry ?? 99))[0];
    topCaughtMoment = top
      ? {
          description: top.description,
          daysBeforeExpiry: top.daysBeforeExpiry,
        }
      : null;
  }

  return res.status(200).json({
    period: periodKey,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    signalsRested,
    signalsLapsed,
    deadlinesCaught,
    birthdaysRemembered,
    currentStreak: streak.currentStreak || 0,
    longestStreak: streak.longestStreak || 0,
    totalResolved: streak.totalResolved || 0,
    topCaughtMoment,
    householdName,
    generatedAt: new Date().toISOString(),
  });
}
