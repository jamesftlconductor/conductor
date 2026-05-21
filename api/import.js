import { Redis } from "@upstash/redis";
import { getValidToken } from "./refresh.js";
import {
  extractTrackingNumbers,
  parseAmazonDeliveryEmail,
  trackPackage,
} from "./carrier.js";
import { writeCommonsRecord, logAutoResolvedMemory } from "./commons.js";
import { extractSignalLocation } from "./places.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Stable content key for a parsed signal. Mirrors the dedup logic used by the
// one-shot cleanup so the messageId-less legacy entries collapse against new
// imports of the same email.
function contentFingerprint(signal) {
  const tracking = signal.trackingNumber && signal.trackingNumber !== "Unknown"
    ? signal.trackingNumber
    : null;
  if (tracking) return `tracking:${tracking}`;
  const desc = (signal.description || "").trim().toLowerCase();
  const sender = (signal.sender || "").trim().toLowerCase();
  return `desc:${desc}|from:${sender}`;
}

// Word-bounded so "office" / "officer" don't trip the "off" rule. The "% off"
// branch is separate because the leading "%" isn't a word character. Phrases
// like "special buys" / "save up to" were added empirically after the patterns
// endpoint surfaced Home Depot Pro promo emails escaping the original list.
const PROMO_REGEX = /\b(?:sale|off|discount|promo|deal|offer|coupon|shop now|limited time|exclusive|unsubscribe|special buys?|save up to|promo code|shop today|now extended|free shipping|free delivery)\b|%\s*off/i;
const PROMO_SENDER_PREFIXES = ["noreply", "no-reply", "marketing", "promotions"];

// Substrings that, when present anywhere in the From header, mark the email
// as a delivery-system bounce — those carry no real signal and Claude tends
// to classify them as "service" with a "Delayed" status that defeats the
// promo-sender rule's status-bearing override. Checked against the full
// From header rather than the local-part because Mail Delivery Subsystem
// often shows up as `mailer-daemon@googlemail.com` with the friendly name
// in the display portion.
const BOUNCE_FROM_SUBSTRINGS = ["mail delivery subsystem", "mailer-daemon", "postmaster"];

function senderLocalPart(from) {
  const match = from.match(/<([^>]+)>/) || from.match(/(\S+@\S+)/);
  if (!match) return "";
  return match[1].toLowerCase().split("@")[0];
}

// ---------- thread detection ----------
//
// After a signal is added to :signals, check whether it belongs in an
// existing thread (same sender within 30d, ETA within 7d of an
// existing signal from the same sender, or shared city/destination
// keyword). When grouped, all thread members carry the same threadId
// (id of the oldest member) and thread metadata lives at
// household:{id}:threads:{threadId}.

// City keyword lists, split US vs international. Used both to extract
// shared-entity matches and to enforce the "never thread a US signal
// with an international one" rule.
const US_CITIES = [
  "new york", "nyc", "miami", "los angeles", "la", "chicago", "boston",
  "seattle", "san francisco", "sf", "denver", "vegas", "las vegas",
  "orlando", "dallas", "atlanta", "fort lauderdale", "ft lauderdale",
  "houston", "phoenix", "philadelphia", "san diego", "austin",
  "portland", "minneapolis", "tampa",
];
const INTL_CITIES = [
  "paris", "london", "tokyo", "barcelona", "rome", "berlin", "amsterdam",
  "madrid", "dubai", "singapore", "nice", "montpellier", "montpelier",
  "lyon", "marseille", "milan", "florence", "venice", "vienna", "prague",
  "lisbon", "athens", "dublin", "edinburgh", "copenhagen", "stockholm",
  "oslo", "munich", "frankfurt", "zurich", "geneva", "brussels", "cdg",
  "charles de gaulle",
];
const CITY_KEYWORDS = [...US_CITIES, ...INTL_CITIES];
const US_CITY_SET = new Set(US_CITIES);
const INTL_CITY_SET = new Set(INTL_CITIES);

function cityKind(city) {
  if (US_CITY_SET.has(city)) return "us";
  if (INTL_CITY_SET.has(city)) return "intl";
  return null;
}

