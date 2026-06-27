// Movement intelligence — the four life "movements" (home / work / family /
// wellness) and the per-movement pattern profiles the brief and the
// /api/movement endpoint read. Single source of truth for movement
// attribution so import.js, sync.js, brief.js, and movement.js all agree.

import { loadHouseholdCalendar } from "./calendar-loader.js";

export const MOVEMENTS = ["home", "work", "family", "wellness"];
// Movement name <-> pillar key (pillars are the brief's internal ranking keys).
export const MOVEMENT_TO_PILLAR = { home: "house", work: "work", family: "kids", wellness: "health" };
export const PILLAR_TO_MOVEMENT = { house: "home", work: "work", kids: "family", health: "wellness" };

// Attribute a signal to its movement. Prefers a stored `movement` field
// (stamped at import) and otherwise derives it. Rules (first match wins):
//   wellness: health/medical, or a doctor-context appointment
//   work:     financial, or a work-tagged calendar block
//   family:   attributed to a crew member, or a milestone/reminder
//   home:     everything else (default)
export function signalMovement(signal) {
  if (signal?.movement && MOVEMENTS.includes(signal.movement)) return signal.movement;
  const t = (signal?.type || "").toLowerCase();
  const d = (signal?.description || "").toLowerCase();
  if (t === "health" || t === "medical") return "wellness";
  if (
    t === "appointment" &&
    /\b(doctor|dr\.?|clinic|dentist|dental|pediatric|pediatrician|physical|medical|checkup|check-up|optometr|dermatolog|cardiolog)\b/.test(d)
  ) return "wellness";
  if (t === "financial" || t === "work" || signal?.workConflictCheck === true) return "work";
  if (signal?.crewMemberId) return "family";
  if (t === "milestone" || t === "reminder") return "family";
  return "home";
}

const parse = (v) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } };
const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function topCounts(items, keyFn, n = 5) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (k == null || k === "") continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, count }));
}

function isActive(s) {
  return !s.state || s.state === "incoming" || s.state === "active";
}

// Average resolution latency (hours) across resolved memory entries.
function avgResolutionHours(memEntries) {
  let sum = 0, n = 0;
  for (const e of memEntries) {
    if (e.action !== "resolved") continue;
    const importMs = typeof e.signalId === "number" ? e.signalId : NaN;
    const actionMs = Date.parse(e.actionAt || "");
    if (!isNaN(importMs) && !isNaN(actionMs) && actionMs >= importMs) {
      sum += (actionMs - importMs) / HOUR_MS;
      n += 1;
    }
  }
  return n ? Math.round(sum / n) : null;
}

function stampMs(s) {
  return Number(s.createdAt || s.id) || Date.parse(s.lastUpdate || "") || 0;
}

// MM-DD anchor → days until its next occurrence (year-rolling). Used for
// upcoming birthdays/anniversaries.
function daysUntilAnchor(raw, now) {
  if (!raw || typeof raw !== "string") return null;
  let mm, dd, m;
  if ((m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/))) { mm = +m[2]; dd = +m[3]; }
  else if ((m = raw.match(/^(\d{1,2})-(\d{1,2})(?:-(\d{2,4}))?$/))) { mm = +m[1]; dd = +m[2]; }
  else return null;
  if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return null;
  const today = new Date(now);
  const todayUTC = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  let cand = Date.UTC(today.getFullYear(), mm - 1, dd);
  if (cand < todayUTC) cand = Date.UTC(today.getFullYear() + 1, mm - 1, dd);
  return Math.round((cand - todayUTC) / DAY_MS);
}

