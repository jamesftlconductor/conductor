// Microsoft Graph contacts + extended-window calendar deep-scan.
// Builds on the OAuth flow shipped in api/outlook/*.js and the
// import path in api/outlook-import.js. Designed to run once on
// initial onboard sweep, then weekly via sync.js.
//
// Output shape mirrors what a future runContactsImport for Google
// would produce — the onboard-worker can call either path and get
// matching crew/provider/birthday discoveries to feed into the
// reveal.
//
// Credential-gated on MICROSOFT_CLIENT_ID/_SECRET via the shared
// getValidOutlookToken helper. Returns { crewFound, providersFound,
// birthdaysFound, eventsScanned, recurringPatternsFound } so the
// reveal can credit the source line by line.

import { Redis } from "@upstash/redis";
import { getValidOutlookToken } from "./outlook-token.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const GRAPH = "https://graph.microsoft.com/v1.0";
const DAY_MS = 24 * 60 * 60 * 1000;

// Heuristics for classifying a contact as a provider vs a household
// crew member. Job-title prefixes are the strongest signal; company
// patterns are a secondary cue. Anything that doesn't match either
// stays unclassified and is dropped — we don't auto-create crew
// members from arbitrary contacts because the false-positive cost is
// high (an old client's name landing in Crew is worse than a missed
// auto-import).

const PROVIDER_TITLE_RE =
  /^\s*(dr\.?|doctor|attorney|md|dds|pa|np|esq\.?|cpa)\b/i;

const PROVIDER_COMPANY_RE =
  /\b(plumb|hvac|electrical|electric|cleaning|landscap|lawn|pest|pool|roof|insurance|attorney|law|medical|clinic|pediatric|dental|dentist|optometr|veterinar|vet\b|pharmacy|appliance|locksmith|painter|handyman|carpet|window|tile|gutter|fence|garage|alarm|security)\b/i;

const SCHOOL_RE = /\b(elementary|middle school|high school|academy|school|preschool|montessori)\b/i;

const FAMILY_REL_RE = /\b(spouse|husband|wife|partner|child|son|daughter|parent|mother|father|sister|brother|grand)\b/i;

// Parse a contact's relationships array (Graph returns this as
// `[{ name, relationship }]`). Returns true if any relationship marker
// suggests this person is family — not a provider, not a coworker.
function looksLikeFamily(c) {
  // Outlook's "relationships" is sparsely populated; the personalNotes
  // field is more common for "wife's friend" / "kids' godmother" etc.
  // We accept either signal.
  const rels = c.relationships;
  if (Array.isArray(rels)) {
    for (const r of rels) {
      const tag = String(r?.relationship || r?.name || "").toLowerCase();
      if (FAMILY_REL_RE.test(tag)) return true;
    }
  }
  if (typeof c.personalNotes === "string" && FAMILY_REL_RE.test(c.personalNotes.toLowerCase())) {
    return true;
  }
  return false;
}

function looksLikeProvider(c) {
  if (typeof c.jobTitle === "string" && PROVIDER_TITLE_RE.test(c.jobTitle)) return true;
  if (typeof c.companyName === "string") {
    if (PROVIDER_COMPANY_RE.test(c.companyName)) return true;
    if (SCHOOL_RE.test(c.companyName)) return true; // school is a provider, not crew
  }
  return false;
}