function descriptionKeywords(desc) {
  const lower = (desc || "").toLowerCase();
  const hits = new Set();
  for (const k of CITY_KEYWORDS) {
    const re = new RegExp(`\\b${k.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (re.test(lower)) hits.add(k);
  }
  return hits;
}

// Flight numbers (IATA-ish): two letters or letter+digit + 1-4 digits.
// AA123, B6234, UA1, F9567. Used as a high-specificity match — two
// signals naming the same flight number always thread.
const FLIGHT_NUMBER_THREAD_RE = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\d{1,4}\b/g;
function extractFlightNumbers(desc) {
  if (!desc) return [];
  const found = new Set();
  FLIGHT_NUMBER_THREAD_RE.lastIndex = 0;
  let m;
  while ((m = FLIGHT_NUMBER_THREAD_RE.exec(desc)) !== null) {
    found.add(m[0].toUpperCase());
  }
  return [...found];
}

// Coarse type families — used to enforce the "wildly different types
// never thread unless same sender" rule. A `reservation` is split into
// `travel-related` (description mentions a travel city) vs `local`
// (no city marker) so a Paris hotel doesn't bucket with a neighborhood
// dinner reservation.
function typeFamily(signal) {
  const t = String(signal.type || "").toLowerCase();
  if (t === "travel" || t === "flight") return "travel";
  if (t === "service" || t === "appointment") return "service";
  if (t === "reservation") {
    return descriptionKeywords(signal.description).size > 0
      ? "travel-related"
      : "local";
  }
  if (t === "package" || t === "delivery") return "package";
  if (t === "deadline" || t === "subscription") return "admin";
  return "other";
}

// Two type families are incompatible if they're broadly different
// purposes (travel ↔ service, travel ↔ local, package ↔ travel, etc).
// `same-sender` is the only override that lets cross-family pair up.
const INCOMPATIBLE_PAIRS = new Set([
  "travel|service", "service|travel",
  "travel|local", "local|travel",
  "travel|package", "package|travel",
  "travel|admin", "admin|travel",
  "service|local", "local|service",
  "service|package", "package|service",
]);
function typesIncompatible(a, b) {
  const fa = typeFamily(a);
  const fb = typeFamily(b);
  if (fa === fb) return false;
  return INCOMPATIBLE_PAIRS.has(`${fa}|${fb}`);
}

// Decide whether two signals belong in the same thread.
//
// Order of operations:
//   1. NEGATIVE rules — any one disqualifies the pair immediately.
//   2. POSITIVE rules — any one passes if no negative blocked.
//
// Net: a thread requires shared sender + close ETA, OR a shared
// high-specificity entity (city, flight number) + same continent +
// compatible types.
function isSameThread(newSignal, candidate) {
  if (!newSignal || !candidate) return false;
  if (newSignal.id === candidate.id) return false;

  const senderNew = normalizeSenderForPattern(newSignal.sender);
  const senderCand = normalizeSenderForPattern(candidate.sender);
  const sameSender = !!(senderNew && senderCand && senderNew === senderCand);

  const newEta = newSignal.eta ? Date.parse(newSignal.eta) : NaN;
  const candEta = candidate.eta ? Date.parse(candidate.eta) : NaN;
  const etaDelta =
    !isNaN(newEta) && !isNaN(candEta) ? Math.abs(newEta - candEta) : Infinity;

  const citiesNew = descriptionKeywords(newSignal.description);
  const citiesCand = descriptionKeywords(candidate.description);
  const sharedCity = [...citiesNew].some((c) => citiesCand.has(c));

  // -------- NEGATIVE RULES --------

  // N1: Both signals name cities, but none overlap → different trips.
  if (citiesNew.size > 0 && citiesCand.size > 0 && !sharedCity) return false;

  // N2: One signal references a US city, the other an international
  // city → never thread (separate trips / different continents).
  const kindsNew = new Set([...citiesNew].map(cityKind).filter(Boolean));
  const kindsCand = new Set([...citiesCand].map(cityKind).filter(Boolean));
  if (kindsNew.has("us") && kindsCand.has("intl")) return false;
  if (kindsNew.has("intl") && kindsCand.has("us")) return false;

  // N3: Wildly different type families → only same-sender OR shared
  // destination city overrides. Shared-city is the "rental in the
  // travel destination" carve-out from spec — a car rental (service)
  // in Paris co-threads with a Paris flight (travel) even though
  // service↔travel is normally incompatible.
  if (typesIncompatible(newSignal, candidate) && !sameSender && !sharedCity) {
    return false;
  }

  // -------- POSITIVE RULES --------

  const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  // P1: Same sender + ETA within 14 days. Replaces the old "same
  // sender within 30d of import time" rule that grouped unrelated
  // recurring touchpoints from the same vendor.
  if (sameSender && etaDelta < FOURTEEN_DAYS_MS) return true;

  // P2: Shared named entity (city) + ETA within 30 days. Cross-sender
  // grouping for a single trip — hotel + dinner + transfer all
  // tagged "Paris" within the same fortnight.
  if (sharedCity && etaDelta < THIRTY_DAYS_MS) return true;

  // P3: Shared flight number — unambiguous match. Two emails about
  // AA123 are about the same flight regardless of sender/eta.
  const flightsNew = extractFlightNumbers(newSignal.description);
  const flightsCand = extractFlightNumbers(candidate.description);
  if (flightsNew.some((f) => flightsCand.includes(f))) return true;

  return false;
}

function pickThreadSummary(signals, primaryKeyword) {
  // Heuristic summary: if a shared keyword exists, "{Keyword} trip"
  // when at least one signal is travel/reservation. Otherwise fall
  // back to "{Sender} batch" for sender-only threads.
  const capitalize = (s) =>
    s ? s.split(/\s+/).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") : s;
  if (primaryKeyword) {
    const hasTravel = signals.some(
      (s) => s.type === "travel" || s.type === "reservation"
    );
    return hasTravel ? `${capitalize(primaryKeyword)} trip` : `${capitalize(primaryKeyword)}`;
  }
  const sender = signals.map((s) => s.sender).filter(Boolean)[0];
  return sender ? `${sender} batch` : "Related signals";
}

// Locate a signal by id in the household's :signals list and write
// the carrier-tracking result onto it. Used both by the just-imported
// path and by the hourly track cron. Returns the freshly-updated
// signal record, or null if no change applied.
export async function applyTrackingUpdate(householdId, signal) {
  if (!signal || !signal.trackingNumber) return null;
  let tracking;
  try {
    tracking = await trackPackage(signal.trackingNumber);
  } catch (err) {
    console.warn(`[tracking] ${signal.trackingNumber} fetch failed:`, err?.message || err);
    return null;
  }
  if (!tracking) return null;
  const key = `household:${householdId}:signals`;
  const raw = await redis.lrange(key, 0, -1);
  for (let i = 0; i < raw.length; i++) {
    const parsed = (() => { try { return typeof raw[i] === "string" ? JSON.parse(raw[i]) : raw[i]; } catch { return null; } })();
    if (!parsed || parsed.id !== signal.id) continue;
    const previousStatus = parsed.status || null;
    parsed.carrier = tracking.carrier;
    parsed.status = tracking.status;
    if (tracking.eta) parsed.eta = tracking.eta;
    parsed.trackingLocation = tracking.location || null;
    parsed.trackingLastUpdate = tracking.lastUpdate || null;
    parsed.trackingUpdatedAt = new Date().toISOString();
    const becameResolved =
      tracking.status === "Delivered" && parsed.state !== "resolved";
    if (becameResolved) {
      parsed.state = "resolved";
      parsed.resolvedAt = new Date().toISOString();
      // Mark the auto-resolve path so the Took Care Of band can pick
      // it up via either the source-based or resolvedBy-based filter.
      // Keeps the original source ("import" / "manual" / "scan") so we
      // don't lose the original-origin breadcrumb.
      parsed.resolvedBy = "tracking";
    }
    await redis.lset(key, i, JSON.stringify(parsed));
    if (becameResolved) {
      // Auto-resolve: log memory entry + Commons aggregation. Memory
      // surfaces the resolution in Took Care Of; Commons records the
      // anonymous resolution-time-by-provider stat.
      await logAutoResolvedMemory(householdId, parsed, "tracking");
      await writeCommonsRecord(householdId, parsed);
    }
    console.log(
      `[tracking] ${signal.trackingNumber} (${tracking.carrier}): ${previousStatus || "?"} → ${tracking.status}`
    );
    return { signal: parsed, previousStatus, tracking };
  }
  return null;
}

async function detectAndStampThread(householdId, newSignal) {
  if (!newSignal || (!newSignal.sender && !newSignal.description)) return null;
  // Scan recent signals (cap at 200) for matches.
  const rawSignals = await redis.lrange(`household:${householdId}:signals`, 0, 199);
  const candidates = [];
  for (const r of rawSignals || []) {
    let parsed;
    try { parsed = typeof r === "string" ? JSON.parse(r) : r; } catch { continue; }
    if (!parsed || !parsed.id) continue;
    candidates.push(parsed);
  }

  const matches = candidates.filter((c) => isSameThread(newSignal, c));
  if (matches.length === 0) return null;

  // Determine threadId — use the oldest existing threadId if any
  // match already has one; otherwise use the oldest signal's id.
  let threadId = null;
  const withThread = matches.filter((m) => m.threadId);
  if (withThread.length > 0) {
    threadId = String(withThread[0].threadId);
  } else {
    const oldest = [...matches, newSignal].sort((a, b) => (a.id || 0) - (b.id || 0))[0];
    threadId = String(oldest.id);
  }

  // Stamp the new signal (mutates in place).
  newSignal.threadId = threadId;

  // Backfill threadId onto matches that don't already carry it.
  const signalsKey = `household:${householdId}:signals`;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!matches.some((m) => m.id === c.id)) continue;
    if (c.threadId === threadId) continue;
    c.threadId = threadId;
    await redis.lset(signalsKey, i, JSON.stringify(c));
  }

  // Persist thread metadata. Members include the new signal and every
  // match — the brief and Hover read this to display thread-aware UI.
  const members = [...matches, newSignal];
  const sharedKw = (() => {
    // Find a keyword that appears in at least half the members.
    const counts = new Map();
    for (const m of members) {
      for (const k of descriptionKeywords(m.description)) {
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
    let top = null;
    let topCount = 0;
    for (const [k, c] of counts) if (c > topCount) { top = k; topCount = c; }
    return topCount >= Math.ceil(members.length / 2) ? top : null;
  })();
  const summary = pickThreadSummary(members, sharedKw);
  const typeCounts = new Map();
  for (const m of members) typeCounts.set(m.type, (typeCounts.get(m.type) || 0) + 1);
  const primaryType = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";
  const latestEta = members
    .map((m) => (m.eta ? Date.parse(m.eta) : NaN))
    .filter((n) => !isNaN(n))
    .sort((a, b) => b - a)[0];

  const threadRecord = {
    threadId,
    summary,
    primaryType,
    latestEta: latestEta ? new Date(latestEta).toISOString() : null,
    signals: members.map((m) => String(m.id)),
    updatedAt: Date.now(),
  };
  await redis.set(`household:${householdId}:threads:${threadId}`, JSON.stringify(threadRecord));
  console.log(
    `[thread] ${householdId} ${threadId}: "${summary}" (${members.length} signals)`
  );
  return threadRecord;
}

// ---------- recurring pattern detection ----------
//
// After a signal lands in :signals, look back at the last 90 days for
// 2+ prior signals from the same sender + same type. If they exist,
// compute the average inter-arrival interval and stamp the new signal
// recurring: true, plus persist (or refresh) the pattern record in
// household:{id}:patterns. The pattern is what api/sync.js's
// anticipated-signal generator reads when a sender is overdue.

function normalizeSenderForPattern(sender) {
  if (!sender || typeof sender !== "string") return "";
  return sender.toLowerCase().replace(/\s+/g, " ").trim();
}

function classifyRecurringPattern(avgDays) {
  if (avgDays == null || !isFinite(avgDays) || avgDays <= 0) return null;
  if (avgDays <= 9) return "weekly";
  if (avgDays <= 45) return "monthly";
  if (avgDays <= 120) return "quarterly";
  return "annual";
}

async function detectAndStampRecurring(householdId, newSignal) {
  if (!newSignal?.sender || !newSignal?.type) return null;
  const senderKey = normalizeSenderForPattern(newSignal.sender);
  if (!senderKey) return null;

  // Look back at the most recent 200 signals; 90-day window for prior
  // matches. Cheap LRANGE since dedup already keeps the list tight.
  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - NINETY_DAYS_MS;
  const raw = await redis.lrange(`household:${householdId}:signals`, 0, 199);
  const priors = [];
  for (const r of raw || []) {
    let parsed;
    try { parsed = typeof r === "string" ? JSON.parse(r) : r; } catch { continue; }
    if (!parsed || !parsed.id || parsed.id === newSignal.id) continue;
    if (parsed.type !== newSignal.type) continue;
    if (normalizeSenderForPattern(parsed.sender) !== senderKey) continue;
    const stamp = parsed.id || Date.parse(parsed.lastUpdate || "") || 0;
    if (!stamp || stamp < cutoff) continue;
    priors.push({ ...parsed, _stamp: stamp });
  }
  if (priors.length < 2) return null;

  // Average inter-arrival interval — sort by stamp ascending, mean
  // the deltas. id is Date.now() at import so it's a reliable proxy.
  priors.sort((a, b) => a._stamp - b._stamp);
  const deltas = [];
  for (let i = 1; i < priors.length; i++) {
    deltas.push((priors[i]._stamp - priors[i - 1]._stamp) / (24 * 60 * 60 * 1000));
  }
  const avgDays = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const pattern = classifyRecurringPattern(avgDays);
  if (!pattern) return null;

  // Stamp the new signal record.
  newSignal.recurring = true;
  newSignal.recurringInterval = Math.round(avgDays * 10) / 10;
  newSignal.recurringPattern = pattern;

  // Upsert the pattern in household:{id}:patterns hash, keyed by
  // "{type}:{senderKey}". Stores enough metadata for the anticipated-
  // signal generator to fire from the next sync.
  const patternKey = `${newSignal.type}:${senderKey}`;
  const patternRecord = {
    type: newSignal.type,
    sender: newSignal.sender,
    senderKey,
    intervalDays: newSignal.recurringInterval,
    pattern,
    description: newSignal.description || null,
    lastSignalAt: newSignal.id || Date.now(),
    sampleCount: priors.length + 1,
    updatedAt: Date.now(),
  };
  try {
    await redis.hset(`household:${householdId}:patterns`, {
      [patternKey]: JSON.stringify(patternRecord),
    });
  } catch (err) {
    console.warn("[recurring] pattern write failed:", err?.message || err);
  }
  console.log(
    `[recurring] ${householdId} ${patternKey}: ${pattern} (~${newSignal.recurringInterval}d, n=${priors.length + 1})`
  );
  return patternRecord;
}

// ---------- provider extraction ----------

// Normalize a provider name into a stable Redis hash key. Lowercase,
// strip common business-entity suffixes (LLC / Inc / Co / Corp / Ltd /
// PLLC), collapse internal whitespace, drop punctuation. So "ABC Plumbing,
// LLC", "abc plumbing", and "ABC Plumbing Inc." all dedupe to "abc plumbing".
function normalizeProviderName(name) {
  if (!name || typeof name !== "string") return "";
  return name
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\b(llc|inc|incorporated|co|corp|corporation|ltd|pllc|pa|pc|plc)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Heuristic for "is this email from a service company?" — fires when the
// classified type is "service" OR the from-address local part contains
// service-y stems. Avoids running an extra Claude call on every email.
function isLikelyServiceEmail(signal, from) {
  if (signal?.type === "service") return true;
  const local = (senderLocalPart(from) || "").toLowerCase();
  const SERVICE_STEMS = [
    "service", "support", "appointment", "scheduling", "tech",
    "dispatch", "repair", "install",
  ];
  return SERVICE_STEMS.some((stem) => local.includes(stem));
}

async function extractProvider(subject, from, emailText) {
  const prompt = `Extract the service-provider business from this email. Return JSON or the literal word null. JSON schema:
{
  "name": "business name (omit LLC/Inc suffix)",
  "serviceType": "hvac" | "plumbing" | "electrical" | "roofing" | "painting" | "pool" | "lawn" | "pest" | "cleaning" | "appliance" | "handyman" | "other",
  "phone": "string or null",
  "email": "contact email or null",
  "website": "url or null",
  "lastServiceDate": "YYYY-MM-DD or null",
  "estimateAmount": number | null
}
Return null if the email is from a generic marketplace (Yelp, Angi, Thumbtack) without a specific provider, or if there's no real business to record.

Subject: ${subject}
From: ${from}

Email body:
${emailText.substring(0, 1500)}`;
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.content?.[0]?.text?.trim() || "";
    const stripped = text.replace(/```json|```/g, "").trim();
    if (/^null$/i.test(stripped)) return null;
    const match = stripped.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const provider = JSON.parse(match[0]);
    if (!provider?.name || typeof provider.name !== "string") return null;
    return provider;
  } catch (err) {
    console.error("[provider] extract failed:", err?.message || err);
    return null;
  }
}

// Upsert a provider record into household:{id}:providers hash. Keyed
// by normalized name so multiple emails from the same business dedupe.
// Preserves firstSeen on update; bumps lastSeen and merges any fresh
// fields the new email surfaced (e.g., a new phone or estimate).
async function upsertProvider(householdId, provider) {
  const key = normalizeProviderName(provider.name);
  if (!key) return;
  const hashKey = `household:${householdId}:providers`;
  const existingRaw = await redis.hget(hashKey, key);
  let existing = null;
  if (existingRaw) {
    try { existing = typeof existingRaw === "string" ? JSON.parse(existingRaw) : existingRaw; } catch { existing = null; }
  }
  const now = new Date().toISOString();
  const merged = {
    ...(existing || {}),
    ...provider,
    name: provider.name || existing?.name,
    firstSeen: existing?.firstSeen || now,
    lastSeen: now,
  };
  await redis.hset(hashKey, { [key]: JSON.stringify(merged) });
  console.log(
    `[provider] upserted ${householdId}/${key}: ${merged.name} (${merged.serviceType || "other"})`
  );
}

// ---------- financial transaction detection ----------

// Financial-institution sender domains and subject keywords. Either signal
// is enough to mark an email as financial; once routed through the
// financial flow the email skips the shipping/order classifier so we don't
// double-process (e.g., an Amex receipt isn't a "package" signal).
const FINANCIAL_DOMAINS = new Set([
  "chase.com", "bankofamerica.com", "wellsfargo.com", "citibank.com",
  "capitalone.com", "discover.com", "amex.com", "americanexpress.com",
  "usaa.com", "paypal.com", "venmo.com", "synchrony.com", "ally.com",
]);
const FINANCIAL_SUBJECT_TERMS = [
  "charge", "payment", "transaction", "receipt", "statement", "invoice",
  "subscription renewed", "auto-renewal", "auto renewal", "billing",
  "your bill", "amount due",
];

function senderDomain(from) {
  const match = from.match(/<([^>]+)>/) || from.match(/(\S+@\S+)/);
  if (!match) return "";
  const email = match[1].toLowerCase();
  const at = email.indexOf("@");
  if (at === -1) return "";
  // Last two labels handle "billing.chase.com" → "chase.com".
  const host = email.slice(at + 1);
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  return parts.slice(-2).join(".");
}

function isFinancialEmail(from, subject) {
  const domain = senderDomain(from);
  if (domain && FINANCIAL_DOMAINS.has(domain)) return true;
  const subjLower = (subject || "").toLowerCase();
  return FINANCIAL_SUBJECT_TERMS.some((term) => subjLower.includes(term));
}

async function extractTransaction(subject, from, emailText) {
  const prompt = `Extract financial transaction from this email. Return JSON or null:
{
  "transactionType": "subscription_charge" | "bill" | "purchase" | "price_change" | "payment_confirmation" | "other",
  "merchant": "string",
  "amount": number | null,
  "previousAmount": number | null,
  "date": "YYYY-MM-DD",
  "cardLast4": "string | null",
  "isRecurring": boolean,
  "priceChangeDetected": boolean,
  "currency": "USD" | "EUR" | "GBP" | "CAD" | "MXN" | "other",
  "isInternational": boolean
}
Default currency is USD if not specified. isInternational is true when currency is anything other than USD. Return the literal word null (no JSON) if the email is purely promotional or contains no real transaction.

Subject: ${subject}
From: ${from}

Email body:
${emailText.substring(0, 2000)}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error("[financial] Anthropic error", response.status, errText.slice(0, 200));
      return null;
    }
    const data = await response.json();
    const text = data?.content?.[0]?.text?.trim() || "";
    const stripped = text.replace(/```json|```/g, "").trim();
    if (/^null$/i.test(stripped)) return null;
    const match = stripped.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const tx = JSON.parse(match[0]);
    if (!tx || typeof tx !== "object") return null;
    // Minimum shape: merchant + some date or amount.
    if (!tx.merchant || typeof tx.merchant !== "string") return null;
    if (tx.amount == null && !tx.date) return null;
    return tx;
  } catch (err) {
    console.error("[financial] extract failed:", err?.message || err);
    return null;
  }
}