// Compute + store the four movement pattern profiles for a household. Called
// from the sync sweep after imports/calendar/oura have refreshed. Best-effort:
// missing data yields null/empty fields, never a throw.
export async function computeMovementPatterns(redis, householdId, members = []) {
  const [rawSignals, rawMemory, rawCrew, rawProviders] = await Promise.all([
    redis.lrange(`household:${householdId}:signals`, 0, -1).catch(() => []),
    redis.lrange(`household:${householdId}:memory`, 0, -1).catch(() => []),
    redis.get(`household:${householdId}:crew`).catch(() => null),
    redis.hgetall(`household:${householdId}:providers`).catch(() => ({})),
  ]);
  const signals = (rawSignals || []).map(parse).filter(Boolean);
  const memory = (rawMemory || []).map(parse).filter(Boolean);
  const crewParsed = parse(rawCrew);
  const crew = Array.isArray(crewParsed) ? crewParsed : (Array.isArray(crewParsed?.members) ? crewParsed.members : []);
  let calendar = [];
  try { const c = await loadHouseholdCalendar(redis, householdId); calendar = Array.isArray(c) ? c : []; } catch { /* none */ }

  const healthByUser = {};
  for (const uid of members) {
    try { const h = parse(await redis.get(`user:${uid}:health`)); if (h) healthByUser[uid] = h; } catch { /* skip */ }
  }

  const now = Date.now();
  const byMovement = { home: [], work: [], family: [], wellness: [] };
  for (const s of signals) { const mv = signalMovement(s); (byMovement[mv] || byMovement.home).push(s); }
  const memByMovement = { home: [], work: [], family: [], wellness: [] };
  for (const e of memory) { const mv = signalMovement(e); (memByMovement[mv] || memByMovement.home).push(e); }

  const monthHist = (arr) => topCounts(arr.filter((s) => stampMs(s)), (s) => MONTHS[new Date(stampMs(s)).getMonth()], 12);
  const weekdayHist = (arr, dateFn) => topCounts(arr.map(dateFn).filter((d) => d && !isNaN(d.getTime())), (d) => WEEKDAYS[d.getDay()], 7);

  // ---- HOME ----
  const providerNames = [];
  if (rawProviders && typeof rawProviders === "object") {
    for (const v of Object.values(rawProviders)) {
      const p = parse(v);
      if (p?.name) providerNames.push(p.name);
    }
  }
  const home = {
    activeCount: byMovement.home.filter(isActive).length,
    commonTypes: topCounts(byMovement.home, (s) => (s.type || "unknown"), 5),
    avgResolutionHours: avgResolutionHours(memByMovement.home),
    busiestMonths: monthHist(byMovement.home).slice(0, 3),
    topProviders: providerNames.length
      ? providerNames.slice(0, 5)
      : topCounts(byMovement.home.filter((s) => s.type === "service"), (s) => s.sender, 5).map((x) => x.key),
  };

  // ---- WORK ----
  const workBlocks = calendar.filter((e) => e && (e.type === "work" || e.workConflictCheck === true));
  const blockStart = (e) => { const t = Date.parse(e.start || ""); return isNaN(t) ? null : new Date(t); };
  const startHours = workBlocks.map(blockStart).filter(Boolean).map((d) => d.getHours());
  const hourHist = topCounts(startHours.map((h) => ({ h })), (x) => x.h, 1);
  const peakStartHour = hourHist.length ? hourHist[0].key : null;
  // load by ISO-ish week (last 8 weeks): bucket by Monday-of-week date string.
  const weekKey = (ms) => {
    const d = new Date(ms); const day = (d.getDay() + 6) % 7;
    const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
    return mon.toISOString().slice(0, 10);
  };
  const loadByWeekMap = {};
  for (const s of byMovement.work) { const ms = stampMs(s); if (ms && now - ms < 8 * 7 * DAY_MS) { const k = weekKey(ms); loadByWeekMap[k] = (loadByWeekMap[k] || 0) + 1; } }
  const travelSignals = signals.filter((s) => (s.type || "").toLowerCase() === "travel");
  const work = {
    activeCount: byMovement.work.filter(isActive).length,
    busiestMeetingDays: weekdayHist(workBlocks, blockStart).slice(0, 3),
    peakWindow: peakStartHour != null ? `${peakStartHour}:00–${(peakStartHour + 2) % 24}:00` : null,
    travelFrequencyPer90d: travelSignals.filter((s) => { const ms = stampMs(s); return ms && now - ms < 90 * DAY_MS; }).length,
    loadByWeek: loadByWeekMap,
  };

  // ---- FAMILY ----
  const handlersByUser = {};
  for (const e of memByMovement.family) {
    if (e.action !== "resolved") continue;
    const uid = e.resolvedBy || e.userId;
    if (uid && uid !== "system" && uid !== "status-update") handlersByUser[uid] = (handlersByUser[uid] || 0) + 1;
  }
  const upcomingOccasions = [];
  for (const m of crew) {
    for (const occ of ["birthday", "anniversary"]) {
      const days = daysUntilAnchor(m?.[occ], now);
      if (days != null && days >= 0 && days <= 90) upcomingOccasions.push({ name: m.name || "Someone", occasion: occ, inDays: days });
    }
  }
  upcomingOccasions.sort((a, b) => a.inDays - b.inDays);
  const family = {
    activeCount: byMovement.family.filter(isActive).length,
    handlersByUser,
    busiestDays: weekdayHist(byMovement.family, (s) => { const ms = stampMs(s); return ms ? new Date(ms) : null; }).slice(0, 3),
    upcomingOccasions: upcomingOccasions.slice(0, 8),
    crewActivity: topCounts(byMovement.family, (s) => s.crewMemberId, 8),
  };

  // ---- WELLNESS ----
  // Accumulate sleep-by-weekday over time (we don't store raw history): read
  // the prior accumulator, fold in any fresh reading dated today, re-average.
  const priorWellness = parse(await redis.get(`household:${householdId}:movement:wellness:patterns`).catch(() => null)) || {};
  const sleepAcc = (priorWellness._sleepAcc && typeof priorWellness._sleepAcc === "object") ? priorWellness._sleepAcc : {};
  let hrvBaseline = null, hrvCurrent = null;
  for (const uid of members) {
    const h = healthByUser[uid];
    if (!h) continue;
    if (h.hrv?.baseline7d != null && hrvBaseline == null) hrvBaseline = h.hrv.baseline7d;
    if (h.hrv?.current != null && hrvCurrent == null) hrvCurrent = h.hrv.current;
    const dur = h.sleep?.duration;
    const asOf = h.asOf || h.receivedAt;
    if (typeof dur === "number" && dur > 0 && asOf && now - asOf < 20 * HOUR_MS) {
      const wd = WEEKDAYS[new Date(asOf).getDay()];
      const cur = sleepAcc[wd] || { sum: 0, n: 0 };
      // Only fold one reading per weekday per day — guard with lastDate.
      const dayStr = new Date(asOf).toISOString().slice(0, 10);
      if (cur.lastDate !== dayStr) { cur.sum += dur; cur.n += 1; cur.lastDate = dayStr; sleepAcc[wd] = cur; }
    }
  }
  const sleepByWeekday = {};
  for (const wd of WEEKDAYS) { const a = sleepAcc[wd]; if (a && a.n) sleepByWeekday[wd] = +(a.sum / a.n).toFixed(1); }
  const hrvTrend = (hrvCurrent != null && hrvBaseline) ? (hrvCurrent >= hrvBaseline * 1.03 ? "up" : hrvCurrent <= hrvBaseline * 0.97 ? "down" : "steady") : null;
  const wellness = {
    activeCount: byMovement.wellness.filter(isActive).length,
    sleepByWeekday,
    hrvBaseline,
    hrvTrend,
    medicalApptFrequencyPer90d: byMovement.wellness.filter((s) => { const ms = stampMs(s); return ms && now - ms < 90 * DAY_MS; }).length,
    signalTypes: topCounts(byMovement.wellness, (s) => (s.type || "unknown"), 5),
    _sleepAcc: sleepAcc,
  };

  const patterns = { home, work, family, wellness };
  for (const mv of MOVEMENTS) {
    patterns[mv].computedAt = now;
    try { await redis.set(`household:${householdId}:movement:${mv}:patterns`, JSON.stringify(patterns[mv])); } catch { /* best-effort */ }
  }
  return patterns;
}

