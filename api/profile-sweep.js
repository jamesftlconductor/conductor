// First-use profile auto-population. Runs once, right after the exhaustive
// vault sweep completes during onboarding, and fills movement profile fields
// from data the household already has — so the interview only ever asks about
// what couldn't be inferred.
//
// Everything is best-effort: a failure in any movement leaves that movement's
// fields empty (and therefore still interview-eligible) rather than throwing.

import { loadHouseholdCalendar } from "./calendar-loader.js";

const parse = (v) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } };
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// The fields each movement profile tracks — drives the completeness score.
const PROFILE_FIELDS = {
  home: ["housingOwnership", "homeType", "homeBuiltEra", "homeSystemsToWatch"],
  work: ["workHoursInferred", "workBusiestDay", "workContextInferred"],
  family: ["crewConfigured", "schoolNames", "doctorNames"],
  wellness: ["healthKitConnected", "medicationReminders"],
};

function eraFromYear(year) {
  const y = Number(year);
  if (!y || isNaN(y)) return null;
  if (y < 1950) return "pre-1950";
  if (y < 1980) return "1950s–70s";
  if (y < 2000) return "1980s–90s";
  if (y < 2016) return "2000s–2010s";
  return "2016+";
}

// ---- ATTOM property lookup -------------------------------------------------
// Gated on ATTOM_API_KEY + an available street address. Stores the raw-ish
// profile at household:{id}:propertyProfile and returns it (or null).
async function attomPropertyLookup(redis, householdId, streetAddress, cityState) {
  if (!process.env.ATTOM_API_KEY || !streetAddress) return null;
  try {
    const url =
      "https://api.gateway.attomdata.com/propertyapi/v1.0.0/property/detail?" +
      `address1=${encodeURIComponent(streetAddress)}&address2=${encodeURIComponent(cityState || "")}`;
    const resp = await fetch(url, {
      headers: { Accept: "application/json", apikey: process.env.ATTOM_API_KEY },
    });
    if (!resp.ok) {
      console.warn(`[profile-sweep] ATTOM ${resp.status} for ${householdId}`);
      return null;
    }
    const data = await resp.json();
    const prop = data?.property?.[0];
    if (!prop) return null;
    const profile = {
      yearBuilt: prop.summary?.yearbuilt ?? prop.building?.summary?.yearbuilt ?? null,
      propertyType: prop.summary?.proptype ?? prop.summary?.propclass ?? null,
      lotSize: prop.lot?.lotsize1 ?? prop.lot?.lotsize2 ?? null,
      pool: prop.lot?.pooltype ? prop.lot.pooltype !== "NO POOL" : (prop.building?.interior?.haspool ?? null),
      garage: prop.building?.parking?.prkgSize ?? prop.building?.parking?.garagetype ?? null,
      sourcedAt: new Date().toISOString(),
    };
    await redis.set(`household:${householdId}:propertyProfile`, JSON.stringify(profile));
    console.log(`[profile-sweep] ATTOM stored for ${householdId}: built=${profile.yearBuilt} type=${profile.propertyType}`);
    return profile;
  } catch (err) {
    console.warn("[profile-sweep] ATTOM lookup failed:", err?.message || err);
    return null;
  }
}