// Anomaly detection against the last 90 days of stored transactions.
// Returns an array of { kind, details } records. Empty array = nothing
// notable about this transaction.
function detectAnomalies(tx, history) {
  const anomalies = [];
  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - NINETY_DAYS_MS;
  const merchantLower = (tx.merchant || "").toLowerCase().trim();

  // Only compare against same-currency history. A €120 charge should
  // never anomaly-flag against $120 USD priors. International charges
  // also skip price-change detection entirely — too noisy without
  // exchange-rate normalization.
  const txCurrency = (tx.currency || "USD").toUpperCase();
  const merchantHistory = (history || []).filter((h) => {
    if (!h || (h.merchant || "").toLowerCase().trim() !== merchantLower) return false;
    const hCurrency = (h.currency || "USD").toUpperCase();
    if (hCurrency !== txCurrency) return false;
    const ms = h.date ? Date.parse(h.date) : NaN;
    return !isNaN(ms) && ms >= cutoff;
  });

  // Skip the entire price-change / unusual-charge path for
  // international charges — store the transaction but emit no
  // anomalies. The signal builder below tags it with currency.
  if (tx.isInternational || txCurrency !== "USD") {
    return anomalies;
  }

  // price_change: model already flagged it OR prior amount differs.
  if (tx.priceChangeDetected) {
    anomalies.push({ kind: "price_change", details: { previousAmount: tx.previousAmount, newAmount: tx.amount } });
  } else if (tx.amount != null && merchantHistory.length > 0) {
    const priorAmounts = merchantHistory
      .map((h) => h.amount)
      .filter((a) => typeof a === "number");
    if (priorAmounts.length > 0) {
      const lastPrior = priorAmounts[0]; // history is newest-first via LPUSH
      if (Math.abs(lastPrior - tx.amount) > 0.01 && tx.isRecurring) {
        anomalies.push({
          kind: "price_change",
          details: { previousAmount: lastPrior, newAmount: tx.amount },
        });
      }
      // unusual_charge: more than 2x typical for this merchant
      const avg = priorAmounts.reduce((a, b) => a + b, 0) / priorAmounts.length;
      if (avg > 0 && tx.amount > avg * 2) {
        anomalies.push({
          kind: "unusual_charge",
          details: { amount: tx.amount, typical: Math.round(avg * 100) / 100 },
        });
      }
    }
  }

  // new_subscription: recurring charge from a merchant with no recent history.
  // The vault-overlap check happens in the caller (needs Redis access).
  if (tx.isRecurring && merchantHistory.length === 0) {
    anomalies.push({ kind: "new_subscription", details: { merchant: tx.merchant } });
  }

  return anomalies;
}

