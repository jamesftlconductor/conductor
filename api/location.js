// Per-household location storage + auto-detection. Reads
// household:{id}:location with the shape:
//   { city, state, lat, lon, timezone, marketRegion, source, detectedAt }
//
// marketRegion is the rate/vocabulary key consumed by brief.js's Pulse
// prompt, api/ask.js's pricing context, and (future) home-services
// provider queries. Eight buckets total: south_florida, nyc, chicago,
// los_angeles, seattle, boston, miami, generic.
//
// Non-public module — direct hits return 404 in the default handler
// (same convention as calendar-loader).

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// IANA timezone resolver from coordinates. Lazy-loaded so this module
// imports cleanly even if the package isn't installed.
let tzLookupFn = null;
function getTimezoneFromCoords(lat, lon) {
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  if (isNaN(lat) || isNaN(lon)) return null;
  if (!tzLookupFn) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      tzLookupFn = require("tz-lookup");
    } catch {
      return null;
    }
  }
  try { return tzLookupFn(lat, lon); } catch { return null; }
}

// Public helper — used by brief.js, sync.js, notify.js to derive the
// "now" timestamp in the household's local time without needing to
// rewrite location reads everywhere.
export async function getHouseholdTimezone(householdId) {
  if (!householdId) return "America/New_York";
  try {
    const raw = await redis.get(`household:${householdId}:location`);
    const loc = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
    if (loc?.timezone) return loc.timezone;
    if (loc?.lat != null && loc?.lon != null) {
      const tz = getTimezoneFromCoords(loc.lat, loc.lon);
      if (tz) return tz;
    }
  } catch { /* skip */ }
  return "America/New_York";
}

// Returns the current hour in the household's local time as an
// integer 0..23. Used by mode-window checks (Takeoff 7am, Clearance
// 9pm, Overwatch 10pm) so a California household doesn't get pinged
// at the Eastern equivalent.
export async function getHouseholdLocalHour(householdId) {
  const tz = await getHouseholdTimezone(householdId);
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    });
    const hour = parseInt(formatter.format(new Date()), 10);
    if (Number.isFinite(hour)) return hour;
  } catch { /* skip */ }
  return new Date().getHours();
}

// Fort Lauderdale defaults — used both as the literal fallback for
// brief.js's weather fetch and as the marketRegion when location data
// is missing entirely. Kept here so the rest of the code doesn't need
// to know what "no location" maps to.
export const LOCATION_FALLBACK = {
  city: "Fort Lauderdale",
  state: "FL",
  lat: 26.1224,
  lon: -80.1373,
  timezone: "America/New_York",
  marketRegion: "south_florida",
  source: "fallback",
};

// City keyword matchers per region. Order matters — earlier matches
// win, so south_florida claims Miami before the bare "miami" bucket
// would. The "miami" bucket exists for future precision but isn't
// currently the primary path for FL households.
const REGION_RULES = [
  {
    region: "south_florida",
    state: "FL",
    cities: [
      "fort lauderdale", "miami", "hollywood", "boca raton", "west palm beach",
      "delray beach", "pompano beach", "coral springs", "weston", "doral",
      "miami beach", "hialeah", "homestead", "key largo", "key west",
      "jupiter", "stuart", "palm beach gardens", "deerfield beach", "aventura",
    ],
  },
  {
    region: "nyc",
    state: "NY",
    cities: [
      "new york", "manhattan", "brooklyn", "queens", "bronx", "staten island",
      "long island city", "astoria", "harlem", "yonkers",
    ],
  },
  {
    region: "nyc",
    state: "NJ",
    cities: ["jersey city", "hoboken", "newark", "weehawken", "fort lee"],
  },
  {
    region: "chicago",
    state: "IL",
    cities: [
      "chicago", "evanston", "oak park", "naperville", "schaumburg",
      "skokie", "wilmette", "river forest",
    ],
  },
  {
    region: "los_angeles",
    state: "CA",
    cities: [
      "los angeles", "santa monica", "long beach", "pasadena", "beverly hills",
      "culver city", "venice", "burbank", "glendale", "west hollywood",
      "marina del rey", "hermosa beach", "manhattan beach", "redondo beach",
      "torrance", "el segundo", "hollywood",
    ],
  },
  {
    region: "seattle",
    state: "WA",
    cities: [
      "seattle", "bellevue", "redmond", "kirkland", "renton", "tacoma",
      "bothell", "issaquah", "sammamish",
    ],
  },
  {
    region: "boston",
    state: "MA",
    cities: [
      "boston", "cambridge", "brookline", "somerville", "newton",
      "watertown", "arlington", "medford", "quincy",
    ],
  },
];

