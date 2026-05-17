// Life transition onboarding.
//
// POST /api/transition
//   body: { userId, transitionType, transitionDate, details? }
//   Seeds vault items, signals, and (for new_baby) a crew entry
//   appropriate to the transition. Stores the transition record in
//   household:{id}:transitions (LPUSH, history) and the active period
//   in household:{id}:activeTransition (single JSON key, 90-day
//   window). Brief.js reads activeTransition to soften tone.
//
// GET  /api/transition?userId=...
//   Returns { active: <activeTransition|null>, history: <past list> }.
//
// Transitions are additive — every vault item gets `source: 'transition'`
// + the transitionType so they can be filtered out later if needed.
// We don't dedup against existing vault entries: if a user runs the
// same transition twice (rare, but possible), they get extra rows.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const TRANSITION_WINDOW_DAYS = 90;

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

// Add N days to a YYYY-MM-DD-ish string and return YYYY-MM-DD.
// Falls back to today + N when the input doesn't parse.
function addDays(base, n) {
  const ms = base ? Date.parse(base) : NaN;
  const start = isNaN(ms) ? Date.now() : ms;
  return new Date(start + n * DAY_MS).toISOString().slice(0, 10);
}

const VALID_TYPES = new Set([
  "new_baby",
  "new_home",
  "divorce",
  "health_diagnosis",
  "job_change",
  "loss",
]);

// ---------- Per-transition seed plans ----------
//
// Each plan returns { vault: [...], signals: [...], crew?: [...] }.
// `details` shape is per-type (see the spec) and may be empty — every
// seed has sensible defaults so a bare POST still produces a usable
// transition.

function planNewBaby(transitionDate, details = {}) {
  const t = transitionDate;
  return {
    vault: [
      { category: "medical",   description: "Pediatrician — first appointment",            renewalDate: addDays(t, 14),  consequence: "newborn health check" },
      { category: "financial", description: "Add baby to health insurance",                renewalDate: addDays(t, 30),  consequence: "coverage gap" },
      { category: "legal",     description: "Birth certificate application",               renewalDate: addDays(t, 60),  consequence: "required for passport/SSN" },
      { category: "financial", description: "Social Security Number application",          renewalDate: addDays(t, 90) },
      { category: "financial", description: "Update beneficiaries — life insurance and 401k", renewalDate: addDays(t, 90) },
      { category: "medical",   description: "Postpartum checkup",                          renewalDate: addDays(t, 42) },
    ],
    signals: [
      { type: "appointment", description: "Schedule newborn pediatric visit", state: "incoming" },
      { type: "deadline",    description: "Notify HR of new dependent for benefits", state: "incoming" },
    ],
    crew: [
      {
        memberType: "child",
        name: details.babyName || "New baby",
        age: 0,
        birthday: t.slice(5), // MM-DD per crew schema
        dob: t,                // keep full ISO too for reveal/age math
      },
    ],
  };
}

function planNewHome(transitionDate, details = {}) {
  const t = transitionDate;
  const closing = details.closingDate || t;
  return {
    vault: [
      { category: "insurance",    description: "Homeowners insurance",                     renewalDate: addDays(closing, 365) },
      { category: "financial",    description: "Property tax first payment",               renewalDate: addDays(closing, 182) },
      { category: "registration", description: "Update drivers license address",           renewalDate: addDays(t, 30) },
      { category: "registration", description: "Update vehicle registration address",      renewalDate: addDays(t, 30) },
      { category: "other",        description: "Forward mail — USPS change of address",    renewalDate: addDays(t, 7),   consequence: "missed mail" },
      { category: "warranty",     description: "Home warranty review",                     renewalDate: addDays(closing, 365) },
      { category: "other",        description: "Locate main water shutoff",                renewalDate: addDays(t, 14) },
      { category: "other",        description: "Locate electrical panel and label breakers", renewalDate: addDays(t, 30) },
    ],
    signals: [
      { type: "service", description: "Schedule HVAC inspection for new home",  state: "incoming" },
      { type: "service", description: "Schedule security system setup",         state: "incoming" },
    ],
  };
}

function planDivorce(transitionDate, details = {}) {
  const t = transitionDate;
  const filing = details.filingDate || t;
  return {
    vault: [
      { category: "legal",        description: "Finalize divorce decree",                          renewalDate: addDays(filing, 90) },
      { category: "financial",    description: "Update bank accounts — remove joint access",       renewalDate: addDays(t, 30) },
      { category: "insurance",    description: "Update health insurance — separate coverage",      renewalDate: addDays(t, 60), consequence: "coverage gap" },
      { category: "legal",        description: "Update will and beneficiaries",                    renewalDate: addDays(t, 90) },
      { category: "registration", description: "Update address on all accounts",                   renewalDate: addDays(t, 60) },
      { category: "financial",    description: "Open individual credit card if needed",            renewalDate: addDays(t, 30) },
    ],
    signals: [
      { type: "deadline", description: "Contact estate attorney — update documents", state: "incoming" },
    ],
  };
}