// Compose a signal for a financial anomaly. Type "financial" surfaces in
// the brief alongside other signals; the description carries the
// user-readable framing.
function buildFinancialSignal(anomaly, tx) {
  const merchant = tx.merchant || "Unknown merchant";
  const amount = tx.amount != null ? `$${tx.amount}` : "unknown amount";
  let description;
  switch (anomaly.kind) {
    case "price_change": {
      const prev = anomaly.details.previousAmount;
      const curr = anomaly.details.newAmount;
      description = `${merchant} price changed`
        + (prev != null && curr != null ? ` from $${prev} to $${curr}` : "");
      break;
    }
    case "unusual_charge":
      description = `Unusual charge: ${merchant} ${amount} (typical: $${anomaly.details.typical})`;
      break;
    case "new_subscription":
      description = `New recurring charge detected: ${merchant} ${amount}`;
      break;
    default:
      description = `${merchant} ${amount}`;
  }
  return {
    id: Date.now() + Math.floor(Math.random() * 1000),
    description,
    type: "financial",
    sender: merchant,
    eta: tx.date || null,
    state: "incoming",
    source: "financial",
    confidence: 8,
    lastUpdate: new Date().toLocaleString(),
    financial: {
      anomaly: anomaly.kind,
      amount: tx.amount ?? null,
      previousAmount: anomaly.details.previousAmount ?? tx.previousAmount ?? null,
      cardLast4: tx.cardLast4 || null,
    },
  };
}

// ---------- Lease auto-detection ----------

const LEASE_KEYWORDS = [
  "lease renewal",
  "rent increase",
  "notice to vacate",
  "lease agreement",
  "end of lease",
  "lease expiration",
  "rental agreement",
  "month-to-month",
  "security deposit",
  "rent payment",
  "landlord",
];

function isLeaseEmail(subject, body) {
  const hay = `${subject || ""}\n${(body || "").slice(0, 4000)}`.toLowerCase();
  // Require at least one matching keyword. Single-word "landlord" alone
  // is fine — it strongly implies lease context.
  return LEASE_KEYWORDS.some((k) => hay.includes(k));
}

async function extractLeaseInfo(subject, from, body) {
  const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      tools: [
        {
          name: "record_lease_email",
          description: "Extract lease information from a lease-related email. Return null fields when the email doesn't carry the specific data.",
          input_schema: {
            type: "object",
            properties: {
              leaseType: { type: "string", enum: ["residential", "vehicle", "unknown"] },
              address: { type: ["string", "null"] },
              monthlyAmount: { type: ["number", "null"] },
              leaseEnd: { type: ["string", "null"], description: "YYYY-MM-DD or null" },
              noticeRequired: { type: ["integer", "null"], enum: [30, 60, 90, null] },
              landlordName: { type: ["string", "null"] },
              landlordPhone: { type: ["string", "null"] },
              landlordEmail: { type: ["string", "null"] },
              isRenewalOffer: { type: "boolean" },
              isRentIncrease: { type: "boolean" },
              newAmount: { type: ["number", "null"] },
            },
            required: ["leaseType", "isRenewalOffer", "isRentIncrease"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "record_lease_email" },
      messages: [
        {
          role: "user",
          content: `Extract lease information from this email.

Subject: ${subject}
From: ${from}

Body:
${(body || "").slice(0, 6000)}

Only populate fields when the email clearly carries that data. If nothing lease-specific is present (just a marketing/legal blurb), return null for everything except leaseType/isRenewalOffer/isRentIncrease.`,
        },
      ],
    }),
  });
  if (!apiRes.ok) return null;
  const data = await apiRes.json();
  const tool = (data?.content || []).find((b) => b?.type === "tool_use");
  if (!tool?.input) return null;
  const lease = tool.input;
  // Reject when nothing useful was extracted.
  const hasUseful =
    lease.leaseEnd ||
    lease.monthlyAmount ||
    lease.address ||
    lease.isRenewalOffer ||
    lease.isRentIncrease ||
    lease.newAmount;
  if (!hasUseful) return null;
  return lease;
}

async function syncLeaseFromEmail(householdId, lease, ctx) {
  const vaultKey = `household:${householdId}:vault`;
  const rawVault = await redis.lrange(vaultKey, 0, -1);
  const items = [];
  for (const r of rawVault) {
    try { items.push(JSON.parse(r)); } catch { /* skip malformed */ }
  }

  // Dedup: residential keys on lowercased address; vehicle on
  // make/model/year (unavailable here since email parsing doesn't
  // surface vehicle make/model — vehicle leases will create new
  // items unless one with exactly matching address-like notes
  // already exists).
  const cat = lease.leaseType === "vehicle" ? "lease_vehicle" : "lease_residential";
  let matchIndex = -1;
  if (lease.address) {
    const addrLower = String(lease.address).toLowerCase().trim();
    for (let i = 0; i < items.length; i++) {
      if (items[i]?.category !== cat) continue;
      const existing = String(items[i].address || "").toLowerCase().trim();
      if (existing && existing === addrLower) {
        matchIndex = i;
        break;
      }
    }
  }

  // Rent-increase against existing: update monthlyRent + push priceHistory.
  if (lease.isRentIncrease && matchIndex >= 0) {
    const item = items[matchIndex];
    const prior = item.monthlyRent || item.amount || null;
    const next = lease.newAmount || lease.monthlyAmount || null;
    if (next) {
      item.monthlyRent = next;
      item.amount = `$${next}`;
    }
    if (!Array.isArray(item.priceHistory)) item.priceHistory = [];
    item.priceHistory.push({
      previous: prior,
      current: item.monthlyRent || item.amount,
      detectedAt: new Date().toISOString(),
      source: "lease-email",
    });
    item.lastUpdate = new Date().toLocaleString();
    await redis.lset(vaultKey, matchIndex, JSON.stringify(item));
    console.log(
      `[lease] rent change for ${item.address || item.id}: ${prior} → ${item.monthlyRent}`
    );
    // Also surface a deadline signal if a renewal offer accompanies
    // the increase.
    if (lease.isRenewalOffer) {
      await pushLeaseRenewalSignal(householdId, item, lease, ctx);
    }
    return;
  }

  // No existing match → create new vault item.
  if (matchIndex < 0) {
    const id = `vault_lease_${Date.now()}`;
    const newItem = {
      id,
      category: cat,
      description:
        lease.leaseType === "vehicle"
          ? "Vehicle lease"
          : lease.address
          ? `Lease — ${lease.address}`
          : "Residential lease",
      address: lease.address || null,
      monthlyRent: lease.monthlyAmount || null,
      amount:
        (lease.newAmount || lease.monthlyAmount)
          ? `$${lease.newAmount || lease.monthlyAmount}`
          : null,
      leaseEnd: lease.leaseEnd || null,
      renewalDate: lease.leaseEnd || null,
      noticeRequired: lease.noticeRequired || null,
      landlordName: lease.landlordName || null,
      landlordPhone: lease.landlordPhone || null,
      landlordEmail: lease.landlordEmail || null,
      provider: lease.landlordName || null,
      autoDetected: true,
      source: "gmail",
      confidence: "medium",
      handled: false,
      handledAt: null,
      priceHistory: lease.isRentIncrease
        ? [{
            previous: null,
            current: lease.newAmount || lease.monthlyAmount || null,
            detectedAt: new Date().toISOString(),
            source: "lease-email",
          }]
        : [],
      createdAt: new Date().toISOString(),
    };
    await redis.lpush(vaultKey, JSON.stringify(newItem));
    console.log(`[lease] auto-create vault ${id}: ${newItem.description}`);
    if (lease.isRenewalOffer) {
      await pushLeaseRenewalSignal(householdId, newItem, lease, ctx);
    }
  }
}

