// Proactive Conductor moments. Run after each sync; detects a few trigger
// conditions and records moments the Conductor can surface unprompted (in the
// brief, and in the chat on open). Each moment is deduped by a stable key so a
// trigger that persists across syncs isn't re-announced every hour.
//
// Store: household:{id}:proactiveMoments (Redis list, newest-first, capped).
// Each new moment is also written to the conductor rolling log.

import { signalMovement } from "./movements.js";
import { appendConductorLog } from "./conductor-log.js";

const parse = (v) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } };
const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const MOMENTS_CAP = 30;

const isActive = (s) => !s.state || s.state === "incoming" || s.state === "active";
const stampMs = (s) => Number(s.createdAt || s.id) || Date.parse(s.lastUpdate || "") || 0;

// ISO-ish week key so weekly moments dedupe per calendar week.
function weekKey(ms) {
  const d = new Date(ms);
  const day = (d.getDay() + 6) % 7;
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  return mon.toISOString().slice(0, 10);
}

export async function generateProactiveMoments(redis, householdId, members = []) {
  const [rawSignals, rawMemory, rawExisting] = await Promise.all([
    redis.lrange(`household:${householdId}:signals`, 0, -1).catch(() => []),
    redis.lrange(`household:${householdId}:memory`, 0, -1).catch(() => []),
    redis.lrange(`household:${householdId}:proactiveMoments`, 0, MOMENTS_CAP - 1).catch(() => []),
  ]);
  const signals = (rawSignals || []).map(parse).filter(Boolean);
  const memory = (rawMemory || []).map(parse).filter(Boolean);
  const existing = (rawExisting || []).map(parse).filter(Boolean);
  const seenKeys = new Set(existing.map((m) => m.dedupeKey).filter(Boolean));

  const now = Date.now();
  const active = signals.filter(isActive);
  const candidates = [];

  // 1. Pre-trip — a travel signal departing within 72 hours.
  const parseEta = (s) => { const t = Date.parse(s.eta || ""); return isNaN(t) ? null : t; };
  const upcomingTravel = active
    .filter((s) => (s.type || "").toLowerCase() === "travel")
    .map((s) => ({ s, eta: parseEta(s) }))
    .filter((x) => x.eta && x.eta - now > 0 && x.eta - now <= 72 * HOUR_MS)
    .sort((a, b) => a.eta - b.eta);
  if (upcomingTravel.length) {
    const t = upcomingTravel[0].s;
    const hrs = Math.round((upcomingTravel[0].eta - now) / HOUR_MS);
    candidates.push({
      type: "pre_trip",
      urgency: "high",
      text: `Travel coming up in ~${hrs}h: ${t.description || "your trip"}. Worth a pre-trip check — packing, home coverage, and anything time-sensitive before you go.`,
      dedupeKey: `pre_trip:${t.id}`,
      signalId: t.id,
    });
  }

  // 2. Stale signal — active, unresolved for 7+ days. Note the oldest, once
  //    per week so it nudges without nagging every sync.
  const stale = active
    .filter((s) => { const ms = stampMs(s); return ms && now - ms >= 7 * DAY_MS; })
    .sort((a, b) => stampMs(a) - stampMs(b));
  if (stale.length) {
    const s = stale[0];
    const days = Math.floor((now - stampMs(s)) / DAY_MS);
    candidates.push({
      type: "stale_signal",
      urgency: "normal",
      text: `"${s.description || "A signal"}" has been open ${days} days without resolving — still worth a look, or it can rest in Missed Cues.`,
      dedupeKey: `stale:${s.id}:${weekKey(now)}`,
      signalId: s.id,
    });
  }

  // 3. Cross-movement conflict — travel in motion + a home service that needs
  //    someone present today (a coverage gap).
  const homeServiceToday = active.filter((s) => {
    if (signalMovement(s) !== "home") return false;
    if (!(s.type === "service" || s.status === "Out for Delivery")) return false;
    const eta = parseEta(s);
    return eta && new Date(eta).toDateString() === new Date(now).toDateString();
  });
  if (upcomingTravel.length && homeServiceToday.length) {
    candidates.push({
      type: "cross_movement",
      urgency: "high",
      text: `Coverage check: travel is in motion while ${homeServiceToday[0].description || "a home service"} needs someone present today.`,
      dedupeKey: `xmove:travel-home:${homeServiceToday[0].id}`,
      signalId: homeServiceToday[0].id,
    });
  }

  // 4. Weekly milestone — resolutions logged this calendar week.
  const wk = weekKey(now);
  const weekStartMs = Date.parse(wk + "T00:00:00") || now - 7 * DAY_MS;
  const resolvedThisWeek = memory.filter((e) => {
    if (e.action !== "resolved") return false;
    const ms = Date.parse(e.actionAt || "");
    return !isNaN(ms) && ms >= weekStartMs;
  }).length;
  if (resolvedThisWeek >= 5) {
    candidates.push({
      type: "milestone",
      urgency: "low",
      text: `${resolvedThisWeek} signals handled this week — the household's been moving steadily.`,
      dedupeKey: `milestone:resolved:${wk}`,
    });
  }

  // Persist new (non-duplicate) moments, newest-first, and log them.
  const fresh = candidates.filter((m) => m.dedupeKey && !seenKeys.has(m.dedupeKey));
  const key = `household:${householdId}:proactiveMoments`;
  let i = 0;
  for (const m of fresh) {
    const record = { id: `pm_${now}_${i++}`, createdAt: now, ...m };
    try {
      await redis.lpush(key, JSON.stringify(record));
      await appendConductorLog(redis, householdId, {
        type: "proactive", source: "sync", urgency: m.urgency, text: m.text,
        meta: { momentType: m.type, signalId: m.signalId }, _seed: i,
      });
    } catch { /* best-effort */ }
  }
  if (fresh.length) {
    try { await redis.ltrim(key, 0, MOMENTS_CAP - 1); } catch { /* best-effort */ }
  }
  return { generated: fresh.length, types: fresh.map((m) => m.type) };
}

// Pick the single most relevant moment to surface (highest urgency, newest).
export async function pickTopProactiveMoment(redis, householdId) {
  try {
    const raw = await redis.lrange(`household:${householdId}:proactiveMoments`, 0, MOMENTS_CAP - 1);
    const moments = (raw || []).map(parse).filter(Boolean);
    if (!moments.length) return null;
    const rank = { high: 0, normal: 1, low: 2 };
    moments.sort((a, b) => (rank[a.urgency] ?? 1) - (rank[b.urgency] ?? 1) || (b.createdAt || 0) - (a.createdAt || 0));
    return moments[0];
  } catch {
    return null;
  }
}