function planHealthDiagnosis(transitionDate, details = {}) {
  const t = transitionDate;
  const condition = (details.condition || "diagnosis").trim();
  const rxInterval = Number.isFinite(details.prescriptionInterval)
    ? details.prescriptionInterval
    : 30;
  return {
    vault: [
      { category: "medical",   description: `${condition} — specialist follow-up`,         renewalDate: addDays(t, 30) },
      { category: "medical",   description: "Review health insurance coverage limits",     renewalDate: addDays(t, 14) },
      { category: "medical",   description: "Prescription — first refill",                 renewalDate: addDays(t, rxInterval) },
      // "Next enrollment period" is fuzzy. Default to 1 Nov (US Open
      // Enrollment) — the user can edit on Horizon if their plan year
      // runs differently.
      { category: "financial", description: "FSA/HSA — maximize contribution",             renewalDate: nextOpenEnrollment(t) },
      { category: "legal",     description: "Update advance directive / healthcare proxy", renewalDate: addDays(t, 90) },
    ],
    signals: [],
  };
}

function nextOpenEnrollment(fromISO) {
  // Default to Nov 1 of the current or next year, whichever is next.
  const base = fromISO ? new Date(fromISO) : new Date();
  const candidate = new Date(base.getFullYear(), 10, 1); // 10 = November
  if (candidate.getTime() < base.getTime() + DAY_MS) {
    candidate.setFullYear(candidate.getFullYear() + 1);
  }
  return candidate.toISOString().slice(0, 10);
}

function planJobChange(transitionDate, details = {}) {
  const t = transitionDate;
  const lastDay = details.lastDay || t;
  return {
    vault: [
      { category: "insurance", description: "COBRA or new health insurance",            renewalDate: addDays(lastDay, 30), consequence: "coverage gap" },
      { category: "financial", description: "Roll over 401k from previous employer",   renewalDate: addDays(lastDay, 60) },
      { category: "financial", description: "Update direct deposit",                    renewalDate: addDays(t, 14) },
      { category: "other",     description: "Return company equipment",                 renewalDate: addDays(lastDay, 7) },
    ],
    signals: [],
  };
}

function planLoss(transitionDate /* details = {} */) {
  const t = transitionDate;
  return {
    vault: [
      { category: "legal",     description: "Obtain death certificates (multiple copies)", renewalDate: addDays(t, 30) },
      { category: "legal",     description: "File for probate if needed",                  renewalDate: addDays(t, 60) },
      { category: "financial", description: "Notify Social Security",                      renewalDate: addDays(t, 30) },
      { category: "financial", description: "Contact life insurance provider",             renewalDate: addDays(t, 30) },
      { category: "financial", description: "Close or transfer bank accounts",             renewalDate: addDays(t, 90) },
    ],
    signals: [],
  };
}

function planFor(type, transitionDate, details) {
  switch (type) {
    case "new_baby":         return planNewBaby(transitionDate, details);
    case "new_home":         return planNewHome(transitionDate, details);
    case "divorce":          return planDivorce(transitionDate, details);
    case "health_diagnosis": return planHealthDiagnosis(transitionDate, details);
    case "job_change":       return planJobChange(transitionDate, details);
    case "loss":             return planLoss(transitionDate, details);
    default:                 return null;
  }
}

// ---------- Apply the plan ----------

async function seedVault(householdId, vault, transitionType) {
  if (!vault?.length) return 0;
  const key = `household:${householdId}:vault`;
  const items = vault.map((v) => ({
    id: Date.now() + Math.floor(Math.random() * 1000),
    ...v,
    source: "transition",
    transitionType,
    notedAt: new Date().toISOString(),
  }));
  for (const item of items) {
    await redis.lpush(key, JSON.stringify(item));
  }
  return items.length;
}

async function seedSignals(householdId, signals, transitionType, userId) {
  if (!signals?.length) return 0;
  const key = `household:${householdId}:signals`;
  const stamped = signals.map((s, i) => ({
    id: Date.now() + i,
    ...s,
    state: s.state || "incoming",
    source: "transition",
    transitionType,
    userId: userId || null,
    confidence: 1,
    lastUpdate: new Date().toLocaleString(),
  }));
  for (const sig of stamped) {
    await redis.lpush(key, JSON.stringify(sig));
  }
  return stamped.length;
}

