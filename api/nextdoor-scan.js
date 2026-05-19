// Nextdoor neighborhood scan — fetches recent posts and routes them
// into Conductor's existing surfaces by category:
//
//   - safety / crime / alert       → high-urgency signal (type:
//                                     'local_safety') pushed to
//                                     household:{id}:signals, surfaced
//                                     in brief regardless of load.
//   - recommendation               → anonymous record into
//                                     commons:providers:{provider}:{region}
//                                     so future intelligence queries
//                                     can credit neighborhood data.
//   - lost_found (pet-related)     → quiet note pushed to localEvents;
//                                     brief.js surfaces only when the
//                                     household has a Crew pet.
//   - local_deal / event           → tier-3 localEvents entry, surfaced
//                                     only on quiet brief days.
//
// All writes are best-effort. The scan returns a stats object so the
// onboard reveal can credit the source line by line.

import { Redis } from "@upstash/redis";
import { getValidNextdoorToken } from "./nextdoor-token.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const POSTS_URL = "https://api.nextdoor.com/v3/posts";
const FETCH_TIMEOUT_MS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Categories requested on the API call. Mirror Nextdoor's documented
// taxonomy. The Partner API may rename these over time — the routing
// below uses prefix matches so 'crime_and_safety' and 'safety' both
// land in the safety bucket.
const REQUESTED_CATEGORIES = "local_deals,recommendations,lost_found,safety";

function isSafetyPost(post) {
  const cat = String(post?.category || "").toLowerCase();
  if (cat.includes("safety") || cat.includes("crime") || cat.includes("alert")) return true;
  // Body fallback for posts that come through with a generic
  // category — the body wording is the strongest signal.
  const body = (post?.body || post?.summary || "").toLowerCase();
  if (/\b(break.?in|burglary|stolen|attempted|robbery|police|suspicious)\b/.test(body)) return true;
  return false;
}

function isRecommendation(post) {
  const cat = String(post?.category || "").toLowerCase();
  return cat.includes("recommendation");
}

function isLostFound(post) {
  const cat = String(post?.category || "").toLowerCase();
  return cat.includes("lost") || cat.includes("found");
}

function isLocalDeal(post) {
  const cat = String(post?.category || "").toLowerCase();
  return cat.includes("deal") || cat.includes("event");
}