async function pushLeaseRenewalSignal(householdId, item, lease, ctx) {
  const eta = item.leaseEnd && item.noticeRequired
    ? (() => {
        const d = new Date(item.leaseEnd);
        if (isNaN(d.getTime())) return item.leaseEnd;
        d.setDate(d.getDate() - Number(item.noticeRequired));
        return d.toISOString().slice(0, 10);
      })()
    : item.leaseEnd || null;
  const signal = {
    id: Date.now(),
    description: "Lease renewal decision needed",
    type: "deadline",
    eta,
    sender: ctx?.from || lease.landlordName || "Landlord",
    status: null,
    state: "incoming",
    source: "gmail",
    leaseRef: item.id,
    leaseAddress: item.address || null,
    lastUpdate: new Date().toLocaleString(),
    createdAt: Date.now(),
    autoDetected: true,
  };
  await redis.lpush(`household:${householdId}:signals`, JSON.stringify(signal));
  console.log(`[lease] renewal signal ${signal.id} eta ${eta}`);
}

// Vault auto-create for new_subscription anomalies. Returns the new
// vault id when created, or null when an existing matching item was
// updated (price_change path) or nothing was done.
async function syncVaultFromTransaction(householdId, tx, anomalies) {
  const vaultKey = `household:${householdId}:vault`;
  const rawVault = await redis.lrange(vaultKey, 0, -1);
  const items = [];
  for (const r of rawVault) {
    try { items.push(JSON.parse(r)); } catch { /* skip malformed */ }
  }
  const merchantLower = (tx.merchant || "").toLowerCase().trim();

  // Find a matching vault item by provider name (case-insensitive).
  let matchIndex = -1;
  let matchItem = null;
  for (let i = 0; i < items.length; i++) {
    const provider = (items[i].provider || "").toLowerCase().trim();
    if (provider && provider === merchantLower) {
      matchIndex = i;
      matchItem = items[i];
      break;
    }
  }

  const hasPriceChange = anomalies.some((a) => a.kind === "price_change");
  const hasNewSubscription = anomalies.some((a) => a.kind === "new_subscription");

  // price_change → update existing vault item amount + push priceHistory.
  if (hasPriceChange && matchItem) {
    const priorAmount = matchItem.amount || null;
    matchItem.amount = tx.amount != null ? `$${tx.amount}` : matchItem.amount;
    if (!Array.isArray(matchItem.priceHistory)) matchItem.priceHistory = [];
    matchItem.priceHistory.push({
      previous: priorAmount,
      current: matchItem.amount,
      detectedAt: new Date().toISOString(),
      txDate: tx.date || null,
    });
    matchItem.lastUpdate = new Date().toLocaleString();
    await redis.lset(vaultKey, matchIndex, JSON.stringify(matchItem));
    console.log(
      `[financial] vault price change: ${matchItem.provider} ${priorAmount} → ${matchItem.amount}`
    );
    return null;
  }

  // new_subscription with no existing match → create auto-detected vault item.
  if (hasNewSubscription && !matchItem) {
    const newItem = {
      id: `vault_auto_${Date.now()}`,
      description: `${tx.merchant} subscription`,
      provider: tx.merchant,
      category: "subscription",
      renewalDate: null,
      amount: tx.amount != null ? `$${tx.amount}` : null,
      consequence: null,
      confidence: "medium",
      source: "auto-detected",
      policyNumber: null,
      handled: false,
      handledAt: null,
      priceHistory: [],
      createdAt: new Date().toISOString(),
    };
    await redis.lpush(vaultKey, JSON.stringify(newItem));
    console.log(`[financial] vault auto-create: ${newItem.description}`);
    return newItem.id;
  }

  return null;
}

function isBounceFrom(from) {
  const lower = (from || "").toLowerCase();
  return BOUNCE_FROM_SUBSTRINGS.some((p) => lower.includes(p));
}

// Numeric 1-10 quality score, computed from field presence after Claude
// extracts the signal. Replaces the earlier string-confidence + all-or-
// nothing field gates with a single tunable threshold. Stored on the
// signal so dedup can use it as a tie-breaker.
function signalConfidenceScore(signal) {
  let score = 0;
  const desc = typeof signal.description === "string" ? signal.description.trim() : "";
  if (desc && desc !== "Unknown") score += 2;
  const sender = typeof signal.sender === "string" ? signal.sender.trim() : "";
  if (sender && sender !== "Unknown") score += 2;
  const etaParsed = signal.eta ? Date.parse(signal.eta) : NaN;
  if (!isNaN(etaParsed)) score += 2;
  if (signal.status && signal.status !== "Unknown") score += 1;
  if (signal.type && signal.type !== "unknown") score += 1;
  if (signal.trackingNumber) score += 1;
  if (desc.length > 20) score += 1;
  return score;
}

// Runs after Claude parses the email but before we write the signal. Returns
// a reason string when the signal should be discarded, or null to keep.
function postParseDiscardReason(signal, from) {
  // Delivery-system bounce — the cheapest, most specific signal that this
  // email carries no real arrival. Checked first so it short-circuits the
  // other gates.
  if (isBounceFrom(from)) return "bounce-sender";

  // Promo language in the description — Claude correctly extracted the words
  // but the email is marketing, not a real arrival.
  if (PROMO_REGEX.test(signal.description || "")) return "promo-keyword";
  // Promo sender — kept if status conveys real info (e.g. "Order shipped"
  // notices legitimately come from noreply@).
  const local = senderLocalPart(from);
  if (
    PROMO_SENDER_PREFIXES.some(p => local.startsWith(p)) &&
    (!signal.status || signal.status === "Unknown")
  ) {
    return "promo-sender";
  }

  // Numeric quality gate. Replaces the previous low-description /
  // missing-sender / all-unknown / low-confidence-unknown checks with a
  // single threshold against the 1-10 score. 4 is the floor where the
  // signal has enough structure to drive a brief sentence.
  if (typeof signal.confidence === "number" && signal.confidence < 4) {
    return `low-confidence-score-${signal.confidence}`;
  }

  return null;
}

// ---------- Semantic deduplication ----------

// Word-overlap ratio against the shorter set, ignoring very common short
// words. Deliberately simple — no Claude call, no embedding lookup, just
// "do these two descriptions feel like the same thing." Returns a value
// in [0, 1].
const OVERLAP_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "your", "this", "that",
  "you", "are", "was", "will", "has", "have", "been", "ord",
]);

function descriptionOverlap(a, b) {
  if (!a || !b) return 0;
  const toWords = (s) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !OVERLAP_STOPWORDS.has(w))
    );
  const wordsA = toWords(a);
  const wordsB = toWords(b);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let common = 0;
  for (const w of wordsA) if (wordsB.has(w)) common++;
  return common / Math.min(wordsA.size, wordsB.size);
}

// Strip common business-entity suffixes so "Amazon Inc", "Amazon, Inc.",
// and "Amazon" all compare equal. Used as the fuzzy sender match in
// dedup rule A.
const COMPANY_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "co", "company",
  "corp", "corporation", "ltd", "limited",
]);