// Outlook birthday field comes back as ISO datetime (or
// "0001-01-01T08:00:00Z" when unset — Graph's sentinel for null).
// Convert to MM-DD which is what crew records carry. Returns null
// when the date is the sentinel or unparseable.
function parseBirthdayToMMDD(raw) {
  if (!raw || typeof raw !== "string") return null;
  if (raw.startsWith("0001-")) return null;
  const ms = Date.parse(raw);
  if (isNaN(ms)) return null;
  const d = new Date(ms);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// Normalize for crew matching — lowercase, collapse whitespace.
function normalizeName(name) {
  return String(name || "").toLowerCase().replace(/\s+/g, " ").trim();
}

async function fetchContacts(accessToken) {
  // $select trims the response to fields we use. $top=1000 covers
  // the long tail; the few users with >1000 contacts will lose the
  // bottom slice in v1 — Outlook's tail is mostly stale anyway.
  const url =
    `${GRAPH}/me/contacts?` +
    `$select=${encodeURIComponent("displayName,emailAddresses,homePhones,mobilePhone,businessPhones,birthday,personalNotes,companyName,jobTitle")}` +
    `&$top=200`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Graph /me/contacts ${res.status}: ${detail.slice(0, 160)}`);
  }
  const json = await res.json();
  return Array.isArray(json?.value) ? json.value : [];
}

async function fetchExtendedCalendar(accessToken) {
  // ±90 days for recurring-pattern analysis. The standard import
  // window in outlook-import.js is +30 only; that's the brief-feeding
  // window. Deep-scan needs the wider lens to catch monthly
  // appointments and 6-week dentist cycles.
  const start = new Date(Date.now() - 90 * DAY_MS).toISOString();
  const end = new Date(Date.now() + 90 * DAY_MS).toISOString();
  const url =
    `${GRAPH}/me/calendarView?` +
    `startDateTime=${encodeURIComponent(start)}` +
    `&endDateTime=${encodeURIComponent(end)}` +
    `&$select=${encodeURIComponent("subject,start,end,location,attendees,recurrence,bodyPreview")}` +
    `&$top=500`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'outlook.timezone="UTC"',
    },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Graph /me/calendarView ${res.status}: ${detail.slice(0, 160)}`);
  }
  const json = await res.json();
  return Array.isArray(json?.value) ? json.value : [];
}

// Group events by normalized subject and surface ones that recur
// 3+ times in the 180-day window. The frequency tells us about
// the cadence (weekly soccer practice, monthly therapist) which
// the future brief synthesis layer can lean on.
function analyzeRecurringPatterns(events) {
  const buckets = new Map();
  for (const e of events) {
    const subj = normalizeName(e.subject);
    if (!subj) continue;
    if (!buckets.has(subj)) buckets.set(subj, []);
    buckets.get(subj).push(e);
  }
  const patterns = [];
  for (const [subj, items] of buckets) {
    if (items.length < 3) continue;
    // Estimate interval: sort by start ascending, mean the gaps.
    items.sort((a, b) => {
      const aMs = Date.parse(a.start?.dateTime || "") || 0;
      const bMs = Date.parse(b.start?.dateTime || "") || 0;
      return aMs - bMs;
    });
    const gaps = [];
    for (let i = 1; i < items.length; i++) {
      const aMs = Date.parse(items[i - 1].start?.dateTime || "") || 0;
      const bMs = Date.parse(items[i].start?.dateTime || "") || 0;
      if (aMs && bMs) gaps.push((bMs - aMs) / DAY_MS);
    }
    if (gaps.length === 0) continue;
    const avgDays = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    patterns.push({
      subject: items[0].subject,
      occurrences: items.length,
      avgDays: Math.round(avgDays * 10) / 10,
      location: items[items.length - 1].location?.displayName || null,
    });
  }
  return patterns;
}