// Lightweight extractor: pulls a sender/provider name out of a
// recommendation post. Nextdoor recommendation posts typically read
// "Recommend X for Y" or similar; this regex finds the X token.
function extractProviderName(body) {
  if (!body) return null;
  const m =
    body.match(/recommend(?:ed|s)?\s+([A-Z][A-Za-z0-9&'.\- ]{2,40})/) ||
    body.match(/use[ds]?\s+([A-Z][A-Za-z0-9&'.\- ]{2,40})\s+for/);
  return m ? m[1].trim() : null;
}

function normalizeProvider(name) {
  if (!name) return "";
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b(inc|llc|corp|co|ltd|company)\b\.?/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

async function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function runNextdoorScan(userId) {
  if (!userId) throw new Error("No userId provided");
  let accessToken;
  try {
    accessToken = await getValidNextdoorToken(userId);
  } catch (err) {
    return { skipped: `no Nextdoor token: ${err?.message}` };
  }
  const householdId = (await redis.get(`user:${userId}:household`)) || userId;

  // Region — used as the Commons bucket suffix. Same pattern as
  // commons.js writeCommonsRecord.
  let region = "generic";
  try {
    const rawLoc = await redis.get(`household:${householdId}:location`);
    const loc = (() => {
      if (!rawLoc) return null;
      try { return typeof rawLoc === "string" ? JSON.parse(rawLoc) : rawLoc; } catch { return null; }
    })();
    if (loc?.marketRegion) region = loc.marketRegion;
  } catch { /* fall through */ }

  const url =
    `${POSTS_URL}?` +
    `limit=20&categories=${encodeURIComponent(REQUESTED_CATEGORIES)}`;
  let posts = [];
  try {
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const detail = await res.text();
      console.warn(`[nextdoor] posts ${res.status}: ${detail.slice(0, 160)}`);
      return { skipped: `posts ${res.status}` };
    }
    const json = await res.json();
    posts = Array.isArray(json?.posts) ? json.posts : Array.isArray(json?.results) ? json.results : [];
  } catch (err) {
    console.warn("[nextdoor] posts fetch failed:", err?.message || err);
    return { skipped: `posts fetch: ${err?.message}` };
  }

  const stats = {
    postsScanned: posts.length,
    safetySignals: 0,
    recommendationsToCommons: 0,
    lostFoundEvents: 0,
    dealsEvents: 0,
  };

  // Active dedup — same Nextdoor post id won't re-route on subsequent
  // scans. Cap at 200 entries (Nextdoor returns ~20 per call; 200
  // gives us ~10 scan cycles of dedup window).
  const seenKey = `household:${householdId}:nextdoor:seenPostIds`;
  const localEventsAdditions = [];

  for (const post of posts) {
    const postId = String(post?.id || post?.post_id || "");
    if (!postId) continue;
    const isNew = await redis.sadd(seenKey, postId);
    if (!isNew) continue;

    const body = post.body || post.summary || post.text || "";
    const title = post.title || "";

    if (isSafetyPost(post)) {
      // Tier-1 safety signal — pushed to :signals so the brief picks
      // it up via the normal active-signal pool. Confidence:8 so the
      // confidence gate passes; description includes the post body so
      // the user can act without leaving the app.
      const signal = {
        id: Date.now() + stats.safetySignals,
        description: title || body.slice(0, 100),
        type: "local_safety",
        sender: "Nextdoor",
        eta: null,
        state: "incoming",
        source: "nextdoor",
        confidence: 8,
        urgency: "high",
        nextdoorPostId: postId,
        createdAt: Date.now(),
        lastUpdate: new Date().toLocaleString(),
        userId,
      };
      try {
        await redis.lpush(`household:${householdId}:signals`, JSON.stringify(signal));
        stats.safetySignals++;
      } catch (err) {
        console.warn("[nextdoor] safety signal lpush failed:", err?.message || err);
      }
      continue;
    }

    if (isRecommendation(post)) {
      const providerName = extractProviderName(body);
      if (providerName) {
        const provider = normalizeProvider(providerName);
        if (provider) {
          const key = `commons:providers:${provider}:${region}`;
          const record = {
            // Anonymous: no household identifier, no userId. This is
            // the Commons contract.
            resolutionDays: 0,
            signalType: "recommendation",
            resolvedAt: new Date().toISOString(),
            source: "nextdoor-neighborhood",
          };
          try {
            await redis.lpush(key, JSON.stringify(record));
            await redis.ltrim(key, 0, 99);
            stats.recommendationsToCommons++;
          } catch (err) {
            console.warn("[nextdoor] commons write failed:", err?.message || err);
          }
        }
      }
      continue;
    }

    if (isLostFound(post)) {
      localEventsAdditions.push({
        id: `nextdoor_${postId}`,
        name: title || `Lost/Found: ${body.slice(0, 60)}`,
        date: post.created_at || new Date().toISOString(),
        category: "lost_found",
        source: "nextdoor",
        // Brief.js will surface this only when the household has a
        // Crew member with memberType === 'pet'.
        petRelevant: /\b(dog|cat|pet|puppy|kitten|missing pet)\b/i.test(body),
      });
      stats.lostFoundEvents++;
      continue;
    }

    if (isLocalDeal(post)) {
      localEventsAdditions.push({
        id: `nextdoor_${postId}`,
        name: title || body.slice(0, 60),
        date: post.created_at || new Date().toISOString(),
        category: "local_deal",
        source: "nextdoor",
        tier: 3, // brief.js surfaces tier-3 only on quiet days
      });
      stats.dealsEvents++;
    }
  }

  // Merge into household:{id}:localEvents alongside the Eventbrite
  // feed shipped earlier. The brief consumer reads this whole array
  // and merges with annualEvents — Nextdoor data joins the same lane.
  if (localEventsAdditions.length > 0) {
    try {
      const rawExisting = await redis.get(`household:${householdId}:localEvents`);
      const existing = (() => {
        if (!rawExisting) return [];
        try {
          const parsed = typeof rawExisting === "string" ? JSON.parse(rawExisting) : rawExisting;
          return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
      })();
      // Dedup by id — a re-scan that picks up the same post twice
      // shouldn't double-list.
      const existingIds = new Set(existing.map((e) => e?.id).filter(Boolean));
      const merged = [...existing];
      for (const e of localEventsAdditions) {
        if (!existingIds.has(e.id)) merged.push(e);
      }
      // Drop expired entries (older than 14 days) on each merge so
      // the cache doesn't grow unbounded between TTL resets.
      const cutoff = Date.now() - 14 * DAY_MS;
      const pruned = merged.filter((e) => {
        const ms = Date.parse(e?.date || "");
        return isNaN(ms) || ms >= cutoff;
      });
      await redis.set(
        `household:${householdId}:localEvents`,
        JSON.stringify(pruned),
        { ex: 7 * 24 * 60 * 60 }
      );
    } catch (err) {
      console.warn("[nextdoor] localEvents merge failed:", err?.message || err);
    }
  }

  await redis.set(`user:${userId}:nextdoorLastScan`, new Date().toISOString());

  console.log(
    `[nextdoor] ${householdId}: ${stats.postsScanned} posts → ` +
    `${stats.safetySignals} safety, ${stats.recommendationsToCommons} commons, ` +
    `${stats.lostFoundEvents} lost/found, ${stats.dealsEvents} deals`
  );
  return stats;
}

// Manual / cron trigger.
export default async function handler(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    const result = await runNextdoorScan(userId);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("[nextdoor-scan] handler error:", err);
    return res.status(500).json({ error: err?.message || "nextdoor scan failed" });
  }
}