function normalizeSender(s) {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/[.,]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !COMPANY_SUFFIXES.has(w))
    .join(" ")
    .trim();
}

// True when the new signal is plausibly the same as an existing one
// according to either of two rules:
//   A. Same type + fuzzy sender match (suffix-stripped, case-insensitive)
//      + ETAs within 5 days of each other.
//   B. Same type + description word overlap > 50% AND both signals are
//      still in motion (incoming or active).
function isSemanticDuplicate(newSig, existing) {
  if (newSig.type !== existing.type) return false;

  const newSender = normalizeSender(newSig.sender);
  const exSender = normalizeSender(existing.sender);
  if (newSender && exSender && newSender === exSender) {
    const newEta = newSig.eta ? Date.parse(newSig.eta) : NaN;
    const exEta = existing.eta ? Date.parse(existing.eta) : NaN;
    if (!isNaN(newEta) && !isNaN(exEta)) {
      const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
      if (Math.abs(newEta - exEta) <= FIVE_DAYS_MS) return true;
    }
  }

  const newInMotion =
    !newSig.state || newSig.state === "incoming" || newSig.state === "active";
  const exInMotion =
    !existing.state || existing.state === "incoming" || existing.state === "active";
  if (newInMotion && exInMotion) {
    const overlap = descriptionOverlap(newSig.description, existing.description);
    if (overlap > 0.5) return true;
  }

  return false;
}

