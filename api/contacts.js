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