export function marketRegionFor(city, state) {
  const cityLower = (city || "").toLowerCase().trim();
  const stateUpper = (state || "").toUpperCase().trim();
  for (const rule of REGION_RULES) {
    if (rule.state !== stateUpper) continue;
    if (rule.cities.some((c) => cityLower.includes(c))) return rule.region;
  }
  // State-level fallbacks for households we have rules for but in
  // smaller cities not on the keyword list.
  if (stateUpper === "FL") return "south_florida";
  if (stateUpper === "NY") return "nyc";
  return "generic";
}

export async function loadHouseholdLocation(householdId) {
  try {
    const raw = await redis.get(`household:${householdId}:location`);
    if (!raw) return null;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

// IP-based geolocation fallback. ipapi.co's free tier is no-key,
// rate-limited at ~1000/day — well past our scale. 3s timeout same
// budget as the brief's weather fetch. Returns null on any failure
// so the caller can fall through to LOCATION_FALLBACK.
async function geolocateFromIp(ip) {
  if (!ip) return null;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`https://ipapi.co/${ip}/json/`, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.city || !data?.region_code) return null;
    return {
      city: data.city,
      state: data.region_code,
      lat: data.latitude,
      lon: data.longitude,
      timezone: data.timezone || "America/New_York",
      source: "ip",
    };
  } catch {
    return null;
  }
}

// Extract the client IP from a Vercel serverless request. x-forwarded-for
// can be a comma-separated list (proxies prepend); first entry is the
// original client.
function clientIp(req) {
  const xff = req?.headers?.["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  const realIp = req?.headers?.["x-real-ip"];
  if (typeof realIp === "string" && realIp.length > 0) return realIp;
  return null;
}

// Detect location for a household. Returns the stored value when
// present (no detection cost). Otherwise tries IP geolocation against
// the caller's IP and stamps + stores the result. Falls through to
// LOCATION_FALLBACK only when both detection paths fail.
export async function detectOrLoadLocation(householdId, req) {
  const existing = await loadHouseholdLocation(householdId);
  if (existing) return existing;

  const ip = clientIp(req);
  const geo = await geolocateFromIp(ip);
  if (geo && geo.city && geo.state) {
    const tzFromCoords =
      geo.lat != null && geo.lon != null
        ? getTimezoneFromCoords(geo.lat, geo.lon)
        : null;
    const located = {
      ...geo,
      timezone: geo.timezone || tzFromCoords || "America/New_York",
      timezoneDefaulted: !geo.timezone && !tzFromCoords,
      marketRegion: marketRegionFor(geo.city, geo.state),
      detectedAt: Date.now(),
    };
    try {
      await redis.set(`household:${householdId}:location`, JSON.stringify(located));
      console.log(
        `[location] auto-detected for ${householdId}: ${located.city}, ${located.state} → ${located.marketRegion}`
      );
    } catch (err) {
      console.warn("[location] store failed:", err?.message || err);
    }
    return located;
  }

  return LOCATION_FALLBACK;
}

// Manual set — used by the Settings UI's location editor. Always
// recomputes marketRegion from the supplied city/state so the bucket
// is consistent with the user's input.
export async function saveHouseholdLocation(householdId, { city, state, lat, lon, timezone }) {
  if (!city || !state) throw new Error("city and state required");
  const latNum = typeof lat === "number" ? lat : (lat ? parseFloat(lat) : null);
  const lonNum = typeof lon === "number" ? lon : (lon ? parseFloat(lon) : null);
  const tzFromCoords =
    latNum != null && lonNum != null
      ? getTimezoneFromCoords(latNum, lonNum)
      : null;
  const resolvedTz = timezone || tzFromCoords || "America/New_York";
  const located = {
    city: String(city).trim(),
    state: String(state).trim().toUpperCase(),
    lat: latNum,
    lon: lonNum,
    timezone: resolvedTz,
    timezoneDefaulted: !timezone && !tzFromCoords,
    marketRegion: marketRegionFor(city, state),
    source: "manual",
    detectedAt: Date.now(),
  };
  await redis.set(`household:${householdId}:location`, JSON.stringify(located));
  console.log(
    `[location] manual set for ${householdId}: ${located.city}, ${located.state} → ${located.marketRegion}`
  );
  return located;
}

// Non-public endpoint — any direct HTTP hit returns 404.
export default function handler(req, res) {
  return res.status(404).json({ error: "Not a public endpoint" });
}