export async function runProfileExtraction(redis, userId, householdId) {
  const updates = {};      // preference key -> value
  const sources = {};      // preference key -> 'sweep' | 'attom'
  const set = (key, val, src = "sweep") => {
    if (val == null || (Array.isArray(val) && val.length === 0)) return;
    updates[key] = val;
    sources[key] = src;
  };

  const [rawSignals, rawVault, rawCrew, rawHealth, rawLoc] = await Promise.all([
    redis.lrange(`household:${householdId}:signals`, 0, -1).catch(() => []),
    redis.lrange(`household:${householdId}:vault`, 0, -1).catch(() => []),
    redis.get(`household:${householdId}:crew`).catch(() => null),
    redis.get(`user:${userId}:health`).catch(() => null),
    redis.get(`household:${householdId}:location`).catch(() => null),
  ]);
  const signals = (rawSignals || []).map(parse).filter(Boolean);
  const vault = (rawVault || []).map(parse).filter(Boolean);
  const crewParsed = parse(rawCrew);
  const crew = Array.isArray(crewParsed) ? crewParsed : (Array.isArray(crewParsed?.members) ? crewParsed.members : []);
  const health = parse(rawHealth);
  const loc = parse(rawLoc);
  const corpus = [...signals, ...vault];
  const hay = (o) => `${o.description || ""} ${o.sender || ""} ${o.type || ""} ${o.category || ""} ${o.notes || ""}`.toLowerCase();
  const allText = corpus.map(hay);

  // ===== 5. ATTOM (run first — feeds Home fields) =====
  let property = null;
  try {
    // Street address: a lease/vault item address, or a stored household address.
    const leaseWithAddr = vault.find((v) => v.address) || signals.find((s) => s.leaseAddress);
    const streetAddress = leaseWithAddr?.address || leaseWithAddr?.leaseAddress || null;
    const cityState = loc ? [loc.city, loc.state].filter(Boolean).join(", ") : null;
    property = await attomPropertyLookup(redis, householdId, streetAddress, cityState);
  } catch { /* skip */ }

  // ===== 1. HOME =====
  try {
    const text = allText.join(" ");
    if (/\bmortgage\b|\bescrow\b|\bhomeowners?\s+insurance\b/.test(text)) set("housingOwnership", "own");
    else if (/\blease\b|\brent\b|\brenter'?s?\s+insurance\b|\blandlord\b/.test(text)) set("housingOwnership", "rent");

    if (property?.propertyType) {
      const pt = String(property.propertyType).toLowerCase();
      set("homeType", /condo/.test(pt) ? "condo" : /apartment|apt/.test(pt) ? "apartment" : /town/.test(pt) ? "townhouse" : "house", "attom");
    } else if (/\bcondo\b/.test(text)) set("homeType", "condo");
    else if (/\bapartment\b|\bapt\b/.test(text)) set("homeType", "apartment");
    else if (/\btownhouse\b|\btownhome\b/.test(text)) set("homeType", "house");

    const era = eraFromYear(property?.yearBuilt);
    if (era) set("homeBuiltEra", era, "attom");

    const systems = new Set();
    for (const t of allText) {
      if (/\bhvac\b|\bair condition|\bfurnace\b|\bheat pump\b|\bac unit\b/.test(t)) systems.add("HVAC");
      if (/\broof|\bgutter/.test(t)) systems.add("roof");
      if (/\bplumb|\bwater heater\b|\bdrain\b|\bsump pump\b/.test(t)) systems.add("plumbing");
      if (/\bpool\b/.test(t)) systems.add("pool");
    }
    if (property?.pool === true) systems.add("pool");
    if (systems.size) set("homeSystemsToWatch", [...systems]);
  } catch (err) { console.warn("[profile-sweep] home extract failed:", err?.message || err); }

  // ===== 2. WORK =====
  try {
    let calendar = [];
    try { const c = await loadHouseholdCalendar(redis, householdId); calendar = Array.isArray(c) ? c : []; } catch { /* none */ }
    const workBlocks = calendar.filter((e) => e && (e.userId === userId) && (e.type === "work" || e.workConflictCheck === true));
    const startHours = [];
    const dayCounts = {};
    for (const e of workBlocks) {
      const t = Date.parse(e.start || "");
      if (isNaN(t)) continue;
      const d = new Date(t);
      startHours.push(d.getHours());
      const wd = WEEKDAYS[d.getDay()];
      dayCounts[wd] = (dayCounts[wd] || 0) + 1;
    }
    if (startHours.length) {
      const hourCounts = {};
      for (const h of startHours) hourCounts[h] = (hourCounts[h] || 0) + 1;
      const topHour = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0];
      if (topHour) set("workHoursInferred", `${topHour[0]}:00`);
    }
    const busiest = Object.entries(dayCounts).sort((a, b) => b[1] - a[1])[0];
    if (busiest) set("workBusiestDay", busiest[0]);

    // Work context from a non-consumer email domain on the profile.
    const profile = parse(await redis.get(`user:${userId}:profile`).catch(() => null));
    const email = profile?.email || "";
    const domain = email.includes("@") ? email.split("@")[1].toLowerCase() : "";
    const consumer = new Set(["gmail.com", "icloud.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com", "me.com", "proton.me"]);
    if (domain && !consumer.has(domain)) set("workContextInferred", `works at ${domain}`);
  } catch (err) { console.warn("[profile-sweep] work extract failed:", err?.message || err); }

  // ===== 3. FAMILY =====
  try {
    if (crew.length) set("crewConfigured", true);
    // School names — signals tagged school, or school-keyword senders.
    const schoolNames = new Set();
    for (const s of signals) {
      const t = (s.type || "").toLowerCase();
      const h = hay(s);
      if (t === "school" || /\b(elementary|middle school|high school|academy|montessori|preschool|pre-k|isd|school district)\b/.test(h)) {
        const name = (s.sender || s.description || "").split(/[-–|:]/)[0].trim();
        if (name && name.length <= 60) schoolNames.add(name);
      }
    }
    if (schoolNames.size) set("schoolNames", [...schoolNames].slice(0, 6));
    // Doctor names — appointment/medical signals with a Dr. / clinic marker.
    const doctorNames = new Set();
    for (const s of signals) {
      const h = hay(s);
      const m = (s.description || "").match(/\bDr\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/);
      if (m) doctorNames.add(m[0].trim());
      else if (/\b(clinic|pediatric|dentist|dermatolog|cardiolog|orthodont)\b/.test(h)) {
        const name = (s.sender || "").trim();
        if (name && name.length <= 60) doctorNames.add(name);
      }
    }
    if (doctorNames.size) set("doctorNames", [...doctorNames].slice(0, 8));
  } catch (err) { console.warn("[profile-sweep] family extract failed:", err?.message || err); }

  // ===== 4. WELLNESS =====
  try {
    if (health && (health.sleep || health.hrv || health.oura || health.restingHR != null)) {
      set("healthKitConnected", true);
    }
    const meds = new Set();
    for (const item of corpus) {
      const h = hay(item);
      if (/\b(prescription|medication|refill|pharmacy|\brx\b)\b/.test(h)) {
        const name = (item.description || "").slice(0, 60).trim();
        if (name) meds.add(name);
      }
    }
    if (meds.size) set("medicationReminders", [...meds].slice(0, 8));
  } catch (err) { console.warn("[profile-sweep] wellness extract failed:", err?.message || err); }

  // ===== Persist extracted preferences (shallow-merge, mark sources) =====
  if (Object.keys(updates).length) {
    try {
      const existing = parse(await redis.get(`user:${userId}:preferences`)) || {};
      const mergedSources = { ...(existing._sweepSources || {}), ...sources };
      const merged = { ...existing, ...updates, _sweepSources: mergedSources };
      await redis.set(`user:${userId}:preferences`, JSON.stringify(merged));
      console.log(`[profile-sweep] ${householdId}: populated ${Object.keys(updates).join(", ")}`);
    } catch (err) {
      console.warn("[profile-sweep] preference write failed:", err?.message || err);
    }
  }

  // ===== 6. Completeness score per movement =====
  const completeness = {};
  for (const [movement, fields] of Object.entries(PROFILE_FIELDS)) {
    const populated = fields.filter((f) => updates[f] != null).length;
    completeness[movement] = Math.round((populated / fields.length) * 100);
  }
  completeness.computedAt = Date.now();
  try {
    await redis.set(`household:${householdId}:movementCompleteness`, JSON.stringify(completeness));
  } catch (err) {
    console.warn("[profile-sweep] completeness write failed:", err?.message || err);
  }

  return { populated: Object.keys(updates), completeness, property };
}