export async function runOutlookContactsImport(userId) {
  if (!userId) throw new Error("No userId provided");
  const accessToken = await getValidOutlookToken(userId);
  const householdId = (await redis.get(`user:${userId}:household`)) || userId;

  const stats = {
    contactsScanned: 0,
    crewFound: 0,
    providersFound: 0,
    birthdaysFound: 0,
    eventsScanned: 0,
    recurringPatternsFound: 0,
  };

  // ---------- Contacts ----------
  let contacts;
  try {
    contacts = await fetchContacts(accessToken);
  } catch (err) {
    console.error("[outlook-contacts] contacts fetch failed:", err?.message || err);
    contacts = [];
  }
  stats.contactsScanned = contacts.length;

  // Load existing crew so name-matching against current records works.
  // We never overwrite an existing crew member's bio — only add new
  // ones and stamp a birthday when one's available and the field
  // wasn't set.
  let crew = [];
  try {
    const rawCrew = await redis.get(`household:${householdId}:crew`);
    if (rawCrew) {
      const parsed = typeof rawCrew === "string" ? JSON.parse(rawCrew) : rawCrew;
      if (Array.isArray(parsed)) crew = parsed;
    }
  } catch { /* fall through with empty crew */ }
  const crewByName = new Map(crew.map((m) => [normalizeName(m?.name), m]));

  let crewMutated = false;
  const newCrewCandidates = [];
  const newProviderCandidates = [];

  for (const c of contacts) {
    const name = c.displayName || c.givenName || null;
    if (!name) continue;
    const bdayMMDD = parseBirthdayToMMDD(c.birthday);

    // Provider vs crew vs ignore. Providers go to the providers hash
    // (separate flow from this scan, listed for the reveal); crew
    // candidates are surfaced for review rather than auto-added to
    // avoid noise. The exception: a contact with a *birthday* that
    // matches an existing crew member's name fills the birthday gap.
    if (looksLikeProvider(c)) {
      newProviderCandidates.push({
        name,
        company: c.companyName || null,
        title: c.jobTitle || null,
        phones: [c.mobilePhone, ...(c.homePhones || []), ...(c.businessPhones || [])].filter(Boolean),
        emails: (c.emailAddresses || []).map((e) => e.address).filter(Boolean),
        source: "outlook-contacts",
      });
      stats.providersFound++;
      continue;
    }

    if (bdayMMDD) {
      const existing = crewByName.get(normalizeName(name));
      if (existing && !existing.birthday) {
        existing.birthday = bdayMMDD;
        existing.birthdaySource = "outlook-contacts";
        crewMutated = true;
        stats.birthdaysFound++;
        continue;
      }
      if (!existing && looksLikeFamily(c)) {
        // Family-tagged contact with a birthday → strong crew
        // candidate. Surface it but don't auto-insert; the user
        // confirms via the reveal screen.
        newCrewCandidates.push({
          name,
          birthday: bdayMMDD,
          source: "outlook-contacts",
          confidence: "high",
        });
        stats.crewFound++;
        stats.birthdaysFound++;
      }
    }
  }

  if (crewMutated) {
    try {
      await redis.set(`household:${householdId}:crew`, JSON.stringify(crew));
    } catch (err) {
      console.warn("[outlook-contacts] crew write failed:", err?.message || err);
    }
  }

  // Persist candidates for the reveal screen to surface. Stored as a
  // hash rather than appended directly to crew/providers so the user
  // can accept/reject before they land in the live household state.
  try {
    if (newCrewCandidates.length > 0) {
      await redis.set(
        `household:${householdId}:onboardCandidates:crew`,
        JSON.stringify(newCrewCandidates),
        { ex: 14 * 24 * 60 * 60 } // 14d window for the user to act
      );
    }
    if (newProviderCandidates.length > 0) {
      await redis.set(
        `household:${householdId}:onboardCandidates:providers`,
        JSON.stringify(newProviderCandidates),
        { ex: 14 * 24 * 60 * 60 }
      );
    }
  } catch (err) {
    console.warn("[outlook-contacts] candidates write failed:", err?.message || err);
  }

  // ---------- Extended calendar deep-scan ----------
  let events;
  try {
    events = await fetchExtendedCalendar(accessToken);
  } catch (err) {
    console.error("[outlook-contacts] calendar deep-scan fetch failed:", err?.message || err);
    events = [];
  }
  stats.eventsScanned = events.length;
  const patterns = analyzeRecurringPatterns(events);
  stats.recurringPatternsFound = patterns.length;

  // Persist patterns so the brief synthesis layer can read them. We
  // store under a separate key — the existing :patterns hash is
  // keyed by signal-sender, not calendar-subject, so we don't want
  // them to collide.
  try {
    if (patterns.length > 0) {
      await redis.set(
        `household:${householdId}:calendarPatterns:outlook`,
        JSON.stringify(patterns),
        { ex: 30 * 24 * 60 * 60 } // 30d freshness window
      );
    }
  } catch (err) {
    console.warn("[outlook-contacts] patterns write failed:", err?.message || err);
  }

  console.log(
    `[outlook-contacts] ${householdId}: ${stats.contactsScanned} contacts ` +
    `(${stats.crewFound} crew, ${stats.providersFound} providers, ${stats.birthdaysFound} birthdays), ` +
    `${stats.eventsScanned} events, ${stats.recurringPatternsFound} patterns`
  );
  return stats;
}

// Thin HTTP wrapper so manual / cron triggering works.
export default async function handler(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    const result = await runOutlookContactsImport(userId);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("[outlook-contacts] handler error:", err);
    return res.status(500).json({ error: err?.message || "outlook contacts import failed" });
  }
}