// Read the four stored pattern profiles. Returns { home, work, family,
// wellness } with {} for any movement not yet computed.
export async function loadMovementPatterns(redis, householdId) {
  const out = {};
  await Promise.all(MOVEMENTS.map(async (mv) => {
    try { out[mv] = parse(await redis.get(`household:${householdId}:movement:${mv}:patterns`)) || {}; }
    catch { out[mv] = {}; }
  }));
  return out;
}

// One-line human summary of a movement's patterns for the brief prompt.
export function summarizeMovementPatterns(movement, p) {
  if (!p || typeof p !== "object") return "no data yet";
  const bits = [];
  if (movement === "home") {
    if (p.commonTypes?.length) bits.push(`common: ${p.commonTypes.slice(0, 3).map((t) => t.key).join("/")}`);
    if (p.busiestMonths?.length) bits.push(`busiest months: ${p.busiestMonths.map((m) => m.key).join(", ")}`);
    if (p.avgResolutionHours != null) bits.push(`avg resolution ${p.avgResolutionHours}h`);
    if (p.topProviders?.length) bits.push(`providers: ${p.topProviders.slice(0, 3).join(", ")}`);
  } else if (movement === "work") {
    if (p.busiestMeetingDays?.length) bits.push(`busiest meeting day: ${p.busiestMeetingDays[0].key}`);
    if (p.peakWindow) bits.push(`peak window ${p.peakWindow}`);
    if (p.travelFrequencyPer90d != null) bits.push(`${p.travelFrequencyPer90d} trips/90d`);
    const weeks = p.loadByWeek ? Object.values(p.loadByWeek) : [];
    if (weeks.length) bits.push(`~${Math.round(weeks.reduce((a, b) => a + b, 0) / weeks.length)} work signals/wk`);
  } else if (movement === "family") {
    if (p.busiestDays?.length) bits.push(`busiest day: ${p.busiestDays[0].key}`);
    if (p.upcomingOccasions?.length) { const o = p.upcomingOccasions[0]; bits.push(`upcoming: ${o.name}'s ${o.occasion} in ${o.inDays}d`); }
    if (p.crewActivity?.length) bits.push(`most active: ${p.crewActivity[0].key}`);
  } else if (movement === "wellness") {
    const days = p.sleepByWeekday ? Object.values(p.sleepByWeekday) : [];
    if (days.length) bits.push(`avg sleep ~${(days.reduce((a, b) => a + b, 0) / days.length).toFixed(1)}h`);
    if (p.hrvBaseline != null) bits.push(`HRV baseline ${p.hrvBaseline}${p.hrvTrend ? ` (${p.hrvTrend})` : ""}`);
    if (p.medicalApptFrequencyPer90d) bits.push(`${p.medicalApptFrequencyPer90d} medical/90d`);
  }
  return bits.length ? bits.join("; ") : "no notable patterns yet";
}