function safeParseSignal(raw) {
  if (raw == null) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

export async function runImport(userId, customQuery = null) {
  if (!userId) throw new Error("No userId provided");

  const accessToken = await getValidToken(userId);
  const householdId = (await redis.get(`user:${userId}:household`)) || userId;
  const importedSetKey = `household:${householdId}:importedMessages`;
  const fingerprintSetKey = `household:${householdId}:contentFingerprints`;

  const thirtyDaysAgo = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
  // Custom queries from POST body are used for targeted re-imports
  // (e.g. surfacing a missed Paris flight email). When unset, falls
  // back to the default 30d sweep. Targeted queries skip the
  // `after:` window so older booking emails can be pulled in.
  const query = customQuery && customQuery.trim().length > 0
    ? customQuery
    : `after:${thirtyDaysAgo} subject:(tracking OR shipped OR "your order" OR "order confirmed" OR "order shipped" OR delivery OR arriving OR "out for delivery" OR "return confirmed" OR reservation OR flight OR hotel OR appointment OR instacart OR doordash OR charge OR payment OR transaction OR receipt OR billing OR "subscription renewed" OR "auto-renewal" OR "amount due" OR statement OR invoice)`;

  const searchResponse = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=5`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  const searchData = await searchResponse.json();

  if (!searchData.messages || searchData.messages.length === 0) {
    return { imported: 0, debug: "No messages found" };
  }

  let imported = 0;

  for (const message of searchData.messages) {
    try {
      // Skip messages already imported into this household — set is populated
      // on every successful parse, so re-runs don't duplicate signals or burn
      // Anthropic calls re-classifying the same email.
      if (await redis.sismember(importedSetKey, message.id)) continue;

      const msgResponse = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=full`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const msgData = await msgResponse.json();

      const headers = msgData.payload?.headers || [];
      const subject = headers.find(h => h.name === "Subject")?.value || "";
      const from = headers.find(h => h.name === "From")?.value || "";

      let emailText = "";
      const parts = msgData.payload?.parts || [];

      for (const part of parts) {
        if (part.mimeType === "text/plain" && part.body?.data) {
          emailText = Buffer.from(part.body.data, "base64").toString("utf-8");
          break;
        }
      }

      if (!emailText) {
        for (const part of parts) {
          const nestedParts = part.parts || [];
          for (const nested of nestedParts) {
            if (nested.mimeType === "text/plain" && nested.body?.data) {
              emailText = Buffer.from(nested.body.data, "base64").toString("utf-8");
              break;
            }
          }
          if (emailText) break;
        }
      }

      if (!emailText && msgData.payload?.body?.data) {
        emailText = Buffer.from(msgData.payload.body.data, "base64").toString("utf-8");
      }

      if (!emailText) {
        emailText = `Subject: ${subject}\nFrom: ${from}`;
      }

      // Financial branch — runs before the shipping/order classifier so
      // an Amex receipt doesn't get misclassified as a "package". When
      // the email matches FINANCIAL_DOMAINS or one of the financial
      // subject keywords, we extract the transaction, store it (LTRIM
      // 500), run anomaly detection against the last 90 days of
      // history, and create signals + vault items as warranted. The
      // standard shipping classifier is skipped for this message.
      if (isFinancialEmail(from, subject)) {
        await redis.sadd(importedSetKey, message.id); // dedup like normal
        const tx = await extractTransaction(subject, from, emailText);
        if (!tx) {
          console.log(`[financial] no transaction extracted from "${subject.slice(0, 60)}"`);
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        const txKey = `household:${householdId}:transactions`;
        const recentTxRaw = await redis.lrange(txKey, 0, 199);
        const history = [];
        for (const r of recentTxRaw) {
          try { history.push(JSON.parse(r)); } catch { /* skip malformed */ }
        }
        const stored = { ...tx, storedAt: Date.now(), messageId: message.id };
        await redis.lpush(txKey, JSON.stringify(stored));
        await redis.ltrim(txKey, 0, 499);

        const anomalies = detectAnomalies(tx, history);

        // Vault sync first so the new_subscription auto-create races
        // against the same merchant being added by the email-sweep
        // pass — whichever runs first wins, the other sees the match
        // and skips.
        await syncVaultFromTransaction(householdId, tx, anomalies);

        // For each notable anomaly, push a "financial" signal so it
        // surfaces in the brief alongside other near-window items.
        for (const a of anomalies) {
          const signal = buildFinancialSignal(a, tx);
          await redis.lpush(`household:${householdId}:signals`, JSON.stringify(signal));
          console.log(
            `[financial] signal ${signal.id} ${a.kind}: ${signal.description}`
          );

          // Push notification for price_change + unusual_charge —
          // these are immediately actionable. new_subscription
          // surfaces in the next brief instead, no push.
          if (a.kind === "price_change" || a.kind === "unusual_charge") {
            try {
              const merchant = tx.merchant || "Unknown merchant";
              let body;
              if (a.kind === "price_change") {
                const prev = a.details?.previousAmount ?? tx.previousAmount;
                const curr = a.details?.newAmount ?? tx.amount;
                body = prev != null && curr != null
                  ? `${merchant} went from $${prev} to $${curr}/month`
                  : `${merchant} price changed`;
              } else {
                body = `Unusual charge from ${merchant}: $${tx.amount} (typical $${a.details?.typical})`;
              }
              if (body.length > 100) body = body.slice(0, 97) + "...";
              await fetch("https://conductor-ivory.vercel.app/api/notify?type=tracking", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  householdId,
                  title: "Price change detected",
                  body,
                  signalId: signal.id,
                  kind: a.kind,
                }),
              });
            } catch (err) {
              console.warn("[financial] anomaly push failed:", err?.message || err);
            }
          }
        }

        imported++;
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      // Lease branch — runs before the shipping/order classifier so
      // a "lease renewal" email doesn't get misclassified as a
      // package. Keyword-gated for cost: we only invoke Haiku when
      // the subject + body contain lease vocabulary.
      if (isLeaseEmail(subject, emailText)) {
        await redis.sadd(importedSetKey, message.id);
        try {
          const lease = await extractLeaseInfo(subject, from, emailText);
          if (lease) {
            await syncLeaseFromEmail(householdId, lease, { subject, from });
            console.log(`[lease] handled "${subject.slice(0, 60)}"`);
          } else {
            console.log(`[lease] no lease data extracted from "${subject.slice(0, 60)}"`);
          }
        } catch (err) {
          console.warn(`[lease] handler failed: ${err?.message}`);
        }
        imported++;
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      console.log("Parsing:", subject);

      const parseResponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 500,
          messages: [{
            role: "user",
            content: `Extract shipping/order info from this email. Return ONLY a JSON object:
{
  "description": "what the item or service is",
  "carrier": "UPS, FedEx, USPS, DHL, or Unknown",
  "trackingNumber": null,
  "status": "In Transit, Delivered, Out for Delivery, Delayed, or Unknown",
  "eta": "date or null",
  "sender": "who sent it",
  "type": "package, food, grocery, service, reservation, travel, or unknown",
  "notes": "any additional context about timing, location, or special instructions (or null)",
  "confidence": "high, medium, or low — how confident you are in the extracted data",
  "emotionalValence": "joyful, neutral, stressful, or grief",
  "emotionalIntensity": "high, medium, or low"
}

Also classify the emotional valence of this signal:
- joyful: celebrations, milestones, achievements, anticipated pleasures
- stressful: breakdowns, medical issues, financial problems, conflicts
- grief: deaths, serious illness, divorce, loss
- neutral: routine household management

And intensity:
- high: life-changing or significantly disruptive
- medium: meaningful but manageable
- low: routine

When in doubt, default to neutral/low — most package deliveries and routine
service reminders are neutral/low. Only mark high-intensity when the signal
genuinely changes the shape of the day.

Subject: ${subject}
From: ${from}

Email body:
${emailText.substring(0, 1000)}`,
          }],
        }),
      });

      const parseData = await parseResponse.json();
      console.log("Claude response:", JSON.stringify(parseData).substring(0, 200));

      const text = parseData?.content?.[0]?.text || "{}";
      const clean = text.replace(/```json|```/g, "").trim();
      const signal = JSON.parse(clean);

      // Overwrite Claude's string confidence with the numeric 1-10 score
      // before the gate runs so the same field can drive both filtering
      // and dedup tie-breaking.
      signal.confidence = signalConfidenceScore(signal);

      // Emotional classification — coerce to the allowed enum and
      // default to neutral/low when Claude omits or returns something
      // off-list. This guarantees every signal has the two fields
      // downstream consumers expect, without forcing every prompt
      // path to validate.
      const VALID_VALENCE = new Set(["joyful", "neutral", "stressful", "grief"]);
      const VALID_INTENSITY = new Set(["high", "medium", "low"]);
      signal.emotionalValence = VALID_VALENCE.has(signal.emotionalValence)
        ? signal.emotionalValence
        : "neutral";
      signal.emotionalIntensity = VALID_INTENSITY.has(signal.emotionalIntensity)
        ? signal.emotionalIntensity
        : "low";

      // Mark as imported once parsing succeeds — covers both the lpush path
      // below and the stale-eta skip, so neither gets re-processed.
      await redis.sadd(importedSetKey, message.id);

      // Quality gate — runs after the messageId is stamped so we don't reprocess
      // the same junk on every sync. The signal is silently dropped (no list
      // write, no fingerprint write) when Claude's output is meaningless or the
      // email is clearly promotional.
      const discardReason = postParseDiscardReason(signal, from);
      if (discardReason) {
        console.log(
          `[import] discard ${discardReason}: "${(signal.description || "").slice(0, 60)}" from "${from.slice(0, 60)}"`
        );
        continue;
      }

      // Content guard catches duplicates the messageId set can't see — e.g.
      // legacy signals stored before messageId was tracked, or the same order
      // arriving via two different Gmail messages.
      const fp = contentFingerprint(signal);
      if (await redis.sismember(fingerprintSetKey, fp)) continue;

      const etaParsed = signal.eta ? Date.parse(signal.eta) : NaN;
      if (!isNaN(etaParsed) && etaParsed < Date.now() - 7 * 24 * 60 * 60 * 1000) {
        continue;
      }

      signal.id = Date.now() + imported;
      signal.messageId = message.id;
      signal.lastUpdate = new Date().toLocaleString();
      signal.userId = userId;
      signal.source = "import";

      // Semantic dedup against the last 100 stored signals. Picks up
      // cases where the messageId differs and the content fingerprint
      // differs (e.g., a follow-up email with a more specific ETA) but
      // it's clearly the same underlying real-world signal. Higher
      // confidence wins via LSET; existing equal-or-higher drops the new.
      const signalsKey = `household:${householdId}:signals`;
      const recentRaw = await redis.lrange(signalsKey, 0, 99);
      const recent = recentRaw.map(safeParseSignal).filter(Boolean);

      // Status-update detection: when the new email's classified status
      // is a confirmation/delivery/cancel/delay/out-for-delivery keyword,
      // and a matching in-flight signal exists from the same sender +
      // same type, PATCH the existing signal in place instead of
      // creating a new one. Runs BEFORE semantic dedup so the update
      // path is preferred over the replace-by-confidence path.
      const STATUS_UPDATE_TRIGGERS = {
        "Confirmed": { resolve: false },
        "Delivered": { resolve: true },
        "Out for Delivery": { resolve: false },
        "Delayed": { resolve: false },
        "Cancelled": { resolve: true },
      };
      const trigger = STATUS_UPDATE_TRIGGERS[signal.status];
      if (trigger) {
        const newSender = normalizeSender(signal.sender);
        let updateIndex = -1;
        let updateExisting = null;
        for (let i = 0; i < recent.length; i++) {
          const ex = recent[i];
          if (ex.type !== signal.type) continue;
          if (ex.state !== "incoming" && ex.state !== "active") continue;
          const exSender = normalizeSender(ex.sender);
          if (!newSender || !exSender || newSender !== exSender) continue;
          updateIndex = i;
          updateExisting = ex;
          break;
        }
        if (updateIndex !== -1) {
          const patched = {
            ...updateExisting,
            status: signal.status,
            lastUpdate: new Date().toLocaleString(),
          };
          if (trigger.resolve) {
            patched.state = "resolved";
            patched.resolvedAt = new Date().toISOString();
            patched.resolvedBy = "status-update";
          }
          await redis.lset(signalsKey, updateIndex, JSON.stringify(patched));
          await redis.sadd(fingerprintSetKey, fp);
          if (trigger.resolve) {
            // Same memory + Commons rails as the tracking auto-resolve.
            // Without these the Took Care Of band and Commons stats both
            // stay empty for the Delivered/Cancelled status-update path.
            await logAutoResolvedMemory(householdId, patched, "status-update");
            await writeCommonsRecord(householdId, patched);
          }
          console.log(
            `Updated signal ${updateExisting.id} status to ${signal.status} from confirmation email`
          );
          imported++;
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
      }

      // Broader same-sender merge: catches the case where the existing
      // status-update triggers didn't fire (no Confirmed/Delivered/etc.
      // keyword on the new signal) and isSemanticDuplicate's 5-day-ETA
      // window misses it, but the new email is *clearly* a follow-up
      // from the same sender adding tracking/ETA/confirmation that the
      // existing signal didn't have. The merge updates the existing
      // record in place rather than creating a duplicate.
      //
      // Eligibility: same normalized sender + same type + existing in
      // incoming/active. "More info" means any of:
      //   - new has trackingNumber and existing doesn't
      //   - new has eta and existing doesn't (or existing eta is
      //     a vague no-time bare-date and new has a time component)
      //   - new has confirmationNumber and existing doesn't
      //   - new description is materially longer than existing's
      // If none of those apply we fall through to isSemanticDuplicate
      // and let the standard confidence-replace path handle it.
      const newSenderNorm = normalizeSender(signal.sender);
      let absorbedByFollowUpMerge = false;
      if (newSenderNorm) {
        for (let i = 0; i < recent.length; i++) {
          const ex = recent[i];
          if (!ex || ex.type !== signal.type) continue;
          if (ex.state && ex.state !== "incoming" && ex.state !== "active") continue;
          const exSenderNorm = normalizeSender(ex.sender);
          if (!exSenderNorm || exSenderNorm !== newSenderNorm) continue;

          const newHasTracking = !!signal.trackingNumber;
          const exHasTracking = !!ex.trackingNumber;
          const newHasEta = !!signal.eta && !isNaN(Date.parse(signal.eta));
          const exHasEta = !!ex.eta && !isNaN(Date.parse(ex.eta));
          const newEtaHasTime = !!signal.eta && /T\d|:\d{2}/.test(String(signal.eta));
          const exEtaHasTime = !!ex.eta && /T\d|:\d{2}/.test(String(ex.eta));
          const newHasConf = !!signal.confirmationNumber;
          const exHasConf = !!ex.confirmationNumber;
          const newDescLen = (signal.description || "").length;
          const exDescLen = (ex.description || "").length;

          const addsTracking = newHasTracking && !exHasTracking;
          const addsEta = (newHasEta && !exHasEta) || (newEtaHasTime && exHasEta && !exEtaHasTime);
          const addsConf = newHasConf && !exHasConf;
          const longerDesc = newDescLen > exDescLen + 20;
          if (!addsTracking && !addsEta && !addsConf && !longerDesc) continue;

          const merged = {
            ...ex,
            description: longerDesc ? signal.description : ex.description,
            eta: addsEta ? signal.eta : ex.eta,
            trackingNumber: addsTracking ? signal.trackingNumber : ex.trackingNumber,
            carrier: addsTracking ? (signal.carrier || ex.carrier) : ex.carrier,
            confirmationNumber: addsConf ? signal.confirmationNumber : ex.confirmationNumber,
            // Mark the merge so debugging tools can tell the difference
            // between an organic signal and one that absorbed a follow-up.
            source: "merged",
            lastUpdate: new Date().toLocaleString(),
            mergedFromMessageIds: Array.isArray(ex.mergedFromMessageIds)
              ? [...ex.mergedFromMessageIds, message.id]
              : (ex.messageId ? [ex.messageId, message.id] : [message.id]),
          };
          await redis.lset(signalsKey, i, JSON.stringify(merged));
          await redis.sadd(fingerprintSetKey, fp);
          console.log(
            `[import] Merged signal from ${signal.sender} — updated existing ${ex.id} rather than creating duplicate (adds: ${[
              addsTracking && "tracking",
              addsEta && "eta",
              addsConf && "conf",
              longerDesc && "longerDesc",
            ].filter(Boolean).join("+")})`
          );
          imported++;
          await new Promise(r => setTimeout(r, 1000));
          absorbedByFollowUpMerge = true;
          break;
        }
      }
      if (absorbedByFollowUpMerge) continue;

      let dupIndex = -1;
      let dupExisting = null;
      for (let i = 0; i < recent.length; i++) {
        if (isSemanticDuplicate(signal, recent[i])) {
          dupIndex = i;
          dupExisting = recent[i];
          break;
        }
      }

      if (dupIndex !== -1) {
        // Existing signals stored before this change have no numeric
        // confidence — recompute it on the fly so the comparison is
        // apples-to-apples.
        const exConfidence =
          typeof dupExisting.confidence === "number"
            ? dupExisting.confidence
            : signalConfidenceScore(dupExisting);
        if (signal.confidence > exConfidence) {
          // New one is richer — replace the existing record in place.
          // Carry forward state/notedAt from the existing signal where
          // they exist, since those represent user intent we don't want
          // to lose.
          const merged = {
            ...signal,
            id: dupExisting.id,
            state: dupExisting.state || signal.state,
            notedAt: dupExisting.notedAt || signal.notedAt,
          };
          await redis.lset(signalsKey, dupIndex, JSON.stringify(merged));
          await redis.sadd(fingerprintSetKey, fp);
          console.log(
            `[import] Merged signal ${signal.id} into ${dupExisting.id} (confidence ${signal.confidence} > ${exConfidence}, replaced): "${(signal.description || "").slice(0, 60)}"`
          );
          imported++;
        } else {
          console.log(
            `[import] Merged signal ${signal.id} into ${dupExisting.id} (confidence ${signal.confidence} <= ${exConfidence}, kept existing): "${(signal.description || "").slice(0, 60)}"`
          );
        }
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      // Recurring pattern detection — stamps the signal in place if 2+
      // prior signals from the same sender+type exist in the last 90
      // days. Writes the pattern record to household:{id}:patterns.
      // Done BEFORE LPUSH so the signal lands with recurring fields
      // already attached.
      try {
        await detectAndStampRecurring(householdId, signal);
      } catch (err) {
        console.error("[recurring] detection error:", err?.message || err);
      }

      // Thread detection — groups related signals (same sender within
      // 30d, ETA within 7d of an existing same-sender signal, or
      // shared destination/city keyword). Stamps threadId on the new
      // signal AND backfills onto matched existing signals so the
      // brief and Hover can narrate/render them as one item.
      try {
        await detectAndStampThread(householdId, signal);
      } catch (err) {
        console.error("[thread] detection error:", err?.message || err);
      }

      // Location extraction — service / appointment / reservation
      // signals get a Google Places lookup so the brief and Hover
      // can surface address/lat/lng and (downstream) compute travel
      // time vs. household location. Best-effort + credential-gated;
      // returns null when GOOGLE_PLACES_KEY isn't set or no match.
      if (
        !signal.location &&
        (signal.type === "service" ||
          signal.type === "appointment" ||
          signal.type === "reservation")
      ) {
        try {
          const place = await extractSignalLocation(signal.description, signal.sender);
          if (place) {
            signal.location = place;
            console.log(
              `[places] resolved location for ${signal.sender || "unknown"}: ${place.name}`
            );
          }
        } catch (err) {
          console.warn("[places] location lookup error:", err?.message || err);
        }
      }

      // Tracking extraction — package-typed signals get scanned for
      // carrier tracking numbers. The first hit stamps onto the
      // signal so the cron and the mobile UI can surface live status.
      // AMZL packages get their initial status from the email body
      // since Amazon has no public tracking API.
      if (signal.type === "package" && !signal.trackingNumber) {
        try {
          const hits = extractTrackingNumbers(`${subject || ""}\n${emailText || ""}`);
          if (hits.length > 0) {
            const { trackingNumber, carrier } = hits[0];
            signal.trackingNumber = trackingNumber;
            signal.carrier = carrier;
            if (carrier === "AMZL") {
              const amzl = parseAmazonDeliveryEmail(emailText || "");
              if (amzl) {
                signal.status = amzl.status;
                if (amzl.note) signal.statusNote = amzl.note;
                if (amzl.status === "Delivered") {
                  signal.state = "resolved";
                  signal.resolvedAt = new Date().toISOString();
                  signal.resolvedBy = "amzl-parse";
                  // Stamp createdAt so the same-cycle resolve still
                  // contributes to Commons. Without it writeCommons
                  // bails (NaN createdAt → 0-day resolution undefined).
                  signal.createdAt = Date.now();
                  // Auto-resolves outside the PATCH path need memory +
                  // Commons writes here so Took Care Of and Commons
                  // stats both reflect them.
                  try {
                    await logAutoResolvedMemory(householdId, signal, "amzl-parse");
                    await writeCommonsRecord(householdId, signal);
                  } catch (err) {
                    console.warn("[amzl] post-resolve write failed:", err?.message || err);
                  }
                }
              }
            }
          }
        } catch (err) {
          console.error("[tracking] extraction error:", err?.message || err);
        }
      }

      // Crew sender auto-attribution — check senderPatterns on every
      // crew member. First match wins; the signal lands with
      // crewMemberId stamped so the brief can prefix appropriately
      // and the mobile UI knows which crew card to associate it with.
      try {
        const rawCrew = await redis.get(`household:${householdId}:crew`);
        const crew = (() => {
          if (!rawCrew) return [];
          try { return Array.isArray(rawCrew) ? rawCrew : JSON.parse(rawCrew); } catch { return []; }
        })();
        const senderNorm = (signal.sender || "").toLowerCase().trim();
        if (senderNorm && Array.isArray(crew)) {
          for (const member of crew) {
            const patterns = Array.isArray(member?.senderPatterns) ? member.senderPatterns : [];
            const hit = patterns.some((p) => String(p || "").toLowerCase().trim() === senderNorm);
            if (hit && member.name) {
              signal.crewMemberId = member.name;
              console.log(
                `[crew] auto-attributed signal from ${signal.sender} → ${member.name}`
              );
              break;
            }
          }
        }
      } catch (err) {
        console.warn("[crew] auto-attribution error:", err?.message || err);
      }

      await redis.lpush(signalsKey, JSON.stringify(signal));
      await redis.sadd(fingerprintSetKey, fp);
      imported++;

      // Provider extraction — runs only when the signal looks like a
      // service-company touchpoint (classified type "service" or sender
      // local part contains service-y stems). One additional Haiku call
      // per qualifying email; null/skip when the email is from a generic
      // marketplace without a specific business.
      if (isLikelyServiceEmail(signal, from)) {
        try {
          const provider = await extractProvider(subject, from, emailText);
          if (provider) {
            await upsertProvider(householdId, provider);
          }
        } catch (err) {
          console.error("[provider] extraction error:", err?.message || err);
        }
      }

      // Initial carrier hit for non-AMZL trackables. Best-effort, no
      // await on the signal itself — the cron will pick it up on the
      // next run if this call doesn't return anything useful right
      // now. Skipped for AMZL since there's no API, and skipped when
      // the trackPackage helper returns null (missing creds or
      // unknown carrier).
      if (signal.trackingNumber && signal.carrier && signal.carrier !== "AMZL") {
        applyTrackingUpdate(householdId, signal).catch((err) =>
          console.error("[tracking] initial fetch error:", err?.message || err)
        );
      }

      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      console.error("Error:", err.message);
      continue;
    }
  }

  return { imported };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { userId, query } = req.body;

  if (!userId) {
    return res.status(400).json({ error: "No userId provided" });
  }

  try {
    const result = await runImport(userId, typeof query === "string" ? query : null);
    return res.status(200).json(result);
  } catch (error) {
    console.error("Import error:", error);
    return res.status(500).json({ error: "Import failed" });
  }
}