// Crew is a flat JSON-string array (see onboard-worker.js). Merge by
// {memberType, lowercased name} so a repeat new_baby with the same
// name doesn't create duplicates.
async function seedCrew(householdId, crew) {
  if (!crew?.length) return 0;
  const key = `household:${householdId}:crew`;
  const existingRaw = await redis.get(key);
  const existing = Array.isArray(safeJson(existingRaw)) ? safeJson(existingRaw) : [];
  const indexKey = (m) => `${m.memberType}:${String(m.name || "").toLowerCase().trim()}`;
  const map = new Map();
  for (const m of existing) {
    if (m && m.memberType && m.name) map.set(indexKey(m), m);
  }
  let added = 0;
  for (const m of crew) {
    const k = indexKey(m);
    if (map.has(k)) {
      Object.assign(map.get(k), m);
    } else {
      map.set(k, m);
      added++;
    }
  }
  const merged = [...existing.filter((m) => !m || !m.memberType || !m.name), ...map.values()];
  await redis.set(key, JSON.stringify(merged));
  return added;
}

// ---------- Handler ----------

export default async function handler(req, res) {
  if (req.method === "GET") {
    const { userId } = req.query || {};
    if (!userId) return res.status(400).json({ error: "userId required" });
    const householdId = await resolveHouseholdId(userId);
    if (!householdId) return res.status(400).json({ error: "no household" });
    const [activeRaw, historyRaw] = await Promise.all([
      redis.get(`household:${householdId}:activeTransition`).catch(() => null),
      redis.lrange(`household:${householdId}:transitions`, 0, 19).catch(() => []),
    ]);
    let active = safeJson(activeRaw);
    if (active && active.endDate) {
      // Auto-expire when the 90-day window closes — silently clear
      // the key so the brief stops applying transition-tone rules.
      const endMs = Date.parse(active.endDate);
      if (!isNaN(endMs) && endMs < Date.now()) {
        await redis.del(`household:${householdId}:activeTransition`);
        active = null;
      }
    }
    const history = (historyRaw || [])
      .map((r) => safeJson(r))
      .filter(Boolean);
    return res.status(200).json({ household: householdId, active, history });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { userId, transitionType, transitionDate, details } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  if (!VALID_TYPES.has(transitionType)) {
    return res.status(400).json({
      error: `transitionType must be one of: ${[...VALID_TYPES].join(", ")}`,
    });
  }
  const td = typeof transitionDate === "string" && transitionDate.length > 0
    ? transitionDate.slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const householdId = await resolveHouseholdId(userId);
  if (!householdId) return res.status(400).json({ error: "no household" });

  const plan = planFor(transitionType, td, details || {});
  if (!plan) return res.status(400).json({ error: "Unknown transition type" });

  const vaultCount   = await seedVault(householdId, plan.vault, transitionType);
  const signalsCount = await seedSignals(householdId, plan.signals, transitionType, userId);
  const crewCount    = plan.crew ? await seedCrew(householdId, plan.crew) : 0;

  const startDateISO = td;
  const endDateISO = addDays(td, TRANSITION_WINDOW_DAYS);
  const record = {
    transitionType,
    transitionDate: td,
    details: details || {},
    createdAt: new Date().toISOString(),
    seeded: { vault: vaultCount, signals: signalsCount, crew: crewCount },
  };
  await redis.lpush(`household:${householdId}:transitions`, JSON.stringify(record));
  await redis.ltrim(`household:${householdId}:transitions`, 0, 49);

  // activeTransition drives brief tone — single JSON value with the
  // type + window. TTL set to the window end + a day's slack so the
  // brief auto-quiets even if no traffic forces the GET expiry above.
  const ttlSec = Math.max(60, Math.floor((Date.parse(endDateISO) - Date.now()) / 1000) + DAY_MS / 1000);
  await redis.set(
    `household:${householdId}:activeTransition`,
    JSON.stringify({
      type: transitionType,
      startDate: startDateISO,
      endDate: endDateISO,
      details: details || {},
    }),
    { ex: Math.floor(ttlSec) }
  );

  console.log(
    `[transition] ${householdId} ${transitionType} → vault:${vaultCount} signals:${signalsCount} crew:${crewCount}`
  );

  return res.status(200).json({
    ok: true,
    household: householdId,
    transition: { type: transitionType, startDate: startDateISO, endDate: endDateISO },
    seeded: { vault: vaultCount, signals: signalsCount, crew: crewCount },
  });
}
