// Contacts sync — pulls a household member's Google Contacts via
// the People API and persists them for fast match lookups (used by
// the email composer to resolve "Snyder AC" → an email address
// without forcing the user to retype).
//
// Routes:
//   GET  /api/contacts?userId=...
//        Returns the cached contact list (refreshes from Google if
//        stale > 24h or missing). { ok, contacts:[{name,email,phone}],
//        fetchedAt, count }.
//   POST /api/contacts?action=refresh
//        body { userId }
//        Force a fresh fetch from People API.
//   POST /api/contacts?action=match
//        body { userId, query }
//        Server-side fuzzy match — returns up to 5 best matches with
//        a confidence hint. Used by the composer when the user types
//        a recipient name.
//
// Storage: household:{id}:contacts — JSON {contacts:[...], fetchedAt}
// with no TTL (we rely on the 24h staleness check on read; persisting
// the last good copy means a transient People-API outage doesn't
// blank the cache).

import { Redis } from "@upstash/redis";
import { getValidToken } from "./refresh.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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

// Fetch Google contacts via the People API, paginated. We request
// names, emailAddresses, phoneNumbers, organizations — enough for
// the composer's recipient resolution + future "see contractor" UI.
async function fetchGoogleContacts(userId) {
  const accessToken = await getValidToken(userId);
  const out = [];
  let pageToken = null;
  let safetyPages = 0;
  do {
    const params = new URLSearchParams({
      personFields: "names,emailAddresses,phoneNumbers,organizations",
      pageSize: "200",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(
      `https://people.googleapis.com/v1/people/me/connections?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      // Common case: contacts.readonly scope not granted on this
      // token. Surface as a structured error so the UI can prompt
      // for re-auth rather than silently returning nothing.
      if (res.status === 403 || /insufficient.*scope/i.test(t)) {
        throw new Error("contacts_scope_missing");
      }
      throw new Error(`people_api_${res.status}`);
    }
    const data = await res.json();
    const connections = data?.connections || [];
    for (const c of connections) {
      const name = c?.names?.[0]?.displayName || null;
      const email = c?.emailAddresses?.[0]?.value || null;
      const phone = c?.phoneNumbers?.[0]?.value || null;
      const company = c?.organizations?.[0]?.name || null;
      if (!name && !email && !phone) continue;
      out.push({ name, email, phone, company });
    }
    pageToken = data?.nextPageToken || null;
    safetyPages += 1;
  } while (pageToken && safetyPages < 20);
  return out;
}

async function loadCached(householdId) {
  const raw = await redis.get(`household:${householdId}:contacts`);
  return safeJson(raw);
}

async function saveCache(householdId, contacts) {
  const payload = {
    contacts,
    fetchedAt: new Date().toISOString(),
    count: contacts.length,
  };
  await redis.set(`household:${householdId}:contacts`, JSON.stringify(payload));
  return payload;
}

function isFresh(cached) {
  if (!cached?.fetchedAt) return false;
  const ts = Date.parse(cached.fetchedAt);
  if (isNaN(ts)) return false;
  return Date.now() - ts < CACHE_TTL_MS;
}

// Simple substring + token-overlap scoring. We're not trying to be
// Google's matching algorithm — just enough that "Snyder AC" finds
// "Snyder Air Conditioning" and "Sarah" finds "Sarah Reinhart".
function scoreMatch(query, contact) {
  if (!contact) return 0;
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const hay = [contact.name, contact.email, contact.company]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!hay) return 0;
  if (hay.includes(q)) return 100;
  const qTokens = q.split(/\s+/).filter(Boolean);
  const hayTokens = new Set(hay.split(/[\s,.@-]+/).filter(Boolean));
  let hits = 0;
  for (const t of qTokens) {
    if (hayTokens.has(t)) hits += 1;
    else {
      for (const h of hayTokens) {
        if (h.startsWith(t) || t.startsWith(h)) {
          hits += 0.5;
          break;
        }
      }
    }
  }
  if (!qTokens.length) return 0;
  return Math.round((hits / qTokens.length) * 80);
}

function matchContacts(query, contacts) {
  const scored = (contacts || [])
    .map((c) => ({ contact: c, score: scoreMatch(query, c) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map(({ contact, score }) => ({
    ...contact,
    confidence: score,
  }));
}

// ---------- Handler ----------

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const action = req.query?.action || req.body?.action;

  if (req.method === "GET") {
    const userId = req.query?.userId;
    if (!userId) return res.status(400).json({ error: "userId required" });
    const householdId = await resolveHouseholdId(userId);
    if (!householdId) return res.status(400).json({ error: "no household" });

    const cached = await loadCached(householdId);
    if (cached && isFresh(cached)) {
      return res.status(200).json({
        ok: true,
        contacts: cached.contacts || [],
        count: cached.contacts?.length || 0,
        fetchedAt: cached.fetchedAt,
        fromCache: true,
      });
    }
    try {
      const fresh = await fetchGoogleContacts(userId);
      const payload = await saveCache(householdId, fresh);
      return res.status(200).json({ ok: true, ...payload, fromCache: false });
    } catch (err) {
      // Fall back to stale cache if we have one — better than
      // breaking the composer for a transient scope or API error.
      if (cached?.contacts?.length) {
        return res.status(200).json({
          ok: true,
          contacts: cached.contacts,
          count: cached.contacts.length,
          fetchedAt: cached.fetchedAt,
          fromCache: true,
          warning: err?.message || "fresh fetch failed",
        });
      }
      const code = err?.message === "contacts_scope_missing" ? 403 : 502;
      return res.status(code).json({
        ok: false,
        error: err?.message || "contacts fetch failed",
      });
    }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  const householdId = await resolveHouseholdId(userId);
  if (!householdId) return res.status(400).json({ error: "no household" });

  if (action === "refresh") {
    try {
      const fresh = await fetchGoogleContacts(userId);
      const payload = await saveCache(householdId, fresh);
      return res.status(200).json({ ok: true, ...payload });
    } catch (err) {
      const code = err?.message === "contacts_scope_missing" ? 403 : 502;
      return res.status(code).json({
        ok: false,
        error: err?.message || "contacts refresh failed",
      });
    }
  }

  if (action === "match") {
    const { query } = req.body || {};
    if (!query || !String(query).trim()) {
      return res.status(400).json({ error: "query required" });
    }
    let cached = await loadCached(householdId);
    if (!cached || !cached.contacts?.length) {
      // Try a fresh fetch if we have nothing — best-effort.
      try {
        const fresh = await fetchGoogleContacts(userId);
        cached = await saveCache(householdId, fresh);
      } catch {
        // proceed with empty matches
      }
    }
    const matches = matchContacts(query, cached?.contacts || []);
    return res.status(200).json({
      ok: true,
      query,
      matches,
      cacheCount: cached?.contacts?.length || 0,
    });
  }

  return res.status(400).json({
    error: "Unknown action — use GET, ?action=refresh, ?action=match",
  });
}

// ====================================================================
// Deep scan — pulls a richer field set from People API + the
// Birthdays calendar + ±90d primary calendar. Produces crew /
// provider / birthday / network / activity / recurring-pattern
// findings for the onboard reveal. Returns a stats object the
// worker stamps onto the reveal payload.
//
// This is a SEPARATE entry point from the lightweight contact sync
// above (used by the email composer for recipient resolution).
// Calling runContactsDeepScan is a heavier-weight operation —
// designed to run once on initial onboard and on user-triggered
// refresh, not on every sync.
// ====================================================================

const FAMILY_REL_TYPES = new Set([
  "spouse", "partner", "domesticPartner",
  "child", "son", "daughter",
  "parent", "mother", "father",
  "brother", "sister", "sibling",
]);

const PROVIDER_TITLE_RE_GOOG =
  /\b(dr\.?|doctor|attorney|md|dds|dmd|pa|np|esq\.?|cpa|realtor|agent|broker)\b/i;
const PROVIDER_COMPANY_RE_GOOG =
  /\b(plumb|hvac|electrical|electric|cleaning|landscap|lawn|pest|pool|roof|insurance|attorney|law|medical|clinic|pediatric|dental|dentist|optometr|veterinar|vet\b|pharmacy|appliance|locksmith|painter|handyman|carpet|window|tile|gutter|fence|garage|alarm|security|orthodont|chiropract|therapy|therapist|massage|spa|salon)\b/i;
const SCHOOL_RE_GOOG = /\b(elementary|middle school|high school|academy|preschool|montessori|university|college)\b/i;
const FAMILY_TEXT_RE = /\b(wife|husband|spouse|partner|son|daughter|kid|child|mom|dad|mother|father|grandma|grandpa|granddad|grandmother|grandfather|sister|brother|grand)\b/i;
const ACTION_VERBS_RE = /\b(bring|pay|register|confirm|schedule|call|renew|email|submit|file|sign|drop\s*off|pick\s*up)\b/i;

function normalizeNameDeep(name) {
  return String(name || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Levenshtein-free similarity for name matching — works on the cheap
// "all tokens in common, regardless of order" basis. Good enough for
// "Sarah Rein" vs "Sarah Marie Rein" vs "Sarah" matching.
function nameSimilarity(a, b) {
  const na = normalizeNameDeep(a);
  const nb = normalizeNameDeep(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  const intersection = [...ta].filter((t) => tb.has(t));
  const longer = Math.max(ta.size, tb.size);
  return longer > 0 ? intersection.length / longer : 0;
}

// Parse a People-API birthdays[].date object — { month, day, year? } —
// into a MM-DD string. Year-less birthdays are normal in Google
// Contacts (people often skip the year for privacy).
function birthdayToMMDD(b) {
  if (!b || !b.date) return null;
  const m = Number(b.date.month);
  const d = Number(b.date.day);
  if (!m || !d) return null;
  return `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Pull a person's relations array and return the family-relationship
// type when it points at a household member, otherwise null.
function familyRelationType(person) {
  const rels = Array.isArray(person.relations) ? person.relations : [];
  for (const r of rels) {
    const t = String(r?.type || r?.formattedType || "").toLowerCase();
    if (FAMILY_REL_TYPES.has(t)) return t;
  }
  return null;
}

function isProviderContact(person) {
  const orgs = Array.isArray(person.organizations) ? person.organizations : [];
  for (const o of orgs) {
    const title = String(o?.title || "").toLowerCase();
    const company = String(o?.name || "").toLowerCase();
    if (PROVIDER_TITLE_RE_GOOG.test(title)) return true;
    if (PROVIDER_COMPANY_RE_GOOG.test(company)) return true;
    if (SCHOOL_RE_GOOG.test(company)) return true;
  }
  // Biography fallback — sometimes the user wrote "the kids' pediatrician" with
  // no formal organization record.
  const bio = (Array.isArray(person.biographies) ? person.biographies[0]?.value : "") || "";
  if (PROVIDER_TITLE_RE_GOOG.test(bio.toLowerCase())) return true;
  return false;
}

function relationToCrewType(relType) {
  if (!relType) return null;
  if (relType === "spouse" || relType === "partner" || relType === "domesticPartner") {
    return { memberType: "adult", relationship: "partner" };
  }
  if (relType === "child" || relType === "son" || relType === "daughter") {
    return { memberType: "child", relationship: null };
  }
  if (relType === "parent" || relType === "mother" || relType === "father") {
    return { memberType: "adult", relationship: "parent" };
  }
  if (relType === "brother" || relType === "sister" || relType === "sibling") {
    return { memberType: "adult", relationship: "sibling" };
  }
  return null;
}

async function fetchGooglePersonsDeep(accessToken) {
  const out = [];
  let pageToken = null;
  let safety = 0;
  do {
    const params = new URLSearchParams({
      personFields:
        "names,emailAddresses,phoneNumbers,birthdays,relations,memberships,organizations,biographies,addresses",
      pageSize: "200",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(
      `https://people.googleapis.com/v1/people/me/connections?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`people/me/connections ${res.status}: ${detail.slice(0, 140)}`);
    }
    const json = await res.json();
    const batch = Array.isArray(json?.connections) ? json.connections : [];
    out.push(...batch);
    pageToken = json?.nextPageToken || null;
    safety++;
  } while (pageToken && safety < 10);
  return out;
}

async function fetchBirthdaysCalendar(accessToken) {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 365 * 86400000).toISOString();
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/` +
    encodeURIComponent("contacts@contacts.google.com/events") +
    `?maxResults=500&singleEvents=true` +
    `&timeMin=${encodeURIComponent(now)}` +
    `&timeMax=${encodeURIComponent(future)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return [];
  const json = await res.json();
  return Array.isArray(json?.items) ? json.items : [];
}

async function fetchPrimaryCalendarWindow(accessToken) {
  const start = new Date(Date.now() - 90 * 86400000).toISOString();
  const end = new Date(Date.now() + 90 * 86400000).toISOString();
  const params = new URLSearchParams({
    timeMin: start,
    timeMax: end,
    maxResults: "1000",
    singleEvents: "true",
    fields: "items(id,summary,location,attendees,recurringEventId,start,end,description)",
  });
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return [];
  const json = await res.json();
  return Array.isArray(json?.items) ? json.items : [];
}

// Recurring-pattern grouping. Two cues identify a recurring slot:
// (a) shared recurringEventId across multiple instances, (b) 3+
// occurrences of an identical summary in the window. (b) catches
// pseudo-recurring entries (manually re-created weekly meetings)
// that don't have a parent recurrence rule.
function groupRecurringEvents(events) {
  const byRecId = new Map();
  const bySummary = new Map();
  for (const e of events) {
    if (e.recurringEventId) {
      const k = e.recurringEventId;
      if (!byRecId.has(k)) byRecId.set(k, []);
      byRecId.get(k).push(e);
    } else {
      const k = normalizeNameDeep(e.summary);
      if (!k) continue;
      if (!bySummary.has(k)) bySummary.set(k, []);
      bySummary.get(k).push(e);
    }
  }
  const patterns = [];
  for (const [, list] of byRecId) {
    if (list.length >= 2) patterns.push({ items: list });
  }
  for (const [, list] of bySummary) {
    if (list.length >= 3) patterns.push({ items: list });
  }
  return patterns;
}

function extractActivityFromSummary(summary) {
  // Heuristics: split on common delimiters then heuristically pick
  // a person name (capitalized single token) vs an activity phrase.
  if (!summary) return { person: null, activity: summary };
  const parts = String(summary).split(/\s*[-–—:]\s*/).filter(Boolean);
  if (parts.length >= 2) {
    // Either "Person - Activity" or "Activity - Person" — pick the
    // shorter capitalized side as the person.
    const a = parts[0].trim();
    const b = parts.slice(1).join(" ").trim();
    const aIsName = /^[A-Z][a-z]+( [A-Z][a-z]+)?$/.test(a);
    const bIsName = /^[A-Z][a-z]+( [A-Z][a-z]+)?$/.test(b);
    if (aIsName && !bIsName) return { person: a, activity: b };
    if (bIsName && !aIsName) return { person: b, activity: a };
  }
  // Pattern: "Name Activity" — first capitalized token is name when
  // the rest looks like a verb-noun ("Soccer Practice", "Piano Lesson").
  const m = String(summary).match(/^([A-Z][a-z]+)\s+(.+)$/);
  if (m) return { person: m[1], activity: m[2] };
  return { person: null, activity: summary };
}

export async function runContactsDeepScan(userId) {
  if (!userId) throw new Error("No userId provided");
  let accessToken;
  try {
    accessToken = await getValidToken(userId);
  } catch (err) {
    return { skipped: `no Google token: ${err?.message}` };
  }
  const householdId = (await redis.get(`user:${userId}:household`)) || userId;

  const stats = {
    contactsScanned: 0,
    crewMembersFound: 0,
    providersFound: 0,
    birthdaysFound: 0,
    activitiesFound: 0,
    networkCandidates: 0,
    calendarEventsScanned: 0,
    signalsFromCalendar: 0,
  };

  // --- People API contacts ---
  let persons = [];
  try {
    persons = await fetchGooglePersonsDeep(accessToken);
  } catch (err) {
    console.warn("[contacts-deep] persons fetch failed:", err?.message || err);
  }
  stats.contactsScanned = persons.length;

  // Load existing crew so we can birthday-fill in place rather than
  // duplicating records. New candidates surface for user review.
  let crew = [];
  try {
    const rawCrew = await redis.get(`household:${householdId}:crew`);
    if (rawCrew) {
      const parsed = typeof rawCrew === "string" ? JSON.parse(rawCrew) : rawCrew;
      if (Array.isArray(parsed)) crew = parsed;
    }
  } catch { /* empty crew */ }
  let crewMutated = false;
  const newCrewCandidates = [];
  const newProviderCandidates = [];

  for (const p of persons) {
    const name = p.names?.[0]?.displayName || p.names?.[0]?.givenName;
    if (!name) continue;
    const bdayMMDD = birthdayToMMDD(Array.isArray(p.birthdays) ? p.birthdays[0] : null);
    const relType = familyRelationType(p);
    const isProvider = isProviderContact(p);

    if (relType) {
      const crewShape = relationToCrewType(relType);
      // Match against existing crew by name similarity.
      const match = crew.find((m) => nameSimilarity(m?.name, name) >= 0.8);
      if (match) {
        if (bdayMMDD && !match.birthday) {
          match.birthday = bdayMMDD;
          match.birthdaySource = "google-contacts";
          crewMutated = true;
          stats.birthdaysFound++;
        }
      } else {
        newCrewCandidates.push({
          name,
          birthday: bdayMMDD || null,
          ...crewShape,
          source: "google-contacts",
          confidence: "high",
        });
        stats.crewMembersFound++;
        if (bdayMMDD) stats.birthdaysFound++;
      }
      continue;
    }

    if (isProvider) {
      const org = Array.isArray(p.organizations) ? p.organizations[0] : null;
      newProviderCandidates.push({
        name,
        company: org?.name || null,
        title: org?.title || null,
        phones: (p.phoneNumbers || []).map((x) => x?.value).filter(Boolean),
        emails: (p.emailAddresses || []).map((x) => x?.value).filter(Boolean),
        source: "google-contacts",
      });
      stats.providersFound++;
      continue;
    }

    // Bio-text family hint — softer than relations, surface as
    // medium-confidence crew candidate.
    const bio = (Array.isArray(p.biographies) ? p.biographies[0]?.value : "") || "";
    if (bio && FAMILY_TEXT_RE.test(bio.toLowerCase()) && bdayMMDD) {
      newCrewCandidates.push({
        name,
        birthday: bdayMMDD,
        memberType: "adult",
        source: "google-contacts-bio",
        confidence: "medium",
      });
      stats.crewMembersFound++;
      stats.birthdaysFound++;
    }
  }

  // --- Birthdays calendar ---
  try {
    const bdayEvents = await fetchBirthdaysCalendar(accessToken);
    for (const ev of bdayEvents) {
      const m = (ev.summary || "").match(/^(.+?)['’]s Birthday$/i);
      if (!m) continue;
      const personName = m[1].trim();
      const dateStr = ev.start?.date;
      if (!dateStr) continue;
      const [, mm, dd] = dateStr.match(/^\d{4}-(\d{2})-(\d{2})/) || [];
      if (!mm || !dd) continue;
      const mmdd = `${mm}-${dd}`;
      const match = crew.find((c) => nameSimilarity(c?.name, personName) >= 0.8);
      if (match && !match.birthday) {
        match.birthday = mmdd;
        match.birthdaySource = "google-birthdays-calendar";
        crewMutated = true;
        stats.birthdaysFound++;
      }
    }
  } catch (err) {
    console.warn("[contacts-deep] birthdays calendar failed:", err?.message || err);
  }

  if (crewMutated) {
    try {
      await redis.set(`household:${householdId}:crew`, JSON.stringify(crew));
    } catch (err) {
      console.warn("[contacts-deep] crew write failed:", err?.message || err);
    }
  }

  // Persist candidates (14d TTL — same as Outlook contacts).
  const candTtl = 14 * 24 * 60 * 60;
  try {
    if (newCrewCandidates.length > 0) {
      await redis.set(
        `household:${householdId}:onboardCandidates:crew`,
        JSON.stringify(newCrewCandidates),
        { ex: candTtl }
      );
    }
    if (newProviderCandidates.length > 0) {
      await redis.set(
        `household:${householdId}:onboardCandidates:providers`,
        JSON.stringify(newProviderCandidates),
        { ex: candTtl }
      );
    }
  } catch (err) {
    console.warn("[contacts-deep] candidates write failed:", err?.message || err);
  }

  // --- Calendar deep scan (±90d primary) ---
  let events = [];
  try {
    events = await fetchPrimaryCalendarWindow(accessToken);
  } catch (err) {
    console.warn("[contacts-deep] calendar fetch failed:", err?.message || err);
  }
  stats.calendarEventsScanned = events.length;

  // Recurring patterns → crew activities + provider candidates.
  const patterns = groupRecurringEvents(events);
  const attendeeFreq = new Map();
  const calendarSignals = [];

  for (const e of events) {
    // Attendee frequency tracking — external emails appearing in
    // 3+ events become network candidates.
    for (const att of e.attendees || []) {
      const email = att?.email;
      if (!email || /^(group|noreply|do-not-reply)@|@(resource|group)\.calendar/.test(email)) continue;
      attendeeFreq.set(email, (attendeeFreq.get(email) || 0) + 1);
    }
    // Description-action signals.
    if (e.description && ACTION_VERBS_RE.test(e.description)) {
      const eta = e.start?.dateTime || e.start?.date;
      if (eta) {
        calendarSignals.push({
          description: String(e.description).slice(0, 100),
          eta,
          source: "calendar_description",
          type: "reminder",
        });
      }
    }
  }
  stats.signalsFromCalendar = calendarSignals.length;

  // Recurring → activities. Match person name to existing crew;
  // otherwise stash as a recurring pattern record only (no crew
  // candidate inserted from calendar alone — too noisy).
  for (const pat of patterns) {
    const first = pat.items[0];
    const summary = first.summary;
    const { person, activity } = extractActivityFromSummary(summary);
    if (person) {
      const match = crew.find((c) => nameSimilarity(c?.name, person) >= 0.8);
      if (match) {
        match.activities = Array.isArray(match.activities) ? match.activities : [];
        const exists = match.activities.find((a) => normalizeNameDeep(a.name) === normalizeNameDeep(activity));
        if (!exists) {
          // Compute a coarse cadence: first→last occurrence span / count.
          const startMs = Date.parse(first.start?.dateTime || first.start?.date || "");
          const lastItem = pat.items[pat.items.length - 1];
          const endMs = Date.parse(lastItem.start?.dateTime || lastItem.start?.date || "");
          const avgDays = pat.items.length > 1 && startMs && endMs
            ? Math.round(((endMs - startMs) / 86400000) / (pat.items.length - 1))
            : null;
          match.activities.push({
            name: activity,
            occurrences: pat.items.length,
            avgDays,
            location: first.location || null,
            source: "calendar_recurring",
          });
          stats.activitiesFound++;
          crewMutated = true;
        }
      }
    }
    // Provider from event location (when location looks like a business name).
    if (first.location && /\b(clinic|dental|dentist|pediatric|orthodont|medical|veterinar|studio|gym|center|salon|spa)\b/i.test(first.location)) {
      newProviderCandidates.push({
        name: first.location.split(",")[0].trim(),
        source: "calendar_location",
        relatedActivity: activity,
      });
      stats.providersFound++;
    }
  }
  if (crewMutated) {
    try {
      await redis.set(`household:${householdId}:crew`, JSON.stringify(crew));
    } catch (err) {
      console.warn("[contacts-deep] crew activities write failed:", err?.message || err);
    }
  }

  // Network candidates — emails seen in 3+ events.
  const netCands = [...attendeeFreq.entries()].filter(([, n]) => n >= 3).map(([email]) => email);
  if (netCands.length > 0) {
    try {
      await redis.sadd(`household:${householdId}:networkCandidates`, ...netCands);
      stats.networkCandidates = netCands.length;
    } catch (err) {
      console.warn("[contacts-deep] networkCandidates SADD failed:", err?.message || err);
    }
  }

  // Calendar-derived signals → push into household signals list.
  // confidence:4 so they don't dominate the brief; the user can edit
  // / dismiss as the description was partially heuristic.
  if (calendarSignals.length > 0) {
    const signalsKey = `household:${householdId}:signals`;
    const now = Date.now();
    for (let i = 0; i < calendarSignals.length; i++) {
      const s = calendarSignals[i];
      const record = {
        id: now + i,
        description: s.description,
        type: s.type,
        eta: s.eta,
        sender: "Calendar",
        state: "incoming",
        source: s.source,
        confidence: 4,
        userId,
        lastUpdate: new Date(now).toLocaleString(),
        createdAt: now,
      };
      try {
        await redis.lpush(signalsKey, JSON.stringify(record));
      } catch (err) {
        console.warn("[contacts-deep] calendar signal lpush failed:", err?.message || err);
        break;
      }
    }
  }

  // Persist patterns for the brief synthesis layer (mirrors the
  // Outlook patterns key — separate sub-key per driver).
  try {
    if (patterns.length > 0) {
      const compact = patterns.slice(0, 25).map((pat) => {
        const first = pat.items[0];
        const { person, activity } = extractActivityFromSummary(first.summary);
        return {
          subject: first.summary,
          person,
          activity,
          occurrences: pat.items.length,
          location: first.location || null,
        };
      });
      await redis.set(
        `household:${householdId}:calendarPatterns:google`,
        JSON.stringify(compact),
        { ex: 30 * 24 * 60 * 60 }
      );
    }
  } catch (err) {
    console.warn("[contacts-deep] patterns write failed:", err?.message || err);
  }

  console.log(
    `[contacts-deep] ${householdId}: ${stats.contactsScanned} contacts ` +
    `(${stats.crewMembersFound} crew, ${stats.providersFound} providers, ${stats.birthdaysFound} bdays), ` +
    `${stats.calendarEventsScanned} events, ${patterns.length} patterns, ${stats.activitiesFound} activities, ` +
    `${stats.networkCandidates} network candidates, ${stats.signalsFromCalendar} calendar signals`
  );
  return stats;
}

