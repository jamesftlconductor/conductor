import { Redis } from "@upstash/redis";
import { loadHouseholdCalendar } from "./calendar-loader.js";
import { loadCamouflageRules, applyCamouflage } from "./signals.js";
import { loadHouseholdLocation, LOCATION_FALLBACK } from "./location.js";
import { loadNetworkContext } from "./network.js";
import { isMaintenanceOfferReady } from "./maintenance.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Default coords used only when location detection genuinely failed —
// per-household coords come from household:{id}:location now.
const WEATHER_TIMEOUT_MS = 3000;

// ---------- Annual / seasonal local-event calendar ----------
//
// Hardcoded, region-keyed list of recurring annual events with traffic
// or safety impact. Surfaces alongside the live Eventbrite feed (when
// that lands) via getAnnualEvents below. Each event carries:
//   - tier:                 1 = safety, 2 = major (mention on quiet
//                           days or signal conflicts), 3 = awareness
//                           (mention only on quiet days)
//   - surfaceWeeksBefore:   how far ahead to start mentioning (default 1)
//   - durationDays:         how many days the event spans (default 1)
//
// Region keys correspond to household:{id}:location.marketRegion values
// set by location.js. Households outside these markets fall back to
// the empty list (no annual events surfaced) — a 'generic' bucket is
// not maintained because nothing here is universally relevant.
const ANNUAL_EVENTS = {
  south_florida: [
    { name: "Hurricane Season Opens", month: 6, day: 1, tier: 1, surfaceWeeksBefore: 2, note: "Check supplies and emergency kit" },
    { name: "Tortuga Music Festival", month: 5, day: 15, tier: 2, durationDays: 3, note: "Beach corridor packed, A1A gridlock" },
    { name: "Fort Lauderdale Boat Show", month: 10, day: 25, tier: 2, durationDays: 5, note: "Downtown gridlock, plan around it" },
    { name: "Air and Sea Show", month: 5, day: 4, tier: 2, durationDays: 2, note: "Beach closed, A1A shut down" },
    { name: "Spring Break Peak", month: 3, day: 10, tier: 3, durationDays: 14, note: "Beach traffic heavy" },
    { name: "Snowbird Season", month: 11, day: 1, tier: 3, durationDays: 150, note: "Traffic 40% heavier through April" },
    { name: "Hurricane Season Ends", month: 11, day: 30, tier: 3, surfaceWeeksBefore: 0, note: "Six months clear" },
  ],
  nyc: [
    { name: "NYC Marathon", month: 11, day: 3, tier: 2, note: "Major street closures across boroughs" },
    { name: "Thanksgiving Parade", month: 11, day: 27, tier: 2, note: "Upper West Side closed" },
    { name: "July 4 Fireworks", month: 7, day: 4, tier: 2, note: "East River closures, FDR shut" },
    { name: "US Open Tennis", month: 8, day: 25, tier: 3, durationDays: 14, note: "Flushing Meadows traffic" },
    { name: "Pride Weekend", month: 6, day: 28, tier: 3, durationDays: 2, note: "Midtown closures" },
  ],
  chicago: [
    { name: "Chicago Marathon", month: 10, day: 13, tier: 2, note: "Major street closures" },
    { name: "Lollapalooza", month: 8, day: 1, tier: 2, durationDays: 4, note: "Grant Park, downtown packed" },
    { name: "Air and Water Show", month: 8, day: 16, tier: 2, durationDays: 2, note: "Lakefront crowds" },
    { name: "St. Patrick's Day", month: 3, day: 17, tier: 3, note: "River dyed green, downtown busy" },
  ],
  los_angeles: [
    { name: "LA Marathon", month: 3, day: 16, tier: 2, note: "Major street closures across city" },
    { name: "Coachella", month: 4, day: 11, tier: 3, durationDays: 14, note: "I-10 East heavy both weekends" },
    { name: "Thanksgiving", month: 11, day: 27, tier: 3, note: "LAX and freeways brutal" },
    { name: "Wildfire Season", month: 9, day: 1, tier: 1, durationDays: 90, note: "Watch air quality and evacuation notices" },
  ],
  seattle: [
    { name: "Seafair", month: 8, day: 1, tier: 2, durationDays: 30, note: "Blue Angels weekend, Lake Washington packed" },
    { name: "Bumbershoot", month: 9, day: 1, tier: 3, durationDays: 3, note: "Seattle Center area busy" },
  ],
  boston: [
    { name: "Boston Marathon", month: 4, day: 21, tier: 2, note: "Major street closures across city" },
    { name: "Fourth of July", month: 7, day: 4, tier: 2, note: "Esplanade, closures across Back Bay" },
    { name: "Head of the Charles", month: 10, day: 18, tier: 3, durationDays: 2, note: "Cambridge River traffic" },
  ],
};

// Returns the annual events that are either upcoming (within their
// surfaceWeeksBefore window) or actively underway. daysUntil is
// negative for events that started in the past but haven't ended yet
// (e.g. Snowbird Season starting Nov 1, accessed in February).
function getAnnualEvents(marketRegion, today) {
  const events = ANNUAL_EVENTS[marketRegion] || [];
  const todayDate = new Date(today);
  return events
    .map((event) => {
      const eventDate = new Date(todayDate.getFullYear(), event.month - 1, event.day);
      const daysUntil = Math.floor((eventDate - todayDate) / 86400000);
      const surfaceDays = (event.surfaceWeeksBefore !== undefined ? event.surfaceWeeksBefore : 1) * 7;
      const duration = event.durationDays || 1;
      return { event, daysUntil, surfaceDays, duration };
    })
    .filter(({ daysUntil, surfaceDays, duration }) =>
      daysUntil >= -duration && daysUntil <= surfaceDays
    )
    .map(({ event, daysUntil }) => ({ ...event, daysUntil }));
}

// ---------- helpers ----------

// Open-Meteo's WMO weather codes mapped to the small vocabulary that
// drives the conditional usage rules in baseRules. We deliberately
// don't surface every WMO subdivision — Claude only needs to know
// "is this rain, snow, storm, or normal" to decide whether weather is
// load-bearing for any signal.
function classifyWeather(code, tempF) {
  let condition;
  if (code <= 1) condition = "Clear";
  else if (code <= 3) condition = "Partly cloudy";
  else if (code >= 45 && code <= 48) condition = "Foggy";
  else if (code >= 51 && code <= 67) condition = "Rain";
  else if (code >= 71 && code <= 77) condition = "Snow";
  else if (code >= 80 && code <= 82) condition = "Showers";
  else if (code >= 95 && code <= 99) condition = "Thunderstorm";
  else condition = "Mixed";
  return `${tempF}°F, ${condition}`;
}

// Best-effort fetch of current weather. Returns null on any failure
// (network, timeout, malformed payload) so the brief still ships
// without weather context. 3s timeout keeps the overall brief
// latency bounded even when Open-Meteo is slow.
async function fetchWeather(location) {
  // Use the household's stored coordinates when available; fall back to
  // the LOCATION_FALLBACK (Fort Lauderdale) so a household with no
  // location set still gets weather context.
  const lat = location?.lat ?? LOCATION_FALLBACK.lat;
  const lon = location?.lon ?? LOCATION_FALLBACK.lon;
  const timezone = location?.timezone ?? LOCATION_FALLBACK.timezone;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,precipitation,weathercode` +
      `&hourly=temperature_2m,precipitation_probability,uv_index,weathercode` +
      `&daily=sunrise,sunset,uv_index_max` +
      `&forecast_days=1` +
      `&temperature_unit=fahrenheit` +
      `&timezone=${encodeURIComponent(timezone)}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    const current = data?.current;
    if (!current || typeof current.temperature_2m !== "number") return null;
    const tempF = Math.round(current.temperature_2m);
    const humidity = typeof current.relative_humidity_2m === "number"
      ? Math.round(current.relative_humidity_2m)
      : null;
    const isRaining = (current.precipitation ?? 0) > 0;
    const weatherCode = current.weathercode ?? 0;

    // Derive today's timeline from the hourly + daily arrays. All
    // entries are timezone-correct for the household's location.
    const hourly = data?.hourly || {};
    const daily = data?.daily || {};
    const times = Array.isArray(hourly.time) ? hourly.time : [];
    const temps = Array.isArray(hourly.temperature_2m) ? hourly.temperature_2m : [];
    const rainProbs = Array.isArray(hourly.precipitation_probability) ? hourly.precipitation_probability : [];
    const uvHourly = Array.isArray(hourly.uv_index) ? hourly.uv_index : [];

    function fmtHourFromIso(iso) {
      if (!iso) return null;
      // hourly.time entries are "YYYY-MM-DDTHH:00" in local zone.
      const m = String(iso).match(/T(\d{2}):/);
      if (!m) return null;
      const h = parseInt(m[1], 10);
      const ampm = h >= 12 ? "pm" : "am";
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      return `${h12}${ampm}`;
    }
    function fmtTimeFromIso(iso) {
      // Daily sunrise/sunset arrive as "YYYY-MM-DDTHH:MM" local.
      if (!iso) return null;
      const m = String(iso).match(/T(\d{2}):(\d{2})/);
      if (!m) return null;
      const h = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      const ampm = h >= 12 ? "pm" : "am";
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      return `${h12}:${String(min).padStart(2, "0")}${ampm}`;
    }

    // Rain window — contiguous hours with > 60% probability, capped
    // at the first window found.
    let rainWindow = null;
    if (rainProbs.length > 0) {
      let start = -1;
      let end = -1;
      for (let i = 0; i < rainProbs.length; i++) {
        if ((rainProbs[i] || 0) > 60) {
          if (start === -1) start = i;
          end = i;
        } else if (start !== -1) {
          break;
        }
      }
      if (start !== -1 && end !== -1) {
        const startLabel = fmtHourFromIso(times[start]);
        const endLabel = fmtHourFromIso(times[end + 1] || times[end]);
        if (startLabel && endLabel) rainWindow = `${startLabel}–${endLabel}`;
      }
    }

    // Temperature peak — max of hourly.temperature_2m.
    let temperaturePeak = null;
    if (temps.length > 0) {
      let maxI = 0;
      for (let i = 1; i < temps.length; i++) if (temps[i] > temps[maxI]) maxI = i;
      const t2 = Math.round(temps[maxI]);
      const at = fmtHourFromIso(times[maxI]);
      if (at) temperaturePeak = { tempF: t2, time: at };
    }

    // UV peak — max of hourly.uv_index. uv_index_max in daily is a
    // single number; we prefer the hourly index so the time is known.
    let uvPeak = null;
    if (uvHourly.length > 0) {
      let maxI = 0;
      for (let i = 1; i < uvHourly.length; i++) if (uvHourly[i] > uvHourly[maxI]) maxI = i;
      const v = Math.round(uvHourly[maxI]);
      const at = fmtHourFromIso(times[maxI]);
      if (at) uvPeak = { value: v, time: at };
    }

    const sunrise = Array.isArray(daily.sunrise) && daily.sunrise[0] ? fmtTimeFromIso(daily.sunrise[0]) : null;
    const sunset = Array.isArray(daily.sunset) && daily.sunset[0] ? fmtTimeFromIso(daily.sunset[0]) : null;

    return {
      tempF,
      humidity,
      isRaining,
      weatherCode,
      summary: classifyWeather(weatherCode, tempF),
      rainWindow,
      temperaturePeak,
      uvPeak,
      sunrise,
      sunset,
      // Raw hourly arrays exposed so downstream code (conflict
      // detection at signal-time) can probe a specific hour's
      // precipitation probability. Same length, parallel indices.
      hourlyTime: times,
      hourlyPrecipProb: rainProbs,
    };
  } catch (err) {
    console.error("Weather fetch failed:", err?.message || err);
    return null;
  }
}

function parseDateLoose(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return isNaN(ms) ? null : new Date(ms);
}

// Custody-aware filter for child crew members. Returns true unless a
// schedule says today is an away day. Used by the brief to suppress
// signals + events belonging to a child who isn't with this household.
function isChildHomeToday(member) {
  const schedule = member?.custodySchedule;
  if (!schedule || !schedule.type || schedule.type === "full_time") return true;
  const now = new Date();
  if (schedule.type === "alternating_weeks") {
    // ISO week parity check. withUsWeeks: 'even' | 'odd' against the
    // current ISO week number.
    const target = String(schedule.withUsWeeks || "").toLowerCase();
    if (target !== "even" && target !== "odd") return true;
    const yearStart = new Date(now.getFullYear(), 0, 1);
    const dayOfYear = Math.floor((now - yearStart) / (24 * 60 * 60 * 1000));
    const isoWeek = Math.ceil((dayOfYear + yearStart.getDay() + 1) / 7);
    const isEven = isoWeek % 2 === 0;
    return target === "even" ? isEven : !isEven;
  }
  if (schedule.type === "alternating_days" || schedule.type === "custom") {
    const days = Array.isArray(schedule.withUsDays)
      ? schedule.withUsDays.map((d) => String(d).toLowerCase())
      : [];
    if (days.length === 0) return true;
    const todayName = now.toLocaleString("en-US", { weekday: "long" }).toLowerCase();
    return days.includes(todayName);
  }
  return true;
}

// Household profile → single combined HOUSEHOLD block in the prompt.
// Reads new-schema fields (who/housing/modifiers) with legacy
// fallback so we don't break briefs for households that completed
// onboarding before the schema change.
function buildHouseholdProfileRule(profile) {
  if (!profile || typeof profile !== "object") return null;

  // Resolve "who" — prefer new, derive from legacy type when missing.
  let who = profile.who;
  if (!who && profile.type) {
    const TYPE_TO_WHO = {
      single: "solo",
      couple: "couple",
      family: "family",
      multigenerational: "multigenerational",
      roommates: null,
      other: null,
    };
    who = TYPE_TO_WHO[profile.type] || null;
  }

  // Resolve "housing" — prefer new, derive from legacy ownOrRent.
  let housing = profile.housing;
  if (!housing && profile.ownOrRent) {
    if (profile.ownOrRent === "rent") housing = "rent";
    else if (profile.ownOrRent === "own") housing = "own";
  }

  const modifiers = Array.isArray(profile.modifiers) ? profile.modifiers : [];
  if (!who && !housing && modifiers.length === 0) return null;

  const WHO_VOICE = {
    solo: "Personal voice — address the reader as 'you', never 'the household'. Lead with personal health and financial signals when relevant.",
    couple: "Collaborative voice — coordination across two adults matters. Handoff detection is active. Occasional 'you two' is fine, don't lean on it.",
    family: "Crew-forward voice — children's schedules matter. Junior-added signals (source: 'junior') get elevated priority and warm framing.",
    multigenerational: "Gentle tone throughout. Health awareness across multiple generations is more prominent. Medication tracking and appointment signals get elevated priority.",
    investment_property: "INVESTMENT PROPERTY voice — use 'the property' not 'your home'. Lead with tenant and lease signals. Financial signals (rental income, expenses, property tax) are elevated. Maintenance is critical because tenant experience matters. Tone is professional and practical — never personal household language. Signals attributed to crew member type 'tenant' carry a [TENANT] prefix; honor that framing.",
  };

  const HOUSING_RULE = {
    own: "Full home-maintenance phrasing in play. Maintenance plan + complete inventory. Exterior items (roof, lawn, etc.) are fair game.",
    rent: "Skip home-maintenance offers and exterior items. Lease tracking is prominent — surface lease notice deadlines aggressively. Apartment-scale inventory only.",
    living_with_family: "Simplified framing. No home maintenance plan, no lease tracking. Focus on personal-scope signals only — schedules, deadlines, health, finance.",
  };

  const MODIFIER_RULES = {
    has_pets: "Pet-care signals (vet appointments, prescriptions, food refills) are elevated.",
    co_parent: "Co-parenting context — never assume both parents are present. Children's schedule is the primary signal type regardless of other signal volume. Keep language neutral about the other parent — never 'your partner' or 'your spouse'. When the brief references a child's away time use 'is with their other parent this week' framing, never 'is away'. Never reference the co-parent by name unless explicitly stored in crew. Financial signals related to co-parenting (child support, shared expenses) get elevated priority.",
    health_needs: "Ongoing health needs in the household. Medication tracking and care appointments are elevated. The Pulse can lean into body-state observations when relevant.",
    major_change: "Major life change in progress. Tone is supportive throughout. Surface life-transition vault items ahead of older signals when timing demands.",
    students: "Students in the household. Academic-calendar awareness — semesters, finals, financial-aid deadlines get elevated priority.",
    work_from_home: "Work-from-home context. Calendar blocking is more important. Midday-window framings are more relevant; commute and time-of-day cues are less so.",
  };

  const parts = [];
  const headerBits = [];
  if (who) headerBits.push(who);
  if (housing) headerBits.push(housing);
  if (modifiers.length > 0) headerBits.push(`+ ${modifiers.join(", ")}`);
  parts.push(`HOUSEHOLD: ${headerBits.join(" / ")}`);

  if (who && WHO_VOICE[who]) parts.push(WHO_VOICE[who]);
  if (housing && HOUSING_RULE[housing]) parts.push(HOUSING_RULE[housing]);
  for (const m of modifiers) {
    if (MODIFIER_RULES[m]) parts.push(MODIFIER_RULES[m]);
  }

  return `- ${parts.join(" ")}`;
}

// User-tunable voice preferences → prompt rule fragment. Returns null
// when no preference is set, so the brief preserves its default voice
// for households that haven't touched the settings.
function buildStyleRule(tone, humor, detail) {
  if (!tone && !humor && !detail) return null;
  const t = tone || "balanced";
  const h = humor || "occasionally";
  const d = detail || "standard";
  const toneDetail = `${t}+${d}`;
  const toneRules = {
    "direct+brief": "VOICE: Maximum efficiency. No softening. No filler. Facts only. Every word earns its place.",
    "direct+standard": "VOICE: Direct and clear. Minimal softening. Context only when essential.",
    "direct+thorough": "VOICE: Direct but with full context. Explain implications without softening the language.",
    "warm+brief": "VOICE: Warm but concise. One human touch per brief, then move on.",
    "warm+standard": "VOICE: Conversational and caring. Human without being excessive.",
    "warm+thorough": "VOICE: Warm and contextual. Take the extra sentence. The relationship matters as much as the information.",
    "balanced+brief": "VOICE: Calibrated and lean. Soft where it helps, terse where it doesn't.",
    "balanced+standard": "VOICE: Read the room. Warm when the day is good, direct when it's heavy, light when earned.",
    "balanced+thorough": "VOICE: Calibrated with context. Explain why things matter when it serves the reader.",
  };
  const humorRules = {
    yes: "Humor is welcome when genuinely earned — dry observation, true irony, local awareness.",
    occasionally: "Light humor occasionally when it fits naturally. Never forced.",
    no: "No humor. Professional tone throughout.",
  };
  const detailRules = {
    brief: "Never explain why unless the user would otherwise miss the significance. Trust them.",
    standard: "",
    thorough: "Context is valuable. Explain why things matter when it adds clarity.",
  };
  const lines = [
    toneRules[toneDetail] || toneRules["balanced+standard"],
    humorRules[h],
    detailRules[d],
  ].filter(Boolean);
  return `- ${lines.join(" ")}`;
}

// Common-airport-to-city map for destination extraction. Not exhaustive
// — covers the heavy-traffic routes a household traveler is likeliest to
// see in flight confirmation subjects/descriptions. Falls back to text
// pattern matching for anything outside this list.
const AIRPORT_TO_CITY = {
  ATL: "Atlanta", AUS: "Austin", BOS: "Boston", BWI: "Baltimore",
  CLT: "Charlotte", DCA: "Washington DC", DEN: "Denver", DFW: "Dallas",
  DTW: "Detroit", EWR: "Newark", FLL: "Fort Lauderdale", IAD: "Washington DC",
  IAH: "Houston", JFK: "New York", LAS: "Las Vegas", LAX: "Los Angeles",
  LGA: "New York", MCO: "Orlando", MIA: "Miami", MSP: "Minneapolis",
  ORD: "Chicago", PDX: "Portland", PHL: "Philadelphia", PHX: "Phoenix",
  RDU: "Raleigh", SAN: "San Diego", SEA: "Seattle", SFO: "San Francisco",
  SLC: "Salt Lake City", STL: "St. Louis", TPA: "Tampa",
  YYZ: "Toronto", YVR: "Vancouver", YUL: "Montreal",
  LHR: "London", LGW: "London", CDG: "Paris", ORY: "Paris",
  AMS: "Amsterdam", FRA: "Frankfurt", MUC: "Munich", ZRH: "Zurich",
  MAD: "Madrid", BCN: "Barcelona", FCO: "Rome", VCE: "Venice",
  ATH: "Athens", IST: "Istanbul", DUB: "Dublin", CPH: "Copenhagen",
  ARN: "Stockholm", HEL: "Helsinki", OSL: "Oslo",
  NRT: "Tokyo", HND: "Tokyo", ICN: "Seoul", PEK: "Beijing",
  PVG: "Shanghai", HKG: "Hong Kong", SIN: "Singapore", BKK: "Bangkok",
  DXB: "Dubai", DOH: "Doha", BOM: "Mumbai", DEL: "Delhi",
  SYD: "Sydney", MEL: "Melbourne", AKL: "Auckland",
  GRU: "São Paulo", GIG: "Rio de Janeiro", EZE: "Buenos Aires",
  MEX: "Mexico City", CUN: "Cancun", CDMX: "Mexico City",
};

const CITY_STOPWORDS = new Set([
  "The", "A", "An", "January", "February", "March", "April", "May",
  "June", "July", "August", "September", "October", "November", "December",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
  "Hotel", "Flight", "Trip", "Reservation", "Confirmation", "Departure",
]);

// Pulls a destination from a travel-signal description or title.
// Strategy: 3-letter airport code first (most reliable), then "to <City>"
// or "in <City>" patterns. Returns null when nothing confident enough.
function extractDestination(text) {
  if (typeof text !== "string" || !text) return null;
  // Strip very common patterns that confuse pattern matching.
  const normalized = text.replace(/[(),]/g, " ").replace(/\s+/g, " ");
  // Airport code: 3 capitalized letters, word-boundary. Map back to city.
  const airportMatches = [...normalized.matchAll(/\b([A-Z]{3})\b/g)];
  for (const m of airportMatches) {
    const city = AIRPORT_TO_CITY[m[1]];
    if (city) return city;
  }
  // "to <Capitalized words>" — captures up to 3-word place names like "New York" or "São Paulo".
  const toMatch = normalized.match(/\bto\s+([A-Z][a-zà-ÿ]+(?:\s+[A-Z][a-zà-ÿ]+){0,2})/);
  if (toMatch && !CITY_STOPWORDS.has(toMatch[1].split(/\s+/)[0])) {
    return toMatch[1];
  }
  // "in <Capitalized words>" — covers hotel reservation descriptions like
  // "Hotel Lumen Paris Louvre reservation" where the city follows "in"
  // less often, but also matches direct names. We require the word right
  // after "in" not to be a stopword (month/weekday/etc.) before returning.
  const inMatch = normalized.match(/\bin\s+([A-Z][a-zà-ÿ]+(?:\s+[A-Z][a-zà-ÿ]+){0,2})/);
  if (inMatch && !CITY_STOPWORDS.has(inMatch[1].split(/\s+/)[0])) {
    return inMatch[1];
  }
  return null;
}

// Geocode + weather lookup for a destination city. Best-effort with a
// 3s timeout (same budget as the local fetchWeather). Returns null on
// any failure so the brief still ships without destination weather.
async function fetchDestinationWeather(destination) {
  if (!destination) return null;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const geoUrl =
      `https://geocoding-api.open-meteo.com/v1/search` +
      `?name=${encodeURIComponent(destination)}&count=1&language=en&format=json`;
    const geoRes = await fetch(geoUrl, { signal: controller.signal });
    if (!geoRes.ok) { clearTimeout(t); return null; }
    const geoData = await geoRes.json();
    const place = geoData?.results?.[0];
    if (!place) { clearTimeout(t); return null; }
    const weatherUrl =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${place.latitude}&longitude=${place.longitude}` +
      `&current=temperature_2m,weathercode&temperature_unit=fahrenheit`;
    const weatherRes = await fetch(weatherUrl, { signal: controller.signal });
    clearTimeout(t);
    if (!weatherRes.ok) return null;
    const weatherData = await weatherRes.json();
    const cur = weatherData?.current;
    if (!cur || typeof cur.temperature_2m !== "number") return null;
    const tempF = Math.round(cur.temperature_2m);
    return {
      destination,
      tempF,
      weatherCode: cur.weathercode ?? 0,
      summary: classifyWeather(cur.weathercode ?? 0, tempF),
    };
  } catch (err) {
    console.warn(`[travel-prep] destination weather fetch failed for ${destination}:`, err?.message || err);
    return null;
  }
}

// Normalize whatever the user typed into a strict MM-DD. Accepts:
//   "05-22"            → "05-22"
//   "5-22"             → "05-22"
//   "05-22-1990"       → "05-22"
//   "1990-05-22"       → "05-22"
//   "2026-05-22"       → "05-22"
//   "May 22"           → "05-22"
// Returns null when the input doesn't carry an unambiguous month + day.
function normalizeMMDD(input) {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!s) return null;
  // MM-DD or M-D
  let m = s.match(/^(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const mm = String(m[1]).padStart(2, "0");
    const dd = String(m[2]).padStart(2, "0");
    return `${mm}-${dd}`;
  }
  // MM-DD-YYYY (US legacy)
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) {
    return `${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
  }
  // YYYY-MM-DD
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    return `${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
  }
  // "May 22" / "May 22, 1990" — month name + day
  const parsed = new Date(`${s} 2000`);
  if (!isNaN(parsed.getTime()) && /[a-z]/i.test(s)) {
    return `${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
  }
  return null;
}

// Days until the next occurrence of an MM-DD anchor (birthday or
// anniversary). Tolerant of MM-DD, MM-DD-YYYY, YYYY-MM-DD, and
// month-name forms via normalizeMMDD. Returns 0 for today, 1 for
// tomorrow, wraps to next year if past. Returns null for malformed
// input.
function daysUntilMMDD(mmDd) {
  const normalized = normalizeMMDD(mmDd);
  if (!normalized) return null;
  const [mm, dd] = normalized.split("-").map(Number);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let candidate = new Date(now.getFullYear(), mm - 1, dd);
  if (candidate.getTime() < today.getTime()) {
    candidate = new Date(now.getFullYear() + 1, mm - 1, dd);
  }
  return Math.round((candidate.getTime() - today.getTime()) / DAY_MS);
}

// Renders an MM-DD date as e.g. "June 3" — month name + day, no year.
function formatMMDD(mmDd) {
  const normalized = normalizeMMDD(mmDd);
  if (!normalized) return mmDd;
  const [mm, dd] = normalized.split("-").map(Number);
  return new Date(2000, mm - 1, dd).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
  });
}

// Extract the deadline anchor from a possibly-windowed ETA string
// like "2025-12-10 to 2025-12-20" or "Dec 10 – Dec 20". Returns the
// later side (the window's close) since that's the authoritative
// "still open" boundary. Falls back to whichever side parses if only
// one is valid. Plain single-date strings pass through unchanged.
function parseEtaDeadline(value) {
  if (!value || typeof value !== "string") return parseDateLoose(value);
  const direct = parseDateLoose(value);
  if (direct) return direct;
  const parts = value.split(/\s+(?:to|through|thru|–|—|-)\s+/i);
  if (parts.length >= 2) {
    const a = parseDateLoose(parts[0]);
    const b = parseDateLoose(parts[parts.length - 1]);
    if (a && b) return a.getTime() > b.getTime() ? a : b;
    if (b) return b;
    if (a) return a;
  }
  return null;
}

// Module-level day-count phrase: emits authoritative "(in N days)" /
// "(today)" / "(tomorrow)" / "(in N weeks)" for clean multiples of 7,
// or "(yesterday)" / "(already passed N days ago)" for past dates.
// Shared by the steady-state handler's etaWithFriendly AND by
// generateTransparency's pre-formatting so the transparency Claude
// call can lift counts instead of computing them.
function daysFromTodayPhrase(value) {
  const d = parseEtaDeadline(value);
  if (!d) return null;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const n = Math.round((target.getTime() - startOfToday.getTime()) / DAY_MS);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n > 0) {
    if (n >= 7 && n % 7 === 0) {
      const weeks = n / 7;
      return weeks === 1 ? "in 1 week" : `in ${weeks} weeks`;
    }
    return `in ${n} days`;
  }
  if (n === -1) return "yesterday";
  return `already passed ${-n} days ago`;
}

function dayOffsetFromToday(date) {
  const a = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const now = new Date();
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a.getTime() - t.getTime()) / DAY_MS);
}

function withinNextDays(date, days) {
  const ms = date.getTime() - Date.now();
  return ms <= days * DAY_MS && ms > -DAY_MS; // allow ~1 day overdue tolerance
}

function safeJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function classifyUrgent(s) {
  if (s.priority === "urgent") return true;
  const eta = parseDateLoose(s.eta);
  if (!eta) return false;
  const offset = dayOffsetFromToday(eta);
  if (offset === 0) {
    if (s.type === "service" || s.type === "reservation") return true;
    if (s.status === "Out for Delivery") return true;
  }
  if (s.type === "deadline" && withinNextDays(eta, 3)) return true;
  return false;
}

function isInNearWindow(s) {
  if (s.status === "Delivered") return false;
  const eta = parseDateLoose(s.eta);
  if (!eta) return true; // no ETA + not delivered → near window
  return withinNextDays(eta, 14);
}

function isHomeRequirement(s) {
  if (s.type !== "service") return false;
  const eta = parseDateLoose(s.eta);
  if (!eta) return false;
  const offset = dayOffsetFromToday(eta);
  return offset === 0 || offset === 1;
}

// Coarse ring classification used by the briefedToday mute logic. Inner =
// urgent right now, middle = within next 14 days, outer = everything else
// (including signals with no ETA — they live on the outer ring conceptually
// because we have no signal that they're imminent).
function computeRing(s) {
  if (classifyUrgent(s)) return "inner";
  if (isInNearWindow(s)) return "middle";
  return "outer";
}

// Cross-signal conflict detection — runs after pool computation, before
// the steady-state Claude call. Surfaces situations where two signals
// can't both be honored without intervention. Output drives a dedicated
// CONFLICTS section in the prompt + special-cased rules in baseRules.
//
// We treat a calendar event as "work-blocked" when its classification
// includes any of the work-context keywords. The spec calls this the
// "workSummary pool", but no such Redis key exists — we derive it from
// the household calendar at detection time.
function detectConflicts({
  activeSignals,
  allDeadlines,
  calendarEvents,
  householdNameMap,
  requestingUserId,
  weather,
}) {
  const conflicts = [];

  // Weather-at-signal-time check — outdoor service signal whose ETA
  // falls in an hour with > 60% precipitation probability is a real
  // conflict (the technician likely cancels, OR the work needs
  // rescheduling). We probe the hourly forecast directly rather than
  // relying on the contiguous rainWindow string which collapses
  // distinct rain periods.
  if (weather?.hourlyTime?.length && weather?.hourlyPrecipProb?.length) {
    const hourlyTime = weather.hourlyTime;
    const hourlyPrecip = weather.hourlyPrecipProb;
    for (const s of activeSignals) {
      if (!isOutdoorService(s)) continue;
      const eta = parseDateLoose(s.eta);
      if (!eta) continue;
      const offset = dayOffsetFromToday(eta);
      // Only flag for today + tomorrow — beyond that the forecast
      // accuracy isn't worth surfacing.
      if (offset !== 0 && offset !== 1) continue;
      // Find the hourly index closest to the ETA. hourly.time entries
      // are "YYYY-MM-DDTHH:00" in local zone — we exact-match the
      // YYYY-MM-DDTHH prefix for the appointment.
      const pad = (n) => String(n).padStart(2, "0");
      const target =
        `${eta.getFullYear()}-${pad(eta.getMonth() + 1)}-${pad(eta.getDate())}` +
        `T${pad(eta.getHours())}`;
      const idx = hourlyTime.findIndex(
        (t) => typeof t === "string" && t.startsWith(target)
      );
      if (idx < 0) continue;
      const precip = Number(hourlyPrecip[idx]) || 0;
      if (precip > 60) {
        conflicts.push({
          type: "weather_outdoor_conflict",
          signal: s,
          weatherNote: "Rain expected at appointment time",
          precipProbability: Math.round(precip),
          appointmentHour: eta.getHours(),
          severity: "moderate",
        });
      }
    }
  }

  const memberIds = [
    requestingUserId,
    ...Array.from(householdNameMap?.keys() || []),
  ].filter(Boolean);
  // Without member ids we can't reason about who's blocked — skip the
  // member-availability checks entirely. Deadline urgency still runs.
  const events = Array.isArray(calendarEvents) ? calendarEvents : [];
  // The calendar classifier (in onboard-worker.js Job 2 and calendar.js
  // runCalendarSync) emits a structured `type` enum ("work"/"household"/
  // "personal"/"travel"/"childcare") and a `workConflictCheck` boolean
  // explicitly meaning "this blocks the person and could conflict with
  // household events". Prefer those structured fields over substring
  // search — they're authoritative. eventClassifiedAs is kept as a
  // fallback for events that slipped through the classifier as
  // type:"unknown" but still have a tell-tale title ("Team meeting").
  const blockingEvents = events.filter((e) =>
    e.workConflictCheck === true ||
    e.type === "work" ||
    eventClassifiedAs(e, ["work", "meeting", "call", "office"])
  );

  const memberWork = new Map(memberIds.map((id) => [id, []]));
  for (const e of blockingEvents) {
    const uid = e.userId;
    if (!uid || !memberWork.has(uid)) continue;
    memberWork.get(uid).push(e);
  }

  function memberBlockedInWindow(uid, startMs, endMs) {
    const list = memberWork.get(uid) || [];
    return list.some((e) => {
      const s = parseDateLoose(e.start)?.getTime();
      const eMs =
        parseDateLoose(e.end)?.getTime() || (s ? s + HOUR_MS : null);
      if (!s || !eMs) return false;
      return s <= endMs && eMs >= startMs;
    });
  }

  function startOfDayMs(date) {
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate()
    ).getTime();
  }

  // 1. SERVICE — service signal today/tomorrow, every household member
  //    blocked by a work event in a ±2h window around the ETA. Coarse
  //    by design: most service appointments don't expose a duration
  //    field, so we use a fixed window rather than try to infer one.
  if (memberIds.length > 0) {
    for (const s of activeSignals) {
      if (s.type !== "service") continue;
      const eta = parseDateLoose(s.eta);
      if (!eta) continue;
      const offset = dayOffsetFromToday(eta);
      if (offset !== 0 && offset !== 1) continue;
      const winStart = eta.getTime() - 2 * HOUR_MS;
      const winEnd = eta.getTime() + 2 * HOUR_MS;
      const allBlocked = memberIds.every((uid) =>
        memberBlockedInWindow(uid, winStart, winEnd)
      );
      if (allBlocked) {
        conflicts.push({
          type: "service_conflict",
          signal: s,
          reason: "nobody available",
          severity: "high",
        });
      }
    }

    // 2. DELIVERY — Out for Delivery today, every member blocked at
    //    some point during the day (signature deliveries don't share
    //    arrival windows with us; coarse-day overlap is the best we
    //    can do).
    for (const s of activeSignals) {
      if (s.status !== "Out for Delivery") continue;
      const eta = parseDateLoose(s.eta);
      if (!eta) continue;
      if (dayOffsetFromToday(eta) !== 0) continue;
      const ds = startOfDayMs(eta);
      const de = ds + 24 * HOUR_MS - 1;
      const allBlocked = memberIds.every((uid) =>
        memberBlockedInWindow(uid, ds, de)
      );
      if (allBlocked) {
        conflicts.push({
          type: "delivery_conflict",
          signal: s,
          reason: "nobody home for signature",
          severity: "medium",
        });
      }
    }
  }

  // 3. TRAVEL — travel signal within 48h that shares its day with a
  //    service or signature-delivery signal. Doesn't depend on member
  //    availability since travel is presence-blocking on its own.
  for (const t of activeSignals) {
    if (t.type !== "travel") continue;
    const eta = parseDateLoose(t.eta);
    if (!eta) continue;
    const hoursOut = (eta.getTime() - Date.now()) / HOUR_MS;
    if (hoursOut < -1 || hoursOut > 48) continue;
    const ds = startOfDayMs(eta);
    const de = ds + 24 * HOUR_MS - 1;
    const conflicting = activeSignals.find((o) => {
      if (String(o.id) === String(t.id)) return false;
      const isPhysical = o.type === "service" || o.status === "Out for Delivery";
      if (!isPhysical) return false;
      const oe = parseDateLoose(o.eta);
      if (!oe) return false;
      const ot = oe.getTime();
      return ot >= ds && ot <= de;
    });
    if (conflicting) {
      conflicts.push({
        type: "travel_conflict",
        signal: t,
        conflictingSignal: conflicting,
        reason: "timing conflict",
        severity: "high",
      });
    }
  }

  // 4. DEADLINE — vault item with renewalDate within 7 days and not
  //    handled. Pure date-math; no member context required.
  for (const v of allDeadlines) {
    if (v.handled) continue; // upstream filter already drops these but be safe
    const eta = parseDateLoose(v.eta);
    if (!eta) continue;
    const days = (eta.getTime() - Date.now()) / DAY_MS;
    if (days < -1 || days > 7) continue;
    const daysLeft = Math.max(0, Math.round(days));
    conflicts.push({
      type: "deadline_urgent",
      item: v,
      daysLeft,
      reason: `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`,
      severity: "high",
    });
  }

  // High before medium so the prompt's "lead with most severe" rule
  // and the iteration order in the brief both prioritize correctly.
  const severityRank = { high: 0, medium: 1, low: 2 };
  conflicts.sort(
    (a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9)
  );
  return conflicts;
}

// Handoff detection — surfaces situations where coordination is
// needed but not a full conflict. A handoff is *one* member blocked
// (calendar event, travel signal) when a service/delivery signal
// requires presence and *another* member is free to cover it.
//
// Returns one handoff (or null). Briefs already lead with conflicts
// and surface multiple of those; handoffs are more conversational —
// "Sarah's out this afternoon; the plumber will need James home" —
// and one per brief reads better than a list.
//
// Skips:
//   - signals already acknowledged via /api/signals?type=handoff
//   - cases where every member is blocked (that's a full conflict
//     and detectConflicts handles it)
//   - single-member households (no one to hand off to)
function detectHandoffs({
  activeSignals,
  calendarEvents,
  householdNameMap,
  requestingUserId,
  isSingleMember,
  ackedSignalIds,
}) {
  if (isSingleMember) return null;
  const memberIds = [
    requestingUserId,
    ...Array.from(householdNameMap?.keys() || []),
  ].filter(Boolean);
  if (memberIds.length < 2) return null;

  const events = Array.isArray(calendarEvents) ? calendarEvents : [];
  const blockingEvents = events.filter((e) =>
    e.workConflictCheck === true ||
    e.type === "work" ||
    e.type === "travel" ||
    eventClassifiedAs(e, ["work", "meeting", "call", "office", "flight", "trip"])
  );
  const memberWork = new Map(memberIds.map((id) => [id, []]));
  for (const e of blockingEvents) {
    const uid = e.userId;
    if (!uid || !memberWork.has(uid)) continue;
    memberWork.get(uid).push(e);
  }

  // A member also counts as unavailable when they have an active
  // travel signal whose ETA overlaps the window — flight at 3pm
  // blocks a 4pm plumber appointment for the traveler.
  function memberTravelBlocks(uid, startMs, endMs) {
    return activeSignals.some(
      (s) =>
        s.userId === uid &&
        s.type === "travel" &&
        (() => {
          const t = parseDateLoose(s.eta)?.getTime();
          return t != null && t >= startMs - 6 * HOUR_MS && t <= endMs + 6 * HOUR_MS;
        })()
    );
  }

  function memberBlockedInWindow(uid, startMs, endMs) {
    const events = memberWork.get(uid) || [];
    const calBlocked = events.some((e) => {
      const s = parseDateLoose(e.start)?.getTime();
      const eMs =
        parseDateLoose(e.end)?.getTime() || (s ? s + HOUR_MS : null);
      if (!s || !eMs) return false;
      return s <= endMs && eMs >= startMs;
    });
    return calBlocked || memberTravelBlocks(uid, startMs, endMs);
  }

  function nameFor(uid) {
    if (!uid) return null;
    if (uid === requestingUserId) return "you";
    return householdNameMap?.get(uid) || null;
  }

  for (const s of activeSignals) {
    const requiresPresence =
      s.type === "service" || s.status === "Out for Delivery";
    if (!requiresPresence) continue;
    if (ackedSignalIds && ackedSignalIds.has(String(s.id))) continue;
    const eta = parseDateLoose(s.eta);
    if (!eta) continue;
    const offset = dayOffsetFromToday(eta);
    if (offset !== 0 && offset !== 1) continue;

    const winStart = eta.getTime() - 2 * HOUR_MS;
    const winEnd = eta.getTime() + 2 * HOUR_MS;
    const blocked = memberIds.filter((uid) =>
      memberBlockedInWindow(uid, winStart, winEnd)
    );
    const free = memberIds.filter((uid) => !blocked.includes(uid));
    // Need exactly one available member for a clean handoff (when
    // everyone's free there's no need to coordinate; when no one's
    // free it's a conflict).
    if (blocked.length === 0 || free.length === 0) continue;

    const ownerUid = s.userId || null;
    const ownerBlocked = ownerUid ? blocked.includes(ownerUid) : false;

    // Classification:
    //   coverage_needed — signal owner is blocked, someone else is free
    //   awareness       — unowned signal, only one member free
    //   action_needed   — fall-back when owner cannot be inferred
    let kind;
    if (ownerUid && ownerBlocked) kind = "coverage_needed";
    else if (!ownerUid) kind = "awareness";
    else continue; // owner is free and we know it — no handoff needed

    const blockedNames = blocked.map(nameFor).filter(Boolean);
    const freeNames = free.map(nameFor).filter(Boolean);
    const blockedLabel = blockedNames[0] || "someone";
    const freeLabel = freeNames[0] || "someone";
    const desc = s.description || "the appointment";
    const timePart = offset === 0 ? "today" : "tomorrow";

    let message;
    if (kind === "coverage_needed") {
      message = `${
        blockedLabel === "you" ? "You are" : blockedLabel + " is"
      } out ${timePart} when ${desc} arrives — ${
        freeLabel === "you" ? "you'll" : freeLabel + " will"
      } need to cover.`;
    } else {
      message = `${desc} is ${timePart} — ${
        blockedLabel === "you" ? "you're" : blockedLabel + " is"
      } unavailable, so ${
        freeLabel === "you" ? "you'd" : freeLabel + " would"
      } need to be there.`;
    }

    return {
      type: kind,
      signalId: String(s.id),
      signal: s,
      unavailableMember: { userId: ownerUid, name: blockedLabel },
      availableMember: { userId: free[0], name: freeLabel },
      message,
    };
  }
  return null;
}

// Returns Map<userId, firstName> for every household member except the
// requesting user (whose first name comes from the existing userName
// resolution path). Uses the same scan pattern as sync.js and notify.js so
// new members joining via /api/invite are automatically picked up.
async function buildHouseholdNameMap(redis, householdId, requestingUserId) {
  const map = new Map();
  let cursor = "0";
  const memberKeys = [];
  do {
    const [next, batch] = await redis.scan(cursor, {
      match: "user:*:household",
      count: 100,
    });
    cursor = next;
    if (batch?.length) memberKeys.push(...batch);
  } while (cursor !== "0" && cursor !== 0);

  for (const key of memberKeys) {
    const memberUserId = key.slice("user:".length, -":household".length);
    if (memberUserId === requestingUserId) continue;
    const memberHouseholdId = await redis.get(key);
    if (memberHouseholdId !== householdId) continue;
    const profileRaw = await redis.get(`user:${memberUserId}:profile`);
    const profile =
      typeof profileRaw === "string" ? JSON.parse(profileRaw) : profileRaw;
    const firstName = profile?.name?.split(" ")[0];
    if (firstName) map.set(memberUserId, firstName);
  }
  return map;
}

// Returns the bracket tag for a signal/event/deadline based on its userId
// field. The requesting user's own signals get YOURS; another household
// member's get their first name; missing or unknown userIds fall back to
// HOUSEHOLD so Claude can choose neutral framing. Single-member
// households collapse every tag to YOURS since there is no one else.
function ownershipTag(item, requestingUserId, nameMap, isSingleMember = false) {
  // Crew attribution wins over userId — a signal explicitly tagged
  // to "Mia" should read as "[MIA'S]" regardless of which household
  // member's inbox brought it in. Single-member mode still
  // suppresses external-name framing in favor of "you".
  if (item && item.crewMemberId && !isSingleMember) {
    const crewName = String(item.crewMemberId).trim();
    if (crewName.length > 0) return `${crewName.toUpperCase()}'S`;
  }
  if (isSingleMember) return "YOURS";
  if (!item || !item.userId) return "HOUSEHOLD";
  if (item.userId === requestingUserId) return "YOURS";
  const firstName = nameMap.get(item.userId);
  if (firstName) return `${firstName.toUpperCase()}'S`;
  return "HOUSEHOLD";
}

function eventClassifiedAs(e, keywords) {
  const haystack = [
    e.category,
    Array.isArray(e.tags) ? e.tags.join(" ") : "",
    e.classification,
    e.title,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return keywords.some((k) => haystack.includes(k));
}

function isWithinNextHours(date, hours) {
  const ms = date.getTime() - Date.now();
  return ms >= -HOUR_MS && ms <= hours * HOUR_MS;
}

// Third Claude call after the brief itself is generated and segment-tagged.
// Produces a 4-sentence first-person explanation of what the model included,
// excluded, and is watching but didn't surface. Best-effort: any failure
// returns null and the brief still ships without a transparency entry.
async function generateTransparency(brief, pools) {
  if (!brief) return null;

  // Pre-format signal lines with the same authoritative day-count phrase
  // the main brief lifts from. Prevents the transparency Claude call
  // from computing its own day-count and getting it wrong (e.g.
  // claiming "in 8 days" when the actual gap is 13).
  const briefList = (arr) => {
    if (!arr || arr.length === 0) return "(none)";
    return arr
      .map((s) => {
        const desc = s.description || "Unknown";
        const phrase = s.eta ? daysFromTodayPhrase(s.eta) : null;
        return phrase ? `- ${desc} (${phrase})` : `- ${desc}`;
      })
      .join("\n");
  };
  const eventList = (arr) => {
    if (!arr || arr.length === 0) return "(none)";
    return arr.map((e) => `- ${e.title || "Untitled"}`).join("\n");
  };
  const horizonPhrase =
    pools.horizon?.eta ? daysFromTodayPhrase(pools.horizon.eta) : null;
  const horizonLine = pools.horizon
    ? `- ${pools.horizon.description || "Unknown"}${horizonPhrase ? ` (${horizonPhrase})` : ""}`
    : "(none)";

  const basePrompt = `You just generated this brief: ${brief}

The signals you considered were (each carries an authoritative day-count phrase in parentheses — lift it verbatim, do NOT compute your own):
Urgent: ${briefList(pools.urgent)}
Near window: ${briefList(pools.near)}
Health context: ${pools.healthContext ? JSON.stringify(pools.healthContext) : "(not connected)"}
Weather today: ${pools.weather || "(not available)"}
Childcare: ${eventList(pools.childcare)}
Home requirements: ${briefList(pools.homeRequirements)}
Horizon: ${horizonLine}
Carried forward: ${briefList(pools.carriedForward)}

Write a plain-language explanation of how you thought about today. Cover:
1. What you included and why (1-2 sentences)
2. What you excluded and why (1 sentence)
3. What you're watching that didn't make the brief (1 sentence)

Rules:
- Write in first person as Conductor — "I included..." "I left out..."
- Plain text only, no markdown
- Maximum 4 sentences total
- Honest and specific — name actual signals
- Calm, not defensive
- Never assert what the user said, noted, mentioned, told you, indicated, expressed, confirmed, asked, or wrote. Describe only the signals present in the pool and how you weighed them. If you want to convey a user state, frame it as your own inference: "I inferred X" or "this reads like X" — never "you noted X".
- Never compute or estimate how many days away something is. Each signal line above carries an authoritative day-count phrase in parentheses ("(in 5 days)", "(today)", "(in 2 weeks)", "(yesterday)"); lift that phrase verbatim if you reference timing. Do NOT produce your own counts like "in 8 days" — the math is frequently wrong, and the authoritative phrase is provided so you don't have to compute.
- Weather should appear in your reasoning ONLY if a weather condition actually changed which signals you included, excluded, or framed differently. "The clear weather made it a good weekend" is NOT a reason — that's rationalization, not influence. If you would have made the same inclusion decisions regardless of weather, do not mention weather in your reasoning at all. Be honest about what actually drove your choices.
- CRITICAL — NO QUANTIFIED HEALTH METRICS: NEVER quote specific health numbers, units, or quantified comparisons in the transparency text. The healthContext JSON above is for YOUR reasoning only — its fields (sleep.duration, hrv.current, hrv.baseline7d, restingHR, steps, activeCalories) must NEVER appear as numerals in the output. Specifically banned: "145 steps", "32 active calories", "32 kcal", "58 bpm", "42 ms", "7.2 hours of sleep", "6 hrs slept", "15% below baseline", "20% of normal". If health context shaped your reasoning, describe it qualitatively only: "low activity today", "recovery looks light", "the day's been quiet so far" — never with numerals. Treat numbers in healthContext like metadata: read them, weigh them, but never echo them back.`;

  // Generate-then-sweep loop for transparency. Same one-shot retry pattern
  // as the main brief: first attempt uses the base prompt; on sweep
  // violation the second attempt appends a retry addendum naming the
  // offending phrases. Best-effort: any failure (Anthropic, network) just
  // returns null and the brief still ships without transparency.
  const MAX_ATTEMPTS = 2;
  let text = null;
  let attempts = 0;
  let lastViolations = [];
  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    const promptToUse = lastViolations.length > 0
      ? basePrompt + buildRetryAddendum(lastViolations)
      : basePrompt;
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
          messages: [{ role: "user", content: promptToUse }],
        }),
      });
      const data = await response.json();
      const candidate = data?.content?.[0]?.text?.trim();
      if (!candidate) {
        if (!response.ok) {
          console.error("[transparency] non-content response", {
            status: response.status, errorType: data?.error?.type,
            errorMessage: data?.error?.message,
          });
        }
        break;
      }
      text = candidate;
      const violations = sweepTransparencyForViolations(text);
      if (violations.length === 0) {
        if (attempts > 1) console.log(`[transparency] sweep clean on retry attempt ${attempts}`);
        lastViolations = [];
        break;
      }
      console.log(
        `[transparency] sweep violations on attempt ${attempts}:`,
        violations.map((v) => `${v.rule}=${v.matches.length}`).join(" ")
      );
      lastViolations = violations;
    } catch (err) {
      console.error("Transparency generation failed:", err);
      return null;
    }
  }
  if (lastViolations.length > 0) {
    console.log(
      `[transparency] shipping after ${attempts} attempts with residual violations:`,
      lastViolations.map((v) => `${v.rule}[${v.matches.join("|")}]`).join(" ; ")
    );
  }
  return text;
}

// Fourth Claude call alongside segment-tagging and transparency. Produces
// "The Read" — 1-3 additional sentences of lower-urgency context that
// didn't make the main brief but are worth knowing this week. Surfaced
// on Ground via a collapsible section below the brief. Best-effort: any
// failure returns null and the brief still ships without it. Claude
// returns the literal string "NOTHING" when there's nothing additional
// worth saying — also mapped to null.
async function generateTheRead(brief, pools) {
  if (!brief) return null;

  const briefList = (arr) => {
    if (!arr || arr.length === 0) return "(none)";
    return arr.map((s) => `- ${s.description || "Unknown"}`).join("\n");
  };
  const eventList = (arr) => {
    if (!arr || arr.length === 0) return "(none)";
    return arr.map((e) => `- ${e.title || "Untitled"}`).join("\n");
  };

  const prompt = `You just wrote this brief: ${brief}

The signal pool was:
Urgent: ${briefList(pools.urgent)}
Near window: ${briefList(pools.near)}
Health context: ${pools.healthContext ? JSON.stringify(pools.healthContext) : "(not connected)"}
Weather today: ${pools.weather || "(not available)"}
Childcare: ${eventList(pools.childcare)}
Home requirements: ${briefList(pools.homeRequirements)}
Horizon: ${pools.horizon ? `- ${pools.horizon.description || "Unknown"}` : "(none)"}
Carried forward: ${briefList(pools.carriedForward)}
Background (already mentioned in a prior brief, unchanged — surface here as quiet background awareness when other layers are thin): ${briefList(pools.backgroundRest)}

Always provide 1-2 sentences. If the brief already covered the most pressing items, write about what's quietly in the background — signals in motion that weren't urgent enough to lead with, things Conductor is watching, or forward-looking awareness for the week ahead. When the Background pool is non-empty AND there's nothing more pressing to say, you may name one or two of those items as still-in-motion context (e.g. "the HVAC appointment is still on the books for Thursday"). Never repeat anything specific from the brief. Never introduce new urgency. This is background awareness, not action items. Plain text only.`;

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
    const data = await response.json();
    const text = data?.content?.[0]?.text?.trim();
    // No more NOTHING escape clause — the prompt now mandates 1-2
    // sentences of background awareness regardless. Only an empty
    // response (rare, indicates API failure mid-stream) returns null.
    return text || null;
  } catch (err) {
    console.error("The Read generation failed:", err);
    return null;
  }
}

async function tagBriefSegments(brief, signals) {
  const fallback = [{ type: "text", content: brief || "" }];
  if (!brief || !signals || signals.length === 0) return fallback;

  const signalList = signals
    .map((s) => `- id: ${s.id} | type: ${s.type || "unknown"} | description: ${s.description || "Unknown"}`)
    .join("\n");

  // Build the set of legal signalIds up front so the post-parse pass
  // can coerce any hallucinated/borrowed id back to a text segment.
  // Crew events, calendar appointments, and other pool items that
  // surface in the brief without being in this signal list would
  // otherwise pick up an arbitrary id from the pool.
  const validIds = new Set(signals.map((s) => String(s.id)));

  // Authoritative id → type map. The prompt asks Claude to copy the
  // signal's type field verbatim, but the model still sometimes
  // re-classifies based on brief phrasing (e.g. tagging a vault
  // deadline as "unknown" because the brief calls it a subscription).
  // The validation pass below forces signalType to match what's in
  // the input pool, so output type fidelity is guaranteed regardless
  // of how Claude reads the brief.
  const ALLOWED_SIGNAL_TYPES = new Set([
    "package", "delivery", "food", "grocery", "service",
    "reservation", "appointment", "travel", "deadline", "unknown",
  ]);
  const idToType = new Map();
  for (const s of signals) {
    const t = ALLOWED_SIGNAL_TYPES.has(s.type) ? s.type : "unknown";
    idToType.set(String(s.id), t);
  }

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
        max_tokens: 1500,
        messages: [{
          role: "user",
          content: `Given this brief text and these signals, return a JSON array of segments. Each segment is either:
- { type: 'text', content: '...' } for plain text
- { type: 'signal', content: '...', signalId: '...', signalType: '...' } for phrases that refer to a specific signal

signalType MUST be exactly one of: package, delivery, food, grocery, service, reservation, appointment, travel, deadline, unknown. Copy the 'type' field directly from the matched signal's entry in the Signals list — that field IS the canonical signalType. Do NOT re-classify based on how the brief phrases it (e.g. if the signal's type is "deadline" and the brief calls it a "subscription", use "deadline" — the list is authoritative). Use "unknown" only when the matched signal's type is not in the allowed list above.

CRITICAL: signalId MUST be copied verbatim from the Signals list below — never invent, never reuse one signal's id for an unrelated phrase. If a phrase in the brief refers to something NOT in the Signals list (a calendar event, a crew member's activity, a weather note, a health metric), it MUST be a 'text' segment. When in doubt, prefer 'text'.

MATCHING: use fuzzy/substring matching when the brief paraphrases a signal — descriptions in the Signals list are the canonical form, but the brief naturally shortens them. If the brief mentions a service, subscription, product, or vendor name that partially matches a signal's description, tag it. Examples:
- Brief "Health Tech Nerds subscription" → matches signal description "Health Tech Nerds subscription renewal"
- Brief "Google Home renewal" → matches signal description "Google Home Premium Standard (Ranger Oaks) subscription renewal"
- Brief "the Wind Policy" → matches signal description "Wind Policy on Homeowners insurance renewal"
- Brief "your vehicle registration" → matches signal description "Vehicle registration renewal"
The distinctive brand/product/policy noun is the anchor — full-string identity is NOT required.

Split the brief exactly — every character must appear in exactly one segment. Signal phrases should be the natural language reference to that signal as it appears in the brief (e.g. 'hair styling items' not the full description). Return only the JSON array, nothing else.

Brief:
${brief}

Signals:
${signalList}`,
        }],
      }),
    });

    const data = await response.json();
    const text = (data && data.content && data.content[0] && data.content[0].text) || "";
    const cleaned = text.trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed) || parsed.length === 0) return fallback;

    const rejoined = parsed
      .map((seg) => (seg && typeof seg.content === "string" ? seg.content : ""))
      .join("");
    if (rejoined !== brief && rejoined.trim() !== brief.trim()) return fallback;

    // Validation pass: any signal segment whose signalId isn't in the
    // input pool gets demoted to a text segment. For valid IDs, force
    // signalType to match the canonical type from the input pool so the
    // segmenter can never drift away from the authoritative category.
    // Belt-and-braces on top of the prompt rule — guarantees output
    // fidelity regardless of how Claude reads brief prose.
    let coercedCount = 0;
    let typeCoercedCount = 0;
    const validated = parsed.map((seg) => {
      if (
        seg &&
        seg.type === "signal" &&
        (seg.signalId == null || !validIds.has(String(seg.signalId)))
      ) {
        coercedCount++;
        return { type: "text", content: seg.content };
      }
      if (seg && seg.type === "signal" && seg.signalId) {
        const canonical = idToType.get(String(seg.signalId));
        if (canonical && seg.signalType !== canonical) {
          typeCoercedCount++;
          return { ...seg, signalType: canonical };
        }
      }
      return seg;
    });
    if (coercedCount > 0) {
      console.log(`[brief] segmenter coerced ${coercedCount} segment(s) with invalid signalId to text`);
    }
    if (typeCoercedCount > 0) {
      console.log(`[brief] segmenter coerced ${typeCoercedCount} segment(s) signalType to canonical pool type`);
    }

    return validated;
  } catch (err) {
    console.error("Segment tagging failed:", err);
    return fallback;
  }
}

// ---------- inventory-derived signals ----------

// Synthesize proactive service signals from the household's home
// inventory. These are not persisted to :signals — they're computed
// on every brief from the current inventory state. Empty array when
// inventory is absent or no rules fire. Merged into activeSignals
// after the camouflage filter so they flow through bucketing the
// same way real signals do.
// Render the network context into the brief prompt. The model sees a
// concise summary per connected household at whatever permission level
// each connection granted. Default brief behavior is silence — the
// rules instruct the model to surface network context only when there
// is a meaningful change (a connection in heavy load, an emergency).
function formatNetworkForPrompt(networkContext) {
  if (!Array.isArray(networkContext) || networkContext.length === 0) {
    return "No connected households";
  }
  const lines = [];
  for (const c of networkContext) {
    const hid = c.connectedHouseholdId;
    const level = c.permissionLevel;
    const s = c.summary || {};
    if (level === "emergency_only") {
      lines.push(`- ${hid} [${level}]: hasEmergency=${s.hasEmergency ? "true" : "false"}`);
    } else if (level === "watchful") {
      lines.push(
        `- ${hid} [${level}]: signalLoad=${s.signalLoad || "?"}, urgent=${s.urgentCount ?? 0}`
      );
    } else {
      const sig = (s.activeSignals || [])
        .slice(0, 3)
        .map((x) => x.description)
        .filter(Boolean)
        .join("; ");
      lines.push(
        `- ${hid} [${level}]: signalLoad=${s.signalLoad || "?"}, urgent=${
          s.urgentCount ?? 0
        }${sig ? `, active: ${sig}` : ""}`
      );
    }
  }
  return lines.join("\n");
}

function inventoryDerivedSignals(inventory, today = new Date()) {
  if (!inventory || typeof inventory !== "object") return [];
  const signals = [];
  const nowMs = today.getTime();
  const nowYear = today.getFullYear();

  function ageYears(yearInstalled) {
    if (yearInstalled == null) return null;
    const y = parseInt(yearInstalled, 10);
    if (isNaN(y)) return null;
    return nowYear - y;
  }

  // Roof >15 years old + no recent inspection within 2 years → Horizon
  // candidate. eta=null so the horizon picker treats it as a no-date
  // long-tail item rather than a near-window deadline.
  const roof = inventory.roof;
  if (roof) {
    const age = ageYears(roof.yearInstalled);
    const lastInspectMs = roof.lastInspected ? Date.parse(roof.lastInspected) : NaN;
    const recentInspection = !isNaN(lastInspectMs) && (nowMs - lastInspectMs) < 730 * DAY_MS;
    if (age != null && age > 15 && !recentInspection) {
      signals.push({
        id: `inv_roof_${nowMs}`,
        description: `Roof inspection: ${age}-year-old ${roof.material || "roof"} due for review`,
        type: "service",
        sender: "Home Inventory",
        eta: null,
        state: "incoming",
        source: "inventory",
        _inventoryDerived: true,
      });
    }
  }

  // HVAC >10 years old + approaching summer (Apr-Jun) → near-window
  // pre-summer tune-up reminder. Targets mid-May; rolls forward if past.
  const hvac = inventory.hvac;
  if (hvac) {
    const age = ageYears(hvac.yearInstalled);
    const month = today.getMonth();
    const approachingSummer = month >= 3 && month <= 5;
    if (age != null && age > 10 && approachingSummer) {
      const target = new Date(nowYear, 4, 15);
      if (target.getTime() < nowMs) target.setFullYear(nowYear + 1);
      signals.push({
        id: `inv_hvac_${nowMs}`,
        description: `${hvac.brand || "HVAC"} system ${age} years old — pre-summer tune-up worth scheduling`,
        type: "service",
        sender: "Home Inventory",
        eta: target.toISOString(),
        state: "incoming",
        source: "inventory",
        _inventoryDerived: true,
      });
    }

    // HVAC lastServiced >90 days → filter change reminder (near window).
    const lastServicedMs = hvac.lastServiced ? Date.parse(hvac.lastServiced) : NaN;
    if (!isNaN(lastServicedMs) && (nowMs - lastServicedMs) > 90 * DAY_MS) {
      signals.push({
        id: `inv_filter_${nowMs}`,
        description: `HVAC filter change overdue — last serviced ${hvac.lastServiced}`,
        type: "service",
        sender: "Home Inventory",
        eta: new Date(nowMs + 7 * DAY_MS).toISOString(),
        state: "incoming",
        source: "inventory",
        _inventoryDerived: true,
      });
    }
  }

  // Water heater >10 years → deadline-typed long-tail item.
  const wh = inventory.waterHeater;
  if (wh) {
    const age = ageYears(wh.yearInstalled);
    if (age != null && age > 10) {
      signals.push({
        id: `inv_wh_${nowMs}`,
        description: `Water heater ${age} years old — typical lifespan is 8-12, worth planning replacement`,
        type: "deadline",
        sender: "Home Inventory",
        eta: null,
        state: "incoming",
        source: "inventory",
        _inventoryDerived: true,
      });
    }
  }

  // Vehicle within 500 miles of next 10k milestone → service reminder.
  if (Array.isArray(inventory.vehicles)) {
    for (const v of inventory.vehicles) {
      const mileage = parseInt(v.mileage, 10);
      if (isNaN(mileage)) continue;
      const next10k = Math.ceil(mileage / 10000) * 10000;
      const milesToNext = next10k - mileage;
      if (milesToNext >= 0 && milesToNext <= 500) {
        const label = [v.year, v.make, v.model].filter(Boolean).join(" ").trim() || "Vehicle";
        signals.push({
          id: `inv_vehicle_${(v.make || "x")}_${(v.model || "x")}_${nowMs}`,
          description: `${label} approaching ${next10k.toLocaleString()} miles — service interval`,
          type: "service",
          sender: "Home Inventory",
          eta: null,
          state: "incoming",
          source: "inventory",
          _inventoryDerived: true,
        });
      }
    }
  }

  return signals;
}

// ---------- synthesis ----------

// NOAA Rothfusz heat-index formula. Valid for T >= 80°F. Below that the
// "feels-like" temperature is just the air temperature. Returns rounded F.
function computeHeatIndex(tempF, humidity) {
  if (tempF == null || humidity == null) return null;
  if (tempF < 80) return Math.round(tempF);
  const T = tempF;
  const R = humidity;
  const HI =
    -42.379 +
    2.04901523 * T +
    10.14333127 * R -
    0.22475541 * T * R -
    0.00683783 * T * T -
    0.05481717 * R * R +
    0.00122874 * T * T * R +
    0.00085282 * T * R * R -
    0.00000199 * T * T * R * R;
  return Math.round(HI);
}

function classifySignalLoad({ urgentCount, nearCount, conflictsCount, carriedForwardCount }) {
  if (urgentCount >= 3 || (urgentCount >= 2 && nearCount >= 5) || conflictsCount >= 2) return "heavy";
  if (urgentCount >= 1 || nearCount >= 3 || conflictsCount >= 1) return "moderate";
  if (nearCount >= 1 || carriedForwardCount >= 1) return "light";
  return "clear";
}

function classifyHealthState(healthContext) {
  if (!healthContext) return null;
  const sleep = healthContext.sleep?.duration ?? null;
  const hrv = healthContext.hrv?.current ?? null;
  const baseline = healthContext.hrv?.baseline7d ?? null;
  const hrvRatio = (hrv != null && baseline) ? hrv / baseline : null;
  if ((sleep != null && sleep < 5) || (hrvRatio != null && hrvRatio < 0.75)) return "poor";
  if ((sleep != null && sleep < 6) || (hrvRatio != null && hrvRatio < 0.85)) return "low";
  if ((sleep == null || sleep >= 7.5) && (hrvRatio == null || hrvRatio >= 1.0)) return "strong";
  return "normal";
}

// One-word condition label for the expanded Pulse card. Maps the open-meteo
// WMO code to the small product vocabulary (Clear / Partly cloudy / Rain /
// Storms / Snow / Foggy / Humid / Mixed). Humidity wins over Clear/Partly
// cloudy when humidity is high — that matches the synthesis layer's framing.
function conditionsLabel(weather) {
  if (!weather) return null;
  const { weatherCode, humidity } = weather;
  if (weatherCode != null) {
    if (weatherCode >= 95 && weatherCode <= 99) return "Storms";
    if (weatherCode >= 51 && weatherCode <= 67) return "Rain";
    if (weatherCode >= 80 && weatherCode <= 82) return "Rain";
    if (weatherCode >= 71 && weatherCode <= 77) return "Snow";
    if (weatherCode >= 45 && weatherCode <= 48) return "Foggy";
    if (humidity != null && humidity >= 75 && weatherCode <= 3) return "Humid";
    if (weatherCode <= 1) return "Clear";
    if (weatherCode <= 3) return "Partly cloudy";
  }
  if (humidity != null && humidity >= 75) return "Humid";
  return "Mixed";
}

function classifyWeatherState(weather, heatIndex) {
  if (!weather) return null;
  const { tempF, weatherCode, humidity } = weather;
  if (weatherCode != null && weatherCode >= 95 && weatherCode <= 99) return "stormy";
  if (heatIndex != null && heatIndex >= 105) return "extreme";
  if (tempF != null && tempF >= 100) return "extreme";
  if (tempF != null && tempF >= 88) return "hot";
  if (humidity != null && humidity >= 75) return "humid";
  return "clear";
}

// Outdoor-service heuristic: service-type signal whose description matches
// work that happens outside. Drives heat_caution and storm_plus_outdoor flags.
const OUTDOOR_SERVICE_REGEX = /\b(lawn|yard|landscap|garden|pest|exterminator|exterior|roof|gutter|pool|tree|window\s*clean|power\s*wash|pressure\s*wash|hvac|a\/?c|hardscap)\b/i;
function isOutdoorService(s) {
  if (!s || s.type !== "service") return false;
  return OUTDOOR_SERVICE_REGEX.test(s.description || "");
}
function outdoorServiceOnOffset(s, allowedOffsets) {
  if (!isOutdoorService(s)) return false;
  const eta = parseDateLoose(s.eta);
  if (!eta) return false;
  return allowedOffsets.includes(dayOffsetFromToday(eta));
}

// Deterministic synthesis pass. Reads every pool the brief has already
// bucketed and reduces to a structured state object that drives both the
// pulse-note Claude call and the editorial framing of the main brief.
function synthesizeHouseholdState({
  urgentForPrompt,
  nearForPrompt,
  conflicts,
  carriedForwardSignals,
  activeSignals,
  allDeadlines,
  healthContext,
  weather,
  upcomingCelebrations,
  travelPrep,
  location,
}) {
  const urgentCount = urgentForPrompt.length;
  const nearCount = nearForPrompt.length;
  const conflictsCount = conflicts.length;
  const carriedForwardCount = carriedForwardSignals.length;

  const signalLoad = classifySignalLoad({
    urgentCount, nearCount, conflictsCount, carriedForwardCount,
  });
  const healthState = classifyHealthState(healthContext);
  const heatIndex = weather ? computeHeatIndex(weather.tempF, weather.humidity) : null;
  const weatherState = classifyWeatherState(weather, heatIndex);

  const sleepHours = healthContext?.sleep?.duration ?? null;
  const hrvCurrent = healthContext?.hrv?.current ?? null;
  const hrvBaseline = healthContext?.hrv?.baseline7d ?? null;
  const tempF = weather?.tempF ?? null;
  const humidity = weather?.humidity ?? null;

  const flags = [];

  if (
    (healthState === "low" || healthState === "poor") &&
    (weatherState === "hot" || weatherState === "humid" || weatherState === "extreme") &&
    heatIndex != null && heatIndex > 95
  ) flags.push("dehydration_risk");

  if (signalLoad === "heavy" && (healthState === "low" || healthState === "poor")) {
    flags.push("high_stress_load");
  }

  if (sleepHours != null && sleepHours < 6 && urgentCount >= 2) {
    flags.push("fatigue_plus_demands");
  }

  if (
    healthState === "strong" &&
    (signalLoad === "light" || signalLoad === "clear") &&
    conflictsCount === 0
  ) flags.push("green_light");

  if (healthState === "poor" && signalLoad === "light" && urgentCount === 0) {
    flags.push("rest_now");
  }

  if (travelPrep) flags.push("travel_prep");

  if ((upcomingCelebrations || []).some((c) => c.days === 0)) {
    flags.push("birthday_today");
  }

  // deadline_critical — any vault item with renewalDate within 48h, regardless
  // of whether it's already in the urgent pool. The flag is a tone signal, not
  // a routing rule.
  const deadlineCritical = (allDeadlines || []).some((d) => {
    const eta = parseDateLoose(d.eta);
    if (!eta) return false;
    const hours = (eta.getTime() - Date.now()) / HOUR_MS;
    return hours >= 0 && hours <= 48;
  });
  if (deadlineCritical) flags.push("deadline_critical");

  if (
    heatIndex != null && heatIndex > 100 &&
    activeSignals.some((s) => outdoorServiceOnOffset(s, [0]))
  ) flags.push("heat_caution");

  if (
    weatherState === "stormy" &&
    activeSignals.some((s) => outdoorServiceOnOffset(s, [0, 1]))
  ) flags.push("storm_plus_outdoor");

  let pulseWord;
  if (urgentCount >= 1 && (signalLoad === "heavy" || flags.includes("high_stress_load"))) {
    pulseWord = "urgent";
  } else if (flags.includes("rest_now")) {
    pulseWord = "recovery";
  } else if (signalLoad === "heavy") {
    pulseWord = "heavy";
  } else if (signalLoad === "moderate") {
    pulseWord = "full";
  } else if (signalLoad === "clear" && healthState === "strong") {
    pulseWord = "clear";
  } else if (signalLoad === "light") {
    pulseWord = "light";
  } else {
    pulseWord = "steady";
  }

  // Emotional state — drives prompt calibration so the brief / Pulse
  // / Week-in-Review can match the register of what the household is
  // experiencing. We surface the first high-intensity signal per
  // valence rather than enumerate; the brief prompt's "GRIEF SIGNAL
  // ACTIVE" / "HIGH STRESS" / "MILESTONE" blocks only need one
  // anchoring signal each to calibrate tone.
  const highIntensitySignals = (activeSignals || []).filter(
    (s) => s?.emotionalIntensity === "high" && (!s.state || s.state === "incoming" || s.state === "active")
  );
  const dominantValence = highIntensitySignals.length > 0
    ? highIntensitySignals[0].emotionalValence || "neutral"
    : "neutral";
  const activeGrief = highIntensitySignals.find((s) => s?.emotionalValence === "grief") || null;
  const activeStress = highIntensitySignals.find((s) => s?.emotionalValence === "stressful") || null;
  const activeMilestone = highIntensitySignals.find((s) => s?.emotionalValence === "joyful") || null;
  const emotionalState = {
    dominantValence,
    activeGrief,
    activeStress,
    activeMilestone,
  };

  return {
    signalLoad,
    urgentCount,
    conflicts: conflicts.map((c) => ({
      type: c.type,
      reason: c.reason || null,
      description: c.signal?.description || c.item?.description || null,
    })),
    healthState,
    weatherState,
    heatIndex,
    sleepHours,
    hrvCurrent,
    hrvBaseline,
    tempF,
    humidity,
    // UV peak — surfaced into the Pulse prompt when it's extreme
    // (above 10) so the model can mention midday-sun risk.
    uvPeakValue: weather?.uvPeak?.value ?? null,
    uvPeakTime: weather?.uvPeak?.time ?? null,
    synthesisFlags: flags,
    synthesisNote: null,           // populated by generatePulseNote after this returns
    pulseWord,
    emotionalState,
    // Carry the household's marketRegion through to the Pulse prompt
    // so the per-market vocabulary set fires correctly. Falls through
    // to "south_florida" for backwards compatibility (test household).
    locationContext: location?.marketRegion || "south_florida",
    locationLabel: location?.city
      ? `${location.city}, ${location.state}`
      : "Fort Lauderdale, FL",
    oura: healthContext?.oura || null,
  };
}

// One-sentence editorial synthesis from the structured state. Same best-effort
// failure model as transparency/theRead — any error returns null and the brief
// still ships with synthesisNote unset.
// First-anniversary detection. Reads every household member's
// connectedAt timestamp from user:{uid}:profile and computes the
// earliest. If today is exactly 365 days after that earliest moment
// (ET date match), this is anniversary day for the household.
// Returns:
//   { isAnniversary, anniversaryYearKey, yearStats } when matching
//   null otherwise
// yearStats summarizes the memory log for the closing-sentence Haiku.
async function detectFirstAnniversary(householdId, memberIds, memoryEntries) {
  if (!Array.isArray(memberIds) || memberIds.length === 0) return null;
  let earliest = null;
  for (const uid of memberIds) {
    try {
      const raw = await redis.get(`user:${uid}:profile`);
      const profile = typeof raw === "string" ? JSON.parse(raw) : raw;
      const ts = profile && typeof profile.connectedAt === "number"
        ? profile.connectedAt
        : profile && typeof profile.connectedAt === "string"
        ? Date.parse(profile.connectedAt)
        : NaN;
      if (Number.isFinite(ts)) {
        if (earliest == null || ts < earliest) earliest = ts;
      }
    } catch {
      // skip malformed
    }
  }
  if (earliest == null) return null;

  // ET-date comparison. Anniversary = (today's ET date) === (earliest +
  // 365 days in ET). Computed via toLocaleDateString in the user-facing
  // timezone so DST flips don't drift the match.
  const toET = (ms) =>
    new Date(ms).toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
    });
  const earliestPlus365 = earliest + 365 * 24 * 60 * 60 * 1000;
  if (toET(Date.now()) !== toET(earliestPlus365)) return null;

  // Stats for the closing-sentence prompt — pulled from memory log.
  const entries = Array.isArray(memoryEntries) ? memoryEntries : [];
  let totalRested = 0;
  let deadlinesCaught = 0;
  let totalLapsed = 0;
  for (const e of entries) {
    if (e.action === "resolved") {
      totalRested++;
      if (e.type === "deadline") deadlinesCaught++;
    }
    if (e.action === "expired" || e.action === "lapsed") totalLapsed++;
  }

  const year = new Date(earliest).toLocaleString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
  });
  return {
    isAnniversary: true,
    anniversaryYearKey: year,
    yearStats: {
      totalRested,
      deadlinesCaught,
      totalLapsed,
      householdAgeDays: Math.round((Date.now() - earliest) / (24 * 60 * 60 * 1000)),
    },
  };
}

// Haiku call to write one warm closing sentence acknowledging the
// year. Never says "Happy Anniversary". Returns string or null.
async function generateAnniversaryClosing(yearStats) {
  try {
    const prompt = `Write ONE warm sentence acknowledging that this household has been using Conductor for exactly one year today.

Stats:
- Signals rested this year: ${yearStats.totalRested}
- Deadlines caught before they slipped: ${yearStats.deadlinesCaught}
- Signals that lapsed: ${yearStats.totalLapsed}
- Household age: ${yearStats.householdAgeDays} days

Make it feel earned and personal. Reference specific numbers when they're meaningful (e.g. ${yearStats.totalRested} signals handled, ${yearStats.deadlinesCaught} deadlines caught). Never say "Happy Anniversary" — that reads as greeting-card. Just acknowledge it honestly.

Examples of the right tone:
"One year with Conductor today — ${yearStats.totalRested} signals handled, ${yearStats.deadlinesCaught} deadlines caught before they slipped, and the household is still running."
"Conductor has been watching your household for a year as of today. Quietly steady, mostly."

Return only the sentence, no quotes, no preamble.`;
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.content?.[0]?.text?.trim();
    if (!text) return null;
    return text.replace(/^["']|["']$/g, "").replace(/^Happy Anniversary[!.]?\s*/i, "");
  } catch (err) {
    console.warn("[anniversary] generation failed:", err?.message || err);
    return null;
  }
}

// Proactive question generator — one short curious question Conductor
// raises about something quietly stalled. Returns a string or null.
// Best-effort: any failure returns null so the brief still ships.
// Behavior patterns — distilled from the household's memory log.
// Used to give the brief voice a sense of how this household tends
// to operate. Returned values are kept loose; the prompt instructs
// Claude to use them as voice cues only (never quote them, never
// say "based on your patterns"). Anything that's not derivable
// returns null/empty rather than risking confident-but-wrong claims.
function analyzeBehaviorPatterns(memoryEntries) {
  const entries = Array.isArray(memoryEntries) ? memoryEntries : [];
  if (entries.length === 0) {
    return {
      fastResolvers: [],
      slowResolvers: [],
      peakDay: null,
      quietDay: null,
      avgResolutionHours: null,
      totalSignalsHandled: 0,
      householdAge: 0,
      personalityType: "steady",
    };
  }

  const senderHours = new Map();
  const typeHours = new Map();
  const dayBuckets = new Map();
  let oldest = Infinity;
  let totalResolved = 0;
  let totalResolveLatency = 0;
  let resolveLatencyCount = 0;

  for (const e of entries) {
    const actionMs = Date.parse(e.actionAt || "");
    if (!isNaN(actionMs)) {
      if (actionMs < oldest) oldest = actionMs;
    }
    if (e.action !== "resolved") continue;
    totalResolved++;
    // Resolution latency: how long the signal sat between import
    // (signalId is Date.now() at LPUSH time) and the resolve event.
    const importMs = typeof e.signalId === "number" ? e.signalId : NaN;
    if (!isNaN(importMs) && !isNaN(actionMs)) {
      const hours = Math.max(0, (actionMs - importMs) / (60 * 60 * 1000));
      totalResolveLatency += hours;
      resolveLatencyCount++;
      if (e.sender) {
        const cur = senderHours.get(e.sender) || { sum: 0, n: 0 };
        cur.sum += hours;
        cur.n += 1;
        senderHours.set(e.sender, cur);
      }
      if (e.type) {
        const cur = typeHours.get(e.type) || { sum: 0, n: 0 };
        cur.sum += hours;
        cur.n += 1;
        typeHours.set(e.type, cur);
      }
    }
    if (!isNaN(actionMs)) {
      const day = new Date(actionMs).toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        weekday: "long",
      });
      dayBuckets.set(day, (dayBuckets.get(day) || 0) + 1);
    }
  }

  // Fast = sender's avg-hours-to-resolve < 24h with at least 2
  // resolutions; slow = type's avg-hours-to-resolve > 72h with at
  // least 2 resolutions.
  const fastResolvers = [];
  for (const [sender, { sum, n }] of senderHours.entries()) {
    if (n >= 2 && sum / n < 24) fastResolvers.push(sender);
  }
  fastResolvers.sort();
  const slowResolvers = [];
  for (const [type, { sum, n }] of typeHours.entries()) {
    if (n >= 2 && sum / n > 72) slowResolvers.push(type);
  }
  slowResolvers.sort();

  let peakDay = null;
  let quietDay = null;
  if (dayBuckets.size > 0) {
    const sorted = [...dayBuckets.entries()].sort((a, b) => b[1] - a[1]);
    peakDay = sorted[0]?.[0] || null;
    quietDay = sorted[sorted.length - 1]?.[0] || null;
    if (peakDay === quietDay) quietDay = null;
  }

  const avgResolutionHours = resolveLatencyCount > 0
    ? Math.round(totalResolveLatency / resolveLatencyCount)
    : null;
  const householdAge = isFinite(oldest)
    ? Math.max(0, Math.round((Date.now() - oldest) / (24 * 60 * 60 * 1000)))
    : 0;

  // Personality classification from the latency distribution:
  //   proactive — avg latency < 24h (signals close fast)
  //   reactive  — avg latency > 96h (signals sit days)
  //   steady    — middle / unknown
  let personalityType = "steady";
  if (avgResolutionHours != null) {
    if (avgResolutionHours < 24) personalityType = "proactive";
    else if (avgResolutionHours > 96) personalityType = "reactive";
  }

  return {
    fastResolvers: fastResolvers.slice(0, 6),
    slowResolvers: slowResolvers.slice(0, 6),
    peakDay,
    quietDay,
    avgResolutionHours,
    totalSignalsHandled: totalResolved,
    householdAge,
    personalityType,
  };
}

async function generateConductorQuestion({
  activeSignals,
  vaultUpcoming,
  patterns,
  crewUpcoming,
}) {
  // Age old-active signals from their id (Date.now() at import time).
  // Anything still active 7+ days later is fair game for "still
  // moving forward?" framing.
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const stale = (activeSignals || [])
    .filter((s) => {
      const age = Date.now() - (s.id || 0);
      const open = !s.state || s.state === "incoming" || s.state === "active";
      return open && age > SEVEN_DAYS_MS;
    })
    .slice(0, 15)
    .map((s) => ({
      description: s.description || "Unknown",
      sender: s.sender || null,
      eta: s.eta || null,
      ageDays: Math.round((Date.now() - (s.id || 0)) / (24 * 60 * 60 * 1000)),
    }));
  const vaultBucket = (vaultUpcoming || [])
    .slice(0, 10)
    .map((v) => ({ description: v.description, eta: v.eta }));
  const patternsBucket = (patterns || [])
    .slice(0, 8)
    .map((p) => ({ sender: p.sender, type: p.type, interval: p.intervalDays }));
  const crewBucket = (crewUpcoming || [])
    .slice(0, 6)
    .map((e) => ({ description: e.description, when: e.date || e.start }));

  // If literally nothing on any axis, don't even spend a call.
  if (
    stale.length === 0 &&
    vaultBucket.length === 0 &&
    patternsBucket.length === 0 &&
    crewBucket.length === 0
  ) {
    return null;
  }

  const prompt = `You are Conductor. Based on this household's signals, identify ONE thing worth asking about that hasn't been addressed.

Look for:
- Signals that have been active more than 7 days without resolution
- Anticipated signals that haven't arrived (recurring patterns broken)
- Vault items approaching without any related signal activity
- Crew events coming up with no preparation signals
- Anything in the household that seems quietly stalled

Stale signals (7+ days active): ${JSON.stringify(stale)}
Vault upcoming (within 60 days): ${JSON.stringify(vaultBucket)}
Recurring patterns: ${JSON.stringify(patternsBucket)}
Crew upcoming events: ${JSON.stringify(crewBucket)}

Write ONE question maximum 15 words. Conversational, curious, never alarming. Examples of the right tone:
"The HVAC estimate has been quiet — still moving forward?"
"Mia's piano recital is in 10 days — anything to prepare?"
"The Amazon Subscribe & Save hasn't arrived this month — worth checking?"
"Your passport renewal has been on the radar — any progress?"

If nothing genuinely worth asking about: return null. Never manufacture.

Return JSON: { "question": string | null }`;

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
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.content?.[0]?.text?.trim();
    if (!text) return null;
    // Allow either { "question": "..." } JSON or a bare quoted/plain
    // string fallback. Strip code fences if Haiku wrapped it.
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      const q = parsed?.question;
      if (typeof q === "string" && q.trim().length > 0) return q.trim();
      return null;
    } catch {
      // Fallback: treat the raw text as the question if it looks like one.
      if (cleaned.length > 0 && cleaned.length < 200 && cleaned.includes("?")) {
        return cleaned.replace(/^["']|["']$/g, "");
      }
      return null;
    }
  } catch (err) {
    console.warn("[conductorQuestion] failed:", err?.message || err);
    return null;
  }
}

async function generatePulseNote(state) {
  if (!state) return null;

  const flagsLine = state.synthesisFlags.length > 0
    ? state.synthesisFlags.join(", ")
    : "none";

  const healthLine = state.healthState
    ? `${state.healthState}, sleep ${state.sleepHours != null ? `${state.sleepHours}h` : "unknown"}, HRV ${state.hrvCurrent != null ? state.hrvCurrent : "?"} vs baseline ${state.hrvBaseline != null ? state.hrvBaseline : "?"}`
    : "not connected";

  // Oura context — only present when the user has connected the ring
  // AND the day's data has synced. Frames readiness as a tier so the
  // model picks the right tonal vocabulary rather than echoing the
  // raw 0-100 score (Pulse numeral ban still applies).
  const oura = state.oura || null;
  const ouraLine = oura
    ? (() => {
        const score = oura.readiness?.score;
        const tier = score == null ? "unknown"
          : score < 50 ? "low"
          : score < 70 ? "moderate"
          : score < 85 ? "good"
          : "high";
        const effPct = oura.sleep?.efficiency != null
          ? `${oura.sleep.efficiency}%` : "unknown";
        const deepMin = oura.sleep?.deep_sleep_duration != null
          ? Math.round(oura.sleep.deep_sleep_duration / 60) + "m" : "unknown";
        const tempContrib = oura.readiness?.contributors?.body_temperature;
        const tempState = tempContrib == null ? "unknown"
          : tempContrib < 70 ? "elevated"
          : tempContrib < 85 ? "slightly elevated"
          : "normal";
        return `OURA READINESS: ${score ?? "?"}/100 — ${tier}\nSleep efficiency: ${effPct}\nDeep sleep: ${deepMin}\nTemperature: ${tempState}`;
      })()
    : null;

  const weatherLine = state.weatherState
    ? `${state.weatherState}, ${state.tempF != null ? `${state.tempF}°F` : "?"}, feels like ${state.heatIndex != null ? `${state.heatIndex}°F` : "?"}, humidity ${state.humidity != null ? `${state.humidity}%` : "?"}`
    : "unknown";

  const locationLabel = state.locationLabel || "Fort Lauderdale, FL";
  const region = state.locationContext || "south_florida";

  // Per-market weather phrase sets. The model picks from the block
  // matching the household's marketRegion only — keeps a Boston brief
  // from accidentally lifting "perfect South Florida morning."
  const WEATHER_VOCAB = {
    south_florida: `Fort Lauderdale / South Florida weather observations (use when weather is relevant):
- High humidity: 'feels like the inside of a greenhouse', 'heavy air today', 'the humidity has opinions'
- Afternoon storms: 'classic South Florida afternoon building', 'storms likely by 3pm', 'the sky will have thoughts later'
- Extreme heat: 'proper South Florida heat today', 'the kind of heat that slows everything down'
- Cold front: 'Fort Lauderdale cold front — practically sweater weather at 68°F'
- Clear and mild: 'perfect South Florida morning', 'the good kind of Florida day'`,
    nyc: `New York City weather observations (use when weather is relevant):
- Heat wave: 'classic New York summer', 'the kind of heat that empties the city'
- Cold snap: 'real New York cold today', 'the kind of cold that bites'
- Snow: 'first proper snow of the season', 'the city is quiet under it'
- Clear and crisp: 'one of those clean New York days', 'the kind of morning that justifies walking'
- Heavy rain: 'soaking rain — pavement-river day', 'sideways rain across the avenues'`,
    chicago: `Chicago weather observations (use when weather is relevant):
- Wind: 'wind off the lake today', 'Chicago wind that goes through layers'
- Cold: 'Chicago winter — dress for it', 'subzero day, plan accordingly'
- Lake effect snow: 'lake effect coming through', 'thick snow off the water'
- Mild summer: 'good Chicago summer day', 'the kind of weather the city was built for'
- Heat humidity: 'sticky Chicago heat', 'the humidity sits between the buildings'`,
    los_angeles: `Los Angeles weather observations (use when weather is relevant):
- Heat: 'real LA heat today', 'dry heat — different than humid heat'
- Marine layer: 'June Gloom morning', 'the marine layer is hanging on'
- Fire weather: 'dry windy day — fire weather', 'Santa Anas blowing'
- Rain (rare): 'rare LA rain — drive accordingly', 'the city forgets how to drive'
- Perfect day: 'the kind of LA day the postcards promised'`,
    seattle: `Seattle weather observations (use when weather is relevant):
- Rain: 'the usual Seattle grey', 'steady Seattle drizzle'
- Rare sun: 'rare Seattle sun — worth going outside', 'the kind of day you cancel plans to be outside'
- Cold rain: 'cold rain coming through', 'damp through-and-through kind of day'
- Wind storm: 'classic Pacific wind day', 'gusts off the Sound'
- Mild summer: 'proper Pacific Northwest summer — short, golden'`,
    boston: `Boston / New England weather observations (use when weather is relevant):
- Snow: 'proper New England snow today', 'real winter day in Boston'
- Cold: 'Boston cold that finds gaps in your coat'
- Nor'easter: 'nor'easter coming in — batten down', 'the kind of storm Boston gets right'
- Mild: 'one of those good New England days', 'crisp and clean'
- Humid summer: 'Boston summer humidity — the air is thick today'`,
    miami: `Miami / South Florida weather observations (use when weather is relevant):
- High humidity: 'feels like the inside of a greenhouse', 'Miami air today'
- Storms: 'storms building over the bay', 'classic afternoon rain'
- Heat: 'real Miami heat', 'the kind of day made for AC'
- Clear: 'perfect Miami morning'`,
    generic: `General weather observations (use when weather is relevant — neutral, no regional flavor):
- Hot: 'real heat today', 'the kind of day to take it slow'
- Cold: 'cold day — bundle up if you're out'
- Rain: 'steady rain coming through', 'pavement-glistening kind of day'
- Storm: 'storm building'
- Clear and mild: 'the good kind of day', 'one of those clean mornings'`,
  };
  const weatherVocab = WEATHER_VOCAB[region] || WEATHER_VOCAB.generic;

  // First-year anniversary acknowledgment — when present, the
  // model is instructed to weave a warm one-line acknowledgment
  // into the Pulse naturally, rather than tacking it on. Only
  // active on the exact anniversary day.
  const anniversaryLine = state.anniversaryYearStats
    ? `ANNIVERSARY: Today marks exactly one year since this household connected to Conductor. Stats for the year: ${state.anniversaryYearStats.totalRested} signals handled, ${state.anniversaryYearStats.deadlinesCaught} deadlines caught before they slipped. Weave a quiet, warm acknowledgment into the Pulse — never "happy anniversary", just an honest recognition that they've been at this for a year. Earned, not effusive.`
    : null;

  // Emotional context for the Pulse — when a high-intensity signal is
  // active, the prompt gets a tightly-worded calibration block. On
  // ordinary days the block is empty and the existing rules apply.
  const emo = state.emotionalState || {};
  const emoSignal = emo.activeGrief || emo.activeStress || emo.activeMilestone || null;
  const emoLine = `EMOTIONAL STATE: ${emo.dominantValence || "neutral"}\nActive high-intensity signal: ${emoSignal ? (emoSignal.description || "(unspecified)") : "none"}\n\nEmotional calibration for The Pulse:\n- Grief: quiet, present, minimal. Don't comment on productivity.\n- High stress: practical and grounding. Acknowledge the weight without adding to it.\n- Milestone joy: warm and permission-giving. Today deserves presence.\n- Neutral: normal synthesis rules apply.`;

  const prompt = `Given this household state, write one sentence that synthesizes what it means for today. Be specific, warm, and honest. Use the approved list of location-aware weather observations for ${locationLabel}. If a synthesis flag is active, lead with its implication — not the data behind it.

${emoLine}

${anniversaryLine ? anniversaryLine + "\n\n" : ""}Flags active: ${flagsLine}
Health: ${healthLine}
Weather: ${weatherLine}
${state.uvPeakValue != null ? `UV peak today: ${state.uvPeakValue} at ${state.uvPeakTime || "midday"}` : ""}
Signal load: ${state.signalLoad}, ${state.urgentCount} urgent
Location: ${locationLabel}
${ouraLine ? `\n${ouraLine}\n\nOura observations (use when readiness is notable, but follow the numeral-ban rule below — translate the tier, never echo the score):\n- Readiness low (under 50): 'Oura says recovery is low today', 'the ring says rest if you can'\n- Readiness moderate (50-69): 'recovery is moderate', 'solid but not peak'\n- Readiness high (85+): 'Oura says you're well recovered', 'the ring likes today'\n- Temperature elevated: 'body temperature is slightly up — worth watching'` : ""}

${weatherVocab}

If no synthesis flags are active and conditions are normal: write one quiet observation about the day ahead.
If green_light: acknowledge it warmly — this is a good day.
If dehydration_risk: lead with practical action, not alarm.
If high_stress_load: acknowledge the weight without adding to it.
If UV index peak today is above 10 (extreme): mention it briefly as "extreme UV today" or "midday sun is genuinely not worth it" — specific to the household's location context. Otherwise omit UV entirely.

NEVER quote specific numbers, percentages, or units directly. The structured values above (humidity %, temperature °F, HRV, steps, sleep hours, calories) are inputs for YOUR observation — translate them into human language, never echo them back:
- "77% humidity" → "heavy humidity" or "the air is thick today" or "the humidity has opinions"
- "94°F" → "proper South Florida heat" or "the heat is real today"
- "HRV 42" → "recovery looks low" or "your body is asking for a lighter day"
- "145 steps" → "you're just getting started" or "the day is early"
- "5.2 hours of sleep" → "a short night" or "running on less than you'd want"
The Pulse should feel like something a trusted friend observed — not a weather station readout. If you find yourself reaching for a numeral or a unit (%, °F, °C, bpm, ms, kcal, steps, hrs, hours), STOP and translate to a qualitative observation instead.

Maximum one sentence. No preamble. This is The Pulse.`;

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
        max_tokens: 120,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.content?.[0]?.text?.trim() || "";
    if (!text) return null;
    return text.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  } catch (err) {
    console.error("Pulse generation failed:", err?.message || err);
    return null;
  }
}

// ---------- post-generation sweep ----------

// Spelled-out English numbers covering the practical day/week range. The
// pattern rule in baseRules lists these as ineligible for paraphrased
// duration phrases; the sweep enforces the same vocabulary deterministically.
const SPELLED_NUMBERS = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty";
const QUANTIFIERS = "few|several|couple|handful|many|a few|a couple of";
const TIME_UNITS = "day|days|week|weeks|month|months|year|years";

// Window-phrase: paraphrased range like "in the next 3 days", "within the
// next few weeks", "over the coming couple of days". The brief should use
// the lifted parenthesized phrase or specific dates instead.
// Number-or-quantifier slot is optional so the regex catches bare-unit
// windows too: "over the next week", "in the coming month", "within the
// next year" all match without a number between "next/coming" and the unit.
const WINDOW_PHRASE_RE = new RegExp(
  "\\b(in|over|within|across|throughout)\\s+the\\s+(next|coming|upcoming)\\s+" +
  `(?:(${SPELLED_NUMBERS}|${QUANTIFIERS}|\\d+|a|an)\\s+(of\\s+)?)?` +
  `(${TIME_UNITS})\\b`,
  "gi"
);

// Inter-signal gap phrase: "eleven days later", "5 days after", "a week
// before". Bans paraphrased gaps between two future dates that already
// stand on their own.
const GAP_PHRASE_RE = new RegExp(
  `\\b(${SPELLED_NUMBERS}|\\d+|a|${QUANTIFIERS})` +
  `\\s+(${TIME_UNITS})` +
  "\\s+(later|after|ahead|earlier|afterward|subsequently|thereafter|from now|down the line|down the road|out)\\b",
  "gi"
);

// Banned weather-closer phrases — verbatim list from the weather rule. Any
// match means weather appeared as a closing flourish rather than as load-
// bearing context for a specific signal.
const WEATHER_CLOSER_RE = /\b(clear skies( today| ahead)?|otherwise quiet weather|nothing weather-related|the weather'?s calm|the day is clear and warm|with the nice weather|given the calm forecast|weather looks fine)\b/gi;

// Hydration / heavy-air nudges. The synthesis layer encourages these in The
// Pulse (correct — Pulse synthesizes weather + body + load). When they bleed
// into the brief proper, they violate the "weather only when it affects a
// specific named signal" rule. Pure-pattern: a hydration directive in the
// brief is almost never tied to a specific signal in practice, and the rare
// legitimate case (e.g. "stay hydrated for Mia's soccer game") is acceptable
// retry collateral since the retry budget is 1.
const HYDRATION_NUDGE_RE = /\b(drink (?:more )?water (?:throughout|today|often|early|all day|regularly)|stay hydrated|hydrate (?:today|early|often|throughout|more|all day|regularly)|keep water (?:close|nearby|handy|on you)|the air (?:is|feels) (?:thick|heavy|sticky|soupy)|heavy air today|humid today|muggy today|thick air|sticky (?:out|today))\b/gi;

// "until in N days" / similar glue malformations. The model lifts the
// authoritative parenthesized phrase correctly but glues it after "until"
// (or rarely "before" / "by"), producing constructions like "doesn't come
// due until in 11 days". Always ungrammatical — the lifted phrase only
// reads cleanly at the start of a timing clause, not after a preposition.
// Simple string match since "until in" has no legitimate English
// counterpart in a household brief.
const UNTIL_IN_RE = /\buntil in\b/gi;

// Fabricated date ranges / windows. The model occasionally invents a
// vague timeframe when the underlying signal has no ETA — "expected
// sometime between mid-December and the end of the year" being the
// canonical failure mode. These phrasings are almost never the result
// of an authoritative lift (briefs lift exact "(in N days)" phrases or
// named dates), so a verbatim-string match has very low false-positive
// risk and high diagnostic value.
// "anywhere from" intentionally NOT included — too many false positives
// on money ranges ("anywhere from $500 to $1,200") and other legitimate
// quantity expressions. The four matched patterns below are all
// unambiguous date inventions.
const INVENTED_DATE_RANGE_RE = /\b(sometime between\b|expected sometime\b|by the end of (?:the |this )?(?:year|month|quarter|week)\b|around the (?:end|middle|start) of (?:the |this )?(?:year|month|quarter|season|january|february|march|april|may|june|july|august|september|october|november|december)\b|in the (?:next|coming) (?:month|quarter|season) or so\b)/gi;

// Approved horizon-closer phrases. Eligibility rule: ONLY when attached to
// a signal >14 days out. We don't ban the phrase itself; we ban its use on
// a near-window signal. The eligibility check parses the surrounding
// sentence for a day-count or date.
const HORIZON_CLOSER_RE = /\b(worth watching|on the radar|conductor has its eye on this|watching for it|we'?ll flag it when it matters)\b/gi;

// Inline day-count: "in 11 days", "in 2 weeks", "in 1 day". Either bare or
// wrapped in parentheses — both render correctly through this pattern
// because \b sits at the (/)/digit boundary.
const INLINE_DAYCOUNT_RE = /\bin\s+(\d+)\s+(day|days|week|weeks)\b/gi;

// Near-keywords that imply within 14 days regardless of explicit dates.
const NEAR_KEYWORDS_RE = /\b(today|tomorrow|tonight|this (?:morning|afternoon|evening|week|weekend))\b/gi;

// Month + day-of-month date references. Catches "May 28", "Thursday, May 28",
// "December 5th", etc. Day-of-week alone is not matched (insufficient signal).
const MONTH_DAY_RE = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan\.?|Feb\.?|Mar\.?|Apr\.?|Jun\.?|Jul\.?|Aug\.?|Sept?\.?|Oct\.?|Nov\.?|Dec\.?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi;

// Bare ordinal day-of-month: "the 28th", "on the 5th", "by the 1st". The
// model used this to slip a horizon closer past MONTH_DAY_RE in the
// previous verification. Resolved to a date by picking the nearest future
// occurrence — same month if day >= today's day-of-month, otherwise next
// month. False positives in non-date contexts ("the 10th anniversary")
// are acceptable retry collateral.
const ORDINAL_DAY_RE = /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/gi;

// Resolve a bare ordinal ("the 28th") to days-from-today. Picks the
// nearest future occurrence — same month if day >= today's day-of-month,
// otherwise next month. Returns null for days outside 1-31 (which also
// filters out matched ordinals 32+).
function ordinalDayToDays(dayStr, today = new Date()) {
  const day = parseInt(dayStr, 10);
  if (!day || day < 1 || day > 31) return null;
  const todayDay = today.getDate();
  const year = today.getFullYear();
  const month = today.getMonth();
  const candidateMonth = day >= todayDay ? month : month + 1;
  const target = new Date(year, candidateMonth, day);
  if (isNaN(target.getTime())) return null;
  // Date constructor silently rolls invalid days (Feb 30 → Mar 2). If the
  // resulting day-of-month doesn't match the requested day, the month
  // we picked doesn't have that day; treat as not-a-date.
  if (target.getDate() !== day) return null;
  const startOfToday = new Date(year, month, todayDay);
  return Math.round((target.getTime() - startOfToday.getTime()) / 86400000);
}

// Returns the days-from-today for a {monthName, day} pair. Resolves
// year ambiguity by picking whichever interpretation (current or next
// calendar year) is closer to today — prevents "Jan 5" from being read
// as last January when written in December.
function daysFromToday(monthStr, dayStr, today = new Date()) {
  const cleanMonth = monthStr.replace(/\.$/, "");
  const day = parseInt(dayStr, 10);
  if (isNaN(day)) return null;
  const year = today.getFullYear();
  const thisYear = new Date(`${cleanMonth} ${day}, ${year}`);
  if (isNaN(thisYear.getTime())) return null;
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOfThisYear = new Date(thisYear.getFullYear(), thisYear.getMonth(), thisYear.getDate());
  const diff = Math.round((startOfThisYear.getTime() - startOfToday.getTime()) / 86400000);
  // If more than ~180 days in the past, the writer probably means next year.
  if (diff < -180) {
    const nextYear = new Date(`${cleanMonth} ${day}, ${year + 1}`);
    if (isNaN(nextYear.getTime())) return diff;
    const startOfNextYear = new Date(nextYear.getFullYear(), nextYear.getMonth(), nextYear.getDate());
    return Math.round((startOfNextYear.getTime() - startOfToday.getTime()) / 86400000);
  }
  return diff;
}

// Per-sentence eligibility check for horizon closers. Walks each sentence
// that contains a closer phrase, looking for any of:
//   1. Inline day-count <=14 ("in 11 days")
//   2. Near-keyword ("today", "tomorrow", "this week", etc.)
//   3. A parsed Month+Day date <=14 days from today
// First near-window indicator wins; the closer phrase is flagged with the
// specific evidence so the retry prompt can target the rewrite.
function checkHorizonCloserNearWindow(brief, today = new Date()) {
  if (!brief) return [];
  const violations = [];
  const sentences = brief.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    HORIZON_CLOSER_RE.lastIndex = 0;
    const closerMatch = HORIZON_CLOSER_RE.exec(sentence);
    if (!closerMatch) continue;

    let evidence = null;

    INLINE_DAYCOUNT_RE.lastIndex = 0;
    let dc;
    while ((dc = INLINE_DAYCOUNT_RE.exec(sentence)) !== null) {
      const n = parseInt(dc[1], 10);
      const unit = dc[2].toLowerCase();
      const days = unit.startsWith("week") ? n * 7 : n;
      if (days <= 14) {
        evidence = `"${dc[0]}" (${days}d)`;
        break;
      }
    }

    if (!evidence) {
      NEAR_KEYWORDS_RE.lastIndex = 0;
      const nk = NEAR_KEYWORDS_RE.exec(sentence);
      if (nk) evidence = `"${nk[0]}"`;
    }

    if (!evidence) {
      MONTH_DAY_RE.lastIndex = 0;
      let md;
      while ((md = MONTH_DAY_RE.exec(sentence)) !== null) {
        const days = daysFromToday(md[1], md[2], today);
        if (days != null && days >= 0 && days <= 14) {
          evidence = `"${md[0]}" (${days}d)`;
          break;
        }
      }
    }

    if (!evidence) {
      ORDINAL_DAY_RE.lastIndex = 0;
      let od;
      while ((od = ORDINAL_DAY_RE.exec(sentence)) !== null) {
        const days = ordinalDayToDays(od[1], today);
        if (days != null && days >= 0 && days <= 14) {
          evidence = `"${od[0]}" (${days}d)`;
          break;
        }
      }
    }

    if (evidence) {
      violations.push(`"${closerMatch[1]}" → ${evidence}`);
    }
  }
  return violations;
}

// Banned positive-health framings — verbatim from the strict health rule.
// The brief stays silent on normal/strong health; only deficits surface.
const POSITIVE_HEALTH_RE = /\b(your body (?:feels?|is|'s) strong|feeling strong|energy is good|in a strong window|strong recovery|recovery looks solid|good timing energy-wise|you're in a strong window)\b/gi;

function dedupeCi(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function sweepBriefForViolations(brief) {
  if (!brief || typeof brief !== "string") return [];
  const violations = [];
  const checks = [
    ["window_phrase", WINDOW_PHRASE_RE],
    ["gap_phrase", GAP_PHRASE_RE],
    ["weather_closer", WEATHER_CLOSER_RE],
    ["hydration_nudge", HYDRATION_NUDGE_RE],
    ["positive_health", POSITIVE_HEALTH_RE],
    ["until_in_glue", UNTIL_IN_RE],
    ["invented_date_range", INVENTED_DATE_RANGE_RE],
  ];
  for (const [rule, re] of checks) {
    const m = brief.match(re);
    if (m && m.length > 0) {
      violations.push({ rule, matches: dedupeCi(m) });
    }
  }
  // Horizon-closer eligibility — context-aware, not a single regex.
  const horizonMisuse = checkHorizonCloserNearWindow(brief);
  if (horizonMisuse.length > 0) {
    violations.push({ rule: "horizon_closer_near_window", matches: horizonMisuse });
  }
  return violations;
}

// ---------- transparency sweep ----------

// Health-metric numerals in the transparency text. The brief itself bans
// these via baseRules, but the transparency Claude call has its own
// prompt — these patterns target the leak path where transparency quotes
// the raw healthContext JSON values back to the user.
const TRANSPARENCY_HEALTH_NUMBER_RE = /\b\d+(?:\.\d+)?\s*(?:steps|calories|kcal|bpm|ms|hours?\s+of\s+sleep|hrs?\s+of\s+sleep|hours?\s+slept|hrs?\s+slept)\b/gi;

// "15% below baseline", "20% of average", etc. — quantified health
// comparisons. Bans the percentage-plus-baseline-anchor pattern.
const TRANSPARENCY_HEALTH_PCT_RE = /\b\d+%\s+(?:below|above|of|under|over)\s+(?:baseline|normal|average|usual|typical)\b/gi;

function sweepTransparencyForViolations(text) {
  if (!text || typeof text !== "string") return [];
  const violations = [];
  const checks = [
    ["health_number", TRANSPARENCY_HEALTH_NUMBER_RE],
    ["health_pct", TRANSPARENCY_HEALTH_PCT_RE],
  ];
  for (const [rule, re] of checks) {
    const m = text.match(re);
    if (m && m.length > 0) {
      violations.push({ rule, matches: dedupeCi(m) });
    }
  }
  return violations;
}

// Build a one-shot retry instruction the model receives appended to the
// original userPrompt. Explicit failure list — names the exact phrase and
// the rule it broke so the model can target the rewrite.
function buildRetryAddendum(violations) {
  const detail = violations
    .map(
      (v) =>
        `- ${v.rule}: ${v.matches.map((m) => `"${m}"`).join(", ")}`
    )
    .join("\n");
  return `

=== RETRY ATTEMPT ===
Your previous attempt at this brief contained these specific rule violations:
${detail}

Generate a new brief from scratch. The same rules apply — pay extra attention to the specific phrases flagged above. They MUST NOT appear in any form (paraphrase, synonym, or variant) in the new output. Substitute concrete dates or the lifted parenthesized phrases instead. Do not acknowledge this retry instruction in the brief itself.`;
}

// ---------- handler ----------

// Side-channel: returns the most recent stored Takeoff and Clearance briefs.
// Folded into brief.js to avoid a new function file. Both keys carry a 48h
// TTL set on every brief generation; the response also returns yesterday's
// calendar date so the modal can header it appropriately.
async function handleYesterday(req, res) {
  const { userId } = req.query;
  let householdId = "RangerOaks925";
  if (userId) {
    const hid = await redis.get(`user:${userId}:household`);
    if (hid) householdId = hid;
  }
  const [takeoff, clearance] = await Promise.all([
    redis.get(`household:${householdId}:yesterdayTakeoff`),
    redis.get(`household:${householdId}:yesterdayClearance`),
  ]);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const date = yesterday.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  return res.status(200).json({
    household: householdId,
    takeoff: typeof takeoff === "string" ? takeoff : null,
    clearance: typeof clearance === "string" ? clearance : null,
    date,
  });
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (req.query?.type === "yesterday") {
    return handleYesterday(req, res);
  }

  const { userId } = req.query;

  try {
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });

    let householdId = "RangerOaks925";
    if (userId) {
      const hid = await redis.get(`user:${userId}:household`);
      if (hid) householdId = hid;
    }

    let userName = "there";
    if (userId) {
      const profile = safeJson(await redis.get(`user:${userId}:profile`));
      if (profile && profile.name) userName = profile.name.split(" ")[0];
    }

    // Cache: notify.js calls /api/brief to extract the push-body first
    // sentence, and the user then opens the app a few minutes later
    // expecting the same brief. To avoid two Claude generations that
    // diverge in wording, the steady-state success path writes the
    // response to user:{userId}:currentTakeoff with a 6-hour TTL; the
    // next /api/brief call for the same user inside that window
    // returns the cached response verbatim. firstRun branch is
    // deliberately not cached (one-shot welcome flow).
    const CURRENT_TAKEOFF_TTL_S = 6 * 60 * 60;
    if (userId) {
      const cached = safeJson(await redis.get(`user:${userId}:currentTakeoff`));
      if (cached && typeof cached.brief === "string") {
        return res.status(200).json(cached);
      }
    }

    // Red Alert override — when an active alert is in motion, the
    // brief is replaced with a single-line directive and nothing
    // else. No Pulse, no Read, no segments, no extras. Mobile root
    // layout shows the full fullscreen overlay; this short circuit
    // exists so the in-app brief surface doesn't compete with it.
    try {
      const rawAlert = await redis.get(`household:${householdId}:activeAlert`);
      const activeAlert = rawAlert
        ? (typeof rawAlert === "string" ? JSON.parse(rawAlert) : rawAlert)
        : null;
      if (activeAlert && activeAlert.description) {
        const briefText = `🔴 RED ALERT — ${activeAlert.description}.`;
        const response = {
          brief: briefText,
          pulse: `Conductor Red Alert is active. ${activeAlert.description}.`,
          pulseFlags: ["red_alert"],
          segments: [{ type: "text", content: briefText }],
          transparency: null,
          theRead: null,
          handoff: null,
          alert: activeAlert,
          household: { id: householdId },
        };
        if (userId) {
          // Don't cache the override — the alert can be dismissed at
          // any moment and the steady-state brief should reappear on
          // the next call without waiting for the 6h TTL.
        }
        return res.status(200).json(response);
      }
    } catch (err) {
      console.warn("[brief] red alert check failed:", err?.message || err);
    }

    // Load location FIRST so weather fetch uses the household's actual
    // coords. Falls through to LOCATION_FALLBACK inside fetchWeather
    // when no location is stored — keeps unconfigured households on the
    // historical Fort Lauderdale defaults rather than failing weather
    // entirely.
    const householdLocation = (await loadHouseholdLocation(householdId)) || LOCATION_FALLBACK;

    // Pull all sources in parallel
    const [
      rawSignals,
      rawCalendar,
      rawHealth,
      rawHorizon,
      rawDeadlines,
      rawBriefed,
      rawPreferences,
      firstRunFlag,
      rawBriefedToday,
      rawBriefedThisWeek,
      rawClearanceBriefed,
      rawCarriedForward,
      householdNameMap,
      rawFeedbackStats,
      fetchedWeather,
      rawCrew,
      rawMembers,
      rawInventory,
      networkContext,
      rawActiveTransition,
      rawMemoryEntries,
      rawLocalEvents,
    ] = await Promise.all([
      redis.lrange(`household:${householdId}:signals`, 0, -1),
      // Multi-driver: merges per-user calendar slices, falls back to
      // the legacy single key for households that haven't synced yet
      // since the rollout. Returns a parsed array (not a JSON string),
      // but downstream safeJson on an array is a no-op so the existing
      // shape handling continues to work.
      loadHouseholdCalendar(redis, householdId),
      userId ? redis.get(`user:${userId}:health`) : Promise.resolve(null),
      redis.get(`household:${householdId}:horizon`),
      redis.lrange(`household:${householdId}:vault`, 0, -1),
      redis.lrange(`household:${householdId}:briefed`, 0, -1),
      userId ? redis.get(`user:${userId}:preferences`) : Promise.resolve(null),
      redis.get(`household:${householdId}:firstRun`),
      redis.hgetall(`household:${householdId}:briefedToday`),
      redis.smembers(`household:${householdId}:briefedThisWeek`),
      redis.smembers(`household:${householdId}:clearanceBriefed`),
      redis.smembers(`household:${householdId}:carriedForward`),
      buildHouseholdNameMap(redis, householdId, userId),
      redis.hgetall(`household:${householdId}:feedbackStats`),
      // Best-effort. Returns null on any failure so the brief still
      // ships without weather context. Per-household coordinates from
      // the location we loaded just before this Promise.all.
      fetchWeather(householdLocation),
      // Crew layer (children + pets). Single JSON-string key written
      // by the onboard worker's Job 4. Filter for today/tomorrow
      // events happens after parse, downstream.
      redis.get(`household:${householdId}:crew`),
      // Single-member households get a stripped-down ownership model:
      // all signals tag as YOURS and the prompt strips the multi-owner
      // narration rules. Avoids stilted "the household" framing when
      // there is only one person to address.
      redis.smembers(`household:${householdId}:members`),
      // Home inventory — JSON blob written through ?type=inventory.
      // Used to derive proactive service signals (roof/HVAC/water
      // heater age, vehicle mileage milestones, HVAC filter cadence).
      redis.get(`household:${householdId}:inventory`),
      // Network — connected households + per-permission summaries.
      // Empty array when household has no connections. Brief renders a
      // NETWORK section in the prompt only when this has entries.
      loadNetworkContext(householdId).catch((err) => {
        console.warn("[brief] network load failed:", err?.message || err);
        return [];
      }),
      // Active life transition (new_baby/new_home/divorce/...) when
      // present. Drives prompt-level tone adjustments — softer
      // framing, suppressed mentions, etc. — for the 90-day window.
      redis.get(`household:${householdId}:activeTransition`).catch(() => null),
      // Memory log — feeds analyzeBehaviorPatterns so the prompt
      // can carry voice cues calibrated to how this household
      // actually behaves over time.
      redis.lrange(`household:${householdId}:memory`, 0, -1).catch(() => []),
      // Eventbrite live local-events cache — refreshed weekly by
      // sync.js when EVENTBRITE_API_KEY is set. Empty array when the
      // key is missing or the cache hasn't been populated yet.
      redis.get(`household:${householdId}:localEvents`).catch(() => null),
    ]);
    const localEvents = (() => {
      if (!rawLocalEvents) return [];
      try {
        const parsed = typeof rawLocalEvents === "string"
          ? JSON.parse(rawLocalEvents)
          : rawLocalEvents;
        return Array.isArray(parsed) ? parsed : [];
      } catch { return []; }
    })();
    let isSingleMember = (rawMembers || []).length <= 1;

    // Parse the active-transition record. Divorce flips the household
    // into "treat as single-member" mode for tone — the other partner
    // shouldn't appear in the brief during the 90-day window.
    const activeTransition = (() => {
      try {
        return typeof rawActiveTransition === "string"
          ? JSON.parse(rawActiveTransition)
          : rawActiveTransition;
      } catch { return null; }
    })();
    if (activeTransition && activeTransition.type === "divorce") {
      isSingleMember = true;
    }

    // Test override: ?testWeatherCode=N&testWeatherTemp=N replaces the
    // fetched weather with a synthetic value. Used to verify weather
    // rule triggers (rain + outdoor service, heat + HVAC, etc.) without
    // waiting for actual weather conditions. Both params required to
    // activate — has no effect on normal traffic.
    let weather = fetchedWeather;
    {
      const tCode = req.query?.testWeatherCode;
      const tTemp = req.query?.testWeatherTemp;
      if (tCode != null && tTemp != null) {
        const code = parseInt(tCode, 10);
        const tempF = parseInt(tTemp, 10);
        if (!isNaN(code) && !isNaN(tempF)) {
          weather = {
            tempF,
            weatherCode: code,
            isRaining: code >= 51 && code <= 99,
            summary: classifyWeather(code, tempF),
          };
        }
      }
    }

    // Camouflage filter applied at LRANGE-parse time — every downstream
    // pool (urgent, near, carriedForward, segments, transparency, The
    // Read) reads from allSignals, so dropping camouflaged entries here
    // guarantees they never reach any brief surface.
    const camouflageRules = await loadCamouflageRules(householdId);
    const persistedSignals = applyCamouflage(
      (rawSignals || []).map(safeJson).filter(Boolean),
      camouflageRules
    );

    // Inventory-derived proactive signals — synthesized per-brief from
    // the current inventory state. Never persisted; flow through the
    // same bucketing as real signals so an aging-roof or filter-due
    // line lands in Horizon / Near pools naturally.
    const inventory = safeJson(rawInventory);
    const derivedSignals = inventoryDerivedSignals(inventory);
    const allSignals = [...persistedSignals, ...derivedSignals];

    // Carry-forward marking — happens before activeSignals is derived so the
    // flag is visible to downstream pools and the prompt. A signal that landed
    // in last night's clearanceBriefed (LAST CHANCE) and is still active this
    // morning gets carriedForward stamped on its record + an entry in the
    // carriedForward set so notify.js can detect "still open" at push time.
    const clearanceBriefedIds = new Set((rawClearanceBriefed || []).map(String));
    const carriedForwardKey = `household:${householdId}:carriedForward`;
    const carriedForwardIdsToAdd = [];
    if (clearanceBriefedIds.size > 0) {
      const signalsListKey = `household:${householdId}:signals`;
      for (let i = 0; i < allSignals.length; i++) {
        const s = allSignals[i];
        if (!s) continue;
        if (!clearanceBriefedIds.has(String(s.id))) continue;
        const stillActive = !s.state || s.state === "incoming" || s.state === "active";
        if (!stillActive) continue;
        if (s.carriedForward === true) continue; // already stamped on a prior run
        s.carriedForward = true;
        s.carriedForwardAt = Date.now();
        await redis.lset(signalsListKey, i, JSON.stringify(s));
        carriedForwardIdsToAdd.push(String(s.id));
      }
      if (carriedForwardIdsToAdd.length > 0) {
        await redis.sadd(carriedForwardKey, ...carriedForwardIdsToAdd);
        await redis.expire(carriedForwardKey, 48 * 60 * 60);
      }
    }

    let activeSignals = allSignals.filter(
      (s) => !s.state || s.state === "incoming" || s.state === "active"
    );

    // Financial awareness filter — suppresses routine finance noise
    // from the brief unless the user has explicitly opted into a
    // higher-engagement tier. Default 'silent' keeps things quiet:
    // only genuine anomalies (fraud-pattern, price-increase, charges
    // from previously cancelled services) make it through. The
    // financialAwareness pref is set via Settings.
    try {
      const prefsForFinancial = safeJson(rawPreferences) || {};
      const awareness = typeof prefsForFinancial.financialAwareness === "string"
        ? prefsForFinancial.financialAwareness
        : "silent";
      function isFinancialSignal(s) {
        const t = (s.type || "").toLowerCase();
        if (t === "financial" || t === "financial_anomaly") return true;
        const d = (s.description || "").toLowerCase();
        return /\bsubscription\b|\brenewal\b|\bcharge\b|\bpayment\b|\$\d/.test(d);
      }
      function isFinancialAnomaly(s) {
        if ((s.type || "").toLowerCase() === "financial_anomaly") return true;
        if (s.priceIncrease === true) return true;
        if (s.fromCancelledService === true) return true;
        return false;
      }
      function isWithinDays(eta, days) {
        if (!eta) return false;
        const ms = Date.parse(eta);
        if (isNaN(ms)) return false;
        const diff = (ms - Date.now()) / (24 * 60 * 60 * 1000);
        return diff >= 0 && diff <= days;
      }
      if (awareness === "silent") {
        activeSignals = activeSignals.filter((s) => !isFinancialSignal(s) || isFinancialAnomaly(s));
      } else if (awareness === "awareness") {
        activeSignals = activeSignals.filter((s) => {
          if (!isFinancialSignal(s)) return true;
          if (isFinancialAnomaly(s)) return true;
          return isWithinDays(s.eta, 7);
        });
      } else if (awareness === "tracking") {
        activeSignals = activeSignals.filter((s) => {
          if (!isFinancialSignal(s)) return true;
          if (isFinancialAnomaly(s)) return true;
          return isWithinDays(s.eta, 14);
        });
      }
      // 'planning' tier: no filter — full pool retained.
    } catch (err) {
      console.warn("[brief] financial filter failed:", err?.message || err);
    }

    const calendarEvents = safeJson(rawCalendar) || [];
    const healthContext = safeJson(rawHealth);
    const preferences = safeJson(rawPreferences) || { flaggedCategories: [] };
    if (!Array.isArray(preferences.flaggedCategories)) preferences.flaggedCategories = [];
    const briefedIds = new Set((rawBriefed || []).map((s) => String(s)));

    // Carry-forward pool — signals flagged on this run plus pre-existing ones
    // from the 48h set, intersected with still-active records. Drives both the
    // prompt section and (separately) the morning push suffix.
    const carriedForwardIds = new Set([
      ...(rawCarriedForward || []).map(String),
      ...carriedForwardIdsToAdd,
    ]);
    const carriedForwardSignals = activeSignals.filter((s) =>
      carriedForwardIds.has(String(s.id))
    );

    // Background-mute state — what was already narrated in the last 20h, and
    // what's been acknowledged this week. Both keys carry their own TTLs so
    // we don't have to prune here.
    const briefedTodayMap = (rawBriefedToday && typeof rawBriefedToday === "object")
      ? rawBriefedToday
      : {};
    const briefedThisWeek = new Set((rawBriefedThisWeek || []).map(String));

    // Returns the snapshot stored at the last brief, or null if this signal
    // wasn't in the previous run.
    function previousSnapshot(s) {
      const raw = briefedTodayMap[String(s.id)];
      if (raw == null) return null;
      if (typeof raw === "string") {
        try { return JSON.parse(raw); } catch { return null; }
      }
      return raw;
    }

    // True when status, state, and ring all match the prior brief — signal
    // hasn't moved meaningfully, so don't re-narrate. Urgent signals bypass
    // this check explicitly at the call site.
    function isBackgroundFiltered(s) {
      const prev = previousSnapshot(s);
      if (!prev) return false;
      const sameStatus = (prev.status || "") === (s.status || "");
      const sameState = (prev.state || "") === (s.state || "");
      const sameRing = (prev.ring || "") === computeRing(s);
      return sameStatus && sameState && sameRing;
    }

    // URGENT — never background-filtered. The user's instruction is explicit:
    // urgent always surfaces, even if the same signal landed in the last brief.
    const urgentSignals = activeSignals.filter(classifyUrgent);
    const urgentIds = new Set(urgentSignals.map((s) => String(s.id)));

    // NEAR WINDOW (excluding urgent) — background-filter applies. A near-window
    // signal that's already been narrated and hasn't shifted ring/status/state
    // moves to a background pool: max 1 surfaces as a quiet "still in motion"
    // mention in the brief, the rest flow to The Read so they're not silent
    // entirely.
    const nearWindowCandidates = activeSignals
      .filter((s) => !urgentIds.has(String(s.id)))
      .filter(isInNearWindow);
    const nearSignals = nearWindowCandidates.filter((s) => !isBackgroundFiltered(s));
    const backgroundNearSignals = nearWindowCandidates.filter((s) => isBackgroundFiltered(s));

    // DEADLINES — pulled from :vault (the new dedicated deadline storage).
    // Vault items use renewalDate; adapt to the eta-based shape the rest of
    // the file already expects, and stamp _isDeadline + type so the prompt
    // formatter renders them correctly. Pool boundaries per the vault spec:
    //   <14 days       → urgent
    //   14-60 days     → near window
    //   60-90 days     → horizon candidate (handled lower down)
    // Items past, beyond 90 days, or marked handled are dropped here.
    const allDeadlines = (rawDeadlines || [])
      .map(safeJson)
      .filter(Boolean)
      .filter((v) => !v.handled)
      .map((v) => ({
        ...v,
        eta: v.renewalDate || v.eta,
        _isDeadline: true,
        type: "deadline",
      }));
    const existingSignalDescs = new Set(
      activeSignals
        .map((s) => (s.description || "").toLowerCase().trim())
        .filter(Boolean)
    );

    function isSimilarToExistingSignal(desc) {
      if (!desc) return false;
      if (existingSignalDescs.has(desc)) return true;
      // substring overlap for "close match" — only if both strings are
      // long enough to make accidental overlap unlikely.
      for (const sd of existingSignalDescs) {
        if (sd.length >= 6 && desc.length >= 6 && (sd.includes(desc) || desc.includes(sd))) {
          return true;
        }
      }
      return false;
    }

    const urgentDeadlines = [];
    const nearDeadlines = [];
    const backgroundNearDeadlines = [];
    for (const d of allDeadlines) {
      const eta = parseDateLoose(d.eta);
      if (!eta) continue;
      const desc = (d.description || "").toLowerCase().trim();
      if (isSimilarToExistingSignal(desc)) continue;
      const days = (eta.getTime() - Date.now()) / DAY_MS;
      if (days >= -1 && days < 14) urgentDeadlines.push(d);
      else if (days >= 14 && days <= 60) {
        // Near-window vault items get the background-filter treatment too —
        // same "don't repeat last brief" rule applies; muted items spill into
        // the background pool rather than vanishing entirely.
        if (isBackgroundFiltered(d)) backgroundNearDeadlines.push(d);
        else nearDeadlines.push(d);
      }
      // 60-90 days reserved for horizon; handled below.
    }

    // Combined pools used in the prompt assembly section below.
    const urgentForPrompt = [...urgentSignals, ...urgentDeadlines];
    const nearForPrompt = [...nearSignals, ...nearDeadlines];

    // CHILDCARE — calendar events classified as childcare/kids/school within next 48h
    const childcareEvents = (Array.isArray(calendarEvents) ? calendarEvents : [])
      .filter((e) => eventClassifiedAs(e, ["childcare", "kids", "school"]))
      .filter((e) => {
        const start = parseDateLoose(e.start);
        return start && isWithinNextHours(start, 48);
      });

    // HOME REQUIREMENTS — service signals today or tomorrow. Same mute rule:
    // if we already flagged "Plumber tomorrow at 9" yesterday and nothing
    // changed, route to background instead of silently dropping.
    const homeRequirementsCandidates = activeSignals.filter(isHomeRequirement);
    const homeRequirements = homeRequirementsCandidates.filter((s) => !isBackgroundFiltered(s));
    const backgroundHomeRequirements = homeRequirementsCandidates.filter((s) => isBackgroundFiltered(s));

    // Background pool: signals that would have been narrated but are unchanged
    // since the last brief. Max 1 surfaces in the brief itself as a quiet
    // "still in motion" mention; the rest spill into The Read so they're
    // acknowledged in background-awareness prose rather than disappearing.
    // Urgent and status-changed signals are already excluded upstream
    // (isBackgroundFiltered checks status/state/ring; urgent bypass at the
    // urgentSignals filter).
    const backgroundPool = [
      ...backgroundNearSignals,
      ...backgroundHomeRequirements,
      ...backgroundNearDeadlines,
    ];
    const stillInMotion = backgroundPool[0] || null;
    const backgroundRest = backgroundPool.slice(1);

    // CREW — children + pets layer. Read the JSON-string household:{id}:crew
    // written by the onboard worker, then filter for upcomingEvents falling
    // today or tomorrow. The prompt rule below tells Claude to mention these
    // ONLY when something requires the household to act or be present —
    // routine recurring activities don't make the brief.
    const crewMembers = (() => {
      if (!rawCrew) return [];
      try {
        const parsed = typeof rawCrew === "string" ? JSON.parse(rawCrew) : rawCrew;
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })();
    const crewToday = [];
    for (const m of crewMembers) {
      // Custody-aware filtering: when a child's custodySchedule says
      // they are not with this household today, skip surfacing their
      // events. The Programme on mobile still shows them muted as
      // "Away" so the parent can see the full picture; the brief
      // simply doesn't mention them.
      if (m?.memberType === "child" && !isChildHomeToday(m)) continue;
      const relevantEvents = (m.upcomingEvents || []).filter((ev) => {
        const ms = parseDateLoose(ev.date)?.getTime();
        if (!ms) return false;
        const offset = dayOffsetFromToday(new Date(ms));
        return offset === 0 || offset === 1;
      });
      if (relevantEvents.length > 0) {
        crewToday.push({ ...m, _events: relevantEvents });
      }
    }
    function formatCrewLine(m) {
      const label = m.memberType === "pet"
        ? `${m.name || "pet"}${m.type ? ` (${m.type})` : ""}`
        : `${m.name || "child"}${m.age ? `, age ${m.age}` : ""}`;
      const evs = (m._events || []).map((e) => {
        const friendly = friendlyDate(e.date);
        return `${e.description}${friendly ? ` on ${friendly}` : ""}`;
      }).join("; ");
      // Co-parent annotation: if this is a child and one of the crew's
      // "extended" entries lists them in associatedChildren, surface the
      // co-parent's name so the prompt rule can decide whether to weave
      // a "coordinate pickup with X" line into the brief.
      let coParentNote = "";
      if (m.memberType === "child" && m.name) {
        const childLower = m.name.toLowerCase();
        const coParents = (crewMembers || [])
          .filter(
            (other) =>
              other &&
              other.memberType === "extended" &&
              other.relationship === "co-parent" &&
              Array.isArray(other.associatedChildren) &&
              other.associatedChildren.some(
                (c) => typeof c === "string" && c.toLowerCase() === childLower
              )
          )
          .map((other) => other.name)
          .filter(Boolean);
        if (coParents.length > 0) {
          coParentNote = ` | co-parent: ${coParents.join(", ")}`;
        }
      }
      return `- [${m.memberType.toUpperCase()}] ${label}: ${evs}${coParentNote}`;
    }

    // BIRTHDAYS + ANNIVERSARIES — collect from crew members AND from
    // other household members' profiles (the requesting user is
    // excluded by householdNameMap). 14-day forward window; today and
    // tomorrow surface unconditionally per the prompt rule. Each entry
    // carries the same authoritative "(in N days)" / "(today)" /
    // "(tomorrow)" phrase the rest of the brief uses, so Claude lifts
    // the count instead of computing it.
    const upcomingCelebrations = [];
    function pushIfUpcoming(who, relationship, kind, mmDd) {
      const days = daysUntilMMDD(mmDd);
      if (days == null || days > 14) return;
      // Synthesize a real date so daysFromTodayPhrase can produce the
      // same lift phrase the rest of the brief uses.
      const [mm, dd] = mmDd.split("-").map(Number);
      const nowSnap = new Date();
      let target = new Date(nowSnap.getFullYear(), mm - 1, dd);
      const todaySnap = new Date(nowSnap.getFullYear(), nowSnap.getMonth(), nowSnap.getDate());
      if (target.getTime() < todaySnap.getTime()) {
        target = new Date(nowSnap.getFullYear() + 1, mm - 1, dd);
      }
      const phrase = daysFromTodayPhrase(target.toISOString()) || `in ${days} days`;
      upcomingCelebrations.push({
        who, relationship, kind, mmDd, days, phrase,
        dateLabel: formatMMDD(mmDd),
      });
    }
    for (const m of crewMembers) {
      // Household members (memberType: "member") are covered by the
      // user-profile loop below — skip here to avoid double-pushing
      // the same birthday once we mirror profile edits into the crew
      // record for UI display purposes.
      if (m.memberType === "member") continue;
      if (m.birthday) pushIfUpcoming(m.name || "Unknown", m.memberType || "adult", "birthday", m.birthday);
      if (m.anniversary) pushIfUpcoming(m.name || "Unknown", m.memberType || "adult", "anniversary", m.anniversary);
    }
    // Other household members' birthdays — householdNameMap already
    // excludes the requesting user, so this naturally surfaces "the
    // other person's" birthday rather than the reader's own.
    for (const [memberUserId, memberFirstName] of (householdNameMap || new Map())) {
      try {
        const rawProfile = await redis.get(`user:${memberUserId}:profile`);
        const profile = typeof rawProfile === "string" ? JSON.parse(rawProfile) : rawProfile;
        if (profile?.birthday) pushIfUpcoming(memberFirstName, "household_member", "birthday", profile.birthday);
        if (profile?.anniversary) pushIfUpcoming(memberFirstName, "household_member", "anniversary", profile.anniversary);
      } catch {
        // ignored
      }
    }
    upcomingCelebrations.sort((a, b) => a.days - b.days);
    function formatCelebrationLine(ev) {
      return `- ${ev.who}'s ${ev.kind}: ${ev.dateLabel} (${ev.phrase})`;
    }

    // TRAVEL PREP — when any signal with type "travel" has ETA within
    // 72 hours, the brief shifts into pre-departure mode. We assemble
    // the trip context (accommodation on matching dates, pre-departure
    // deliveries, same-day service conflicts, destination weather)
    // and inject it as a high-priority layer the prompt is told to
    // lead with.
    const NOW_MS = Date.now();
    const SEVENTY_TWO_HOURS_MS = 72 * HOUR_MS;
    const imminentTravel = activeSignals
      .filter((s) => s.type === "travel" && s.eta)
      .map((s) => {
        const etaMs = parseDateLoose(s.eta)?.getTime();
        return etaMs ? { signal: s, etaMs } : null;
      })
      .filter(Boolean)
      .filter((x) => x.etaMs > NOW_MS && x.etaMs - NOW_MS <= SEVENTY_TWO_HOURS_MS)
      .sort((a, b) => a.etaMs - b.etaMs);

    let travelPrep = null;
    if (imminentTravel.length > 0) {
      const { signal: travelSignal, etaMs: travelEtaMs } = imminentTravel[0];
      const sevenDaysAfter = travelEtaMs + 7 * 24 * HOUR_MS;
      const sameDayWindowEnd = travelEtaMs + 24 * HOUR_MS;

      // Hotel/accommodation: reservation with ETA in [travel - 24h,
      // travel + 7 days]. Hotel check-ins typically fall on departure
      // day or shortly after for international travel.
      const accommodations = activeSignals
        .filter((s) => s.type === "reservation" && s.eta)
        .map((s) => ({ s, etaMs: parseDateLoose(s.eta)?.getTime() }))
        .filter((x) => x.etaMs && x.etaMs >= travelEtaMs - 24 * HOUR_MS && x.etaMs <= sevenDaysAfter)
        .map((x) => x.s);

      // Pre-departure deliveries: delivery/package with ETA before
      // travel, in the window (now, departure). Further-out deliveries
      // aren't relevant to this trip's checklist.
      const preDeparture = activeSignals
        .filter((s) => (s.type === "delivery" || s.type === "package") && s.eta)
        .map((s) => ({ s, etaMs: parseDateLoose(s.eta)?.getTime() }))
        .filter((x) => x.etaMs && x.etaMs > NOW_MS && x.etaMs < travelEtaMs)
        .map((x) => x.s);

      // Same-day conflicts: service or appointment on the same day as
      // travel (within 12h before to 24h after the travel ETA).
      const sameDayConflicts = activeSignals
        .filter((s) => (s.type === "service" || s.type === "appointment") && s.eta)
        .map((s) => ({ s, etaMs: parseDateLoose(s.eta)?.getTime() }))
        .filter((x) => x.etaMs && x.etaMs >= travelEtaMs - 12 * HOUR_MS && x.etaMs <= sameDayWindowEnd)
        .map((x) => x.s);

      // Destination extraction draws from the travel signal description
      // first, then accommodation as a fallback (a Hotel reservation in
      // Paris is just as telling as a flight to CDG). Weather fetch is
      // best-effort: 3s budget, returns null on any failure so the
      // brief still ships without destination weather.
      const destText = [
        travelSignal.description || "",
        accommodations[0]?.description || "",
      ]
        .filter(Boolean)
        .join(" ");
      const destination = extractDestination(destText);
      const destinationWeather = destination
        ? await fetchDestinationWeather(destination)
        : null;

      // Leave-by time — airport math. For the Fort Lauderdale household
      // (FLL): typical 20-30min drive + 2h domestic / 3h international
      // arrival buffer. Peak commute hours add 15min to the drive.
      // We don't currently store airport identity in the travel signal,
      // so we assume home airport based on household marketRegion and
      // surface a single conservative leave-by figure.
      const travelDate = new Date(travelEtaMs);
      const INTL_CITY = new Set([
        "London", "Paris", "Amsterdam", "Frankfurt", "Munich", "Zurich",
        "Madrid", "Barcelona", "Rome", "Venice", "Athens", "Istanbul",
        "Dublin", "Copenhagen", "Stockholm", "Helsinki", "Oslo",
        "Tokyo", "Seoul", "Beijing", "Shanghai", "Hong Kong", "Singapore",
        "Bangkok", "Dubai", "Doha", "Mumbai", "Delhi",
        "Sydney", "Melbourne", "Auckland",
        "São Paulo", "Rio de Janeiro", "Buenos Aires",
        "Mexico City", "Cancun", "Toronto", "Vancouver", "Montreal",
      ]);
      const isInternational = !!destination && INTL_CITY.has(destination);
      const driveMinutes = (() => {
        // Peak commute (7-9am OR 4-7pm) adds 15 min to base 30 min.
        const depHour = travelDate.getHours();
        const peak = (depHour >= 7 && depHour <= 9) ||
                     (depHour >= 16 && depHour <= 19);
        return peak ? 45 : 30;
      })();
      const arrivalBufferMinutes = isInternational ? 180 : 150;
      const leaveByMs =
        travelEtaMs - (driveMinutes + arrivalBufferMinutes) * 60 * 1000;
      const fmtTime = (ms) =>
        new Date(ms).toLocaleString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });

      travelPrep = {
        travelSignal,
        accommodations,
        preDeparture,
        sameDayConflicts,
        destination,
        destinationWeather,
        leaveBy: fmtTime(leaveByMs),
        leaveByMs,
        flightTime: fmtTime(travelEtaMs),
        airport: "FLL",
        driveMinutes,
        isInternational,
      };
    }

    function formatTravelPrepBlock() {
      if (!travelPrep) return null;
      const lines = [];
      const lift = (eta) => {
        const phrase = eta ? daysFromTodayPhrase(eta) : null;
        return phrase ? ` (${phrase})` : "";
      };
      lines.push(
        `Flight/travel: ${travelPrep.travelSignal.description || "Travel"}${lift(travelPrep.travelSignal.eta)}`
      );
      if (travelPrep.leaveBy && travelPrep.flightTime) {
        lines.push(
          `Departs ${travelPrep.flightTime} — leave home by ${travelPrep.leaveBy}` +
          ` (${travelPrep.driveMinutes}min drive to ${travelPrep.airport}` +
          (travelPrep.isInternational ? `, 3h international buffer)` : `, 2.5h domestic buffer)`)
        );
      }
      if (travelPrep.accommodations.length > 0) {
        lines.push(
          `Accommodation: ${travelPrep.accommodations.map((s) => `${s.description || "Reservation"}${lift(s.eta)}`).join("; ")}`
        );
      }
      if (travelPrep.destinationWeather) {
        lines.push(
          `Destination weather: ${travelPrep.destinationWeather.summary} at ${travelPrep.destination}`
        );
      } else if (travelPrep.destination) {
        lines.push(`Destination: ${travelPrep.destination} (weather unavailable)`);
      }
      if (travelPrep.preDeparture.length > 0) {
        lines.push(
          `Before you leave: ${travelPrep.preDeparture.map((s) => `${s.description || "Item"}${lift(s.eta)}`).join("; ")}`
        );
      }
      if (travelPrep.sameDayConflicts.length > 0) {
        lines.push(
          `Conflicts: ${travelPrep.sameDayConflicts.map((s) => `${s.description || "Conflict"}${lift(s.eta)}`).join("; ")}`
        );
      }
      return lines.join("\n");
    }

    // FLAGGED CATEGORIES — match against nearSignals + calendar events.
    // nearSignals is already background-filtered above, so flagged-category
    // matches inherit the mute behavior automatically.
    const flaggedSignals = {};
    for (const cat of preferences.flaggedCategories) {
      if (!cat || typeof cat !== "string") continue;
      const matchingSignals = nearSignals.filter((s) => s.type === cat);
      const matchingEvents = (Array.isArray(calendarEvents) ? calendarEvents : []).filter((e) =>
        eventClassifiedAs(e, [cat.toLowerCase()])
      );
      if (matchingSignals.length > 0 || matchingEvents.length > 0) {
        flaggedSignals[cat] = {
          signals: matchingSignals.map((s) => ({
            id: s.id,
            description: s.description,
            eta: s.eta,
            status: s.status,
            owner: ownershipTag(s, userId, householdNameMap, isSingleMember),
          })),
          events: matchingEvents.map((e) => ({
            title: e.title,
            start: e.start,
            owner: ownershipTag(e, userId, householdNameMap, isSingleMember),
          })),
        };
      }
    }

    // HORIZON
    let horizonSignal = null;
    let storedHorizon = safeJson(rawHorizon);
    const horizonFresh =
      storedHorizon &&
      typeof storedHorizon.timestamp === "number" &&
      Date.now() - storedHorizon.timestamp < 7 * DAY_MS;

    if (horizonFresh) {
      horizonSignal = storedHorizon.signal;
    } else {
      // Reuse the vault-adapted allDeadlines list rather than re-parsing
      // rawDeadlines. Boundary moves to 60-90 days under the new partition
      // (urgent < 14, near 14-60, horizon 60-90).
      const candidates = allDeadlines.filter((d) => {
        if (briefedIds.has(String(d.id))) return false;
        const eta = parseDateLoose(d.eta);
        if (!eta) return false;
        const offsetDays = (eta.getTime() - Date.now()) / DAY_MS;
        return offsetDays >= 60 && offsetDays <= 90;
      });
      if (candidates.length > 0) {
        // Most surprising — prefer the closest to the 60-day edge that hasn't been briefed.
        candidates.sort(
          (a, b) => parseDateLoose(a.eta).getTime() - parseDateLoose(b.eta).getTime()
        );
        horizonSignal = candidates[0];
        await redis.set(
          `household:${householdId}:horizon`,
          JSON.stringify({ signal: horizonSignal, timestamp: Date.now() })
        );
        await redis.lpush(`household:${householdId}:briefed`, String(horizonSignal.id));
      }
    }

    // HORIZON AWARENESS — outer-ring signals (ETA > 14 days) that haven't
    // been acknowledged this week. Broader than HORIZON SIGNAL: any active
    // signal qualifies, not just deadlines. Picks the closest-ETA so the
    // weekly nod lands on the most imminent of the far-out things. We mark
    // the picked signal in briefedThisWeek after the response is generated.
    let horizonAwarenessSignal = null;
    {
      const candidates = activeSignals.filter((s) => {
        if (s.status === "Delivered") return false;
        if (briefedThisWeek.has(String(s.id))) return false;
        const eta = parseDateLoose(s.eta);
        if (!eta) return false;
        return dayOffsetFromToday(eta) > 14;
      });
      candidates.sort(
        (a, b) => parseDateLoose(a.eta).getTime() - parseDateLoose(b.eta).getTime()
      );
      horizonAwarenessSignal = candidates[0] || null;
    }

    const isFirstRun =
      firstRunFlag === true || firstRunFlag === "true" || firstRunFlag === 1 || firstRunFlag === "1";

    // ---------- prompt assembly ----------

    // Resolve raw timestamps server-side so Claude never has to compute day-of-week
    // or date arithmetic. The model just lifts the friendly string into the prose.
    const friendlyDate = (value) => {
      const d = parseDateLoose(value);
      if (!d) return null;
      return d.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
    };
    const friendlyDateTime = (value) => {
      const d = parseDateLoose(value);
      if (!d) return null;
      return d.toLocaleString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    };

    // daysFromTodayPhrase is module-scope so generateTransparency can
    // also use it for lift-don't-compute pre-formatting.

    const etaWithFriendly = (raw) => {
      const friendly = friendlyDate(raw);
      if (!raw) return "Unknown";
      if (!friendly) return raw;
      const phrase = daysFromTodayPhrase(raw);
      return phrase ? `${friendly} (${phrase}) (raw: ${raw})` : `${friendly} (raw: ${raw})`;
    };

    // Signal freshness — days since last update (lastUpdate ?? createdAt).
    // Emitted alongside each signal so the prompt rule can choose
    // staleness framing without recomputing dates.
    const signalAgeDays = (s) => {
      const stamp = s?.lastUpdate || s?.createdAt;
      if (!stamp) return 0;
      const ms = typeof stamp === "number" ? stamp : Date.parse(stamp);
      if (isNaN(ms)) return 0;
      return Math.floor((Date.now() - ms) / (24 * HOUR_MS));
    };
    const freshnessTag = (s) => {
      const d = signalAgeDays(s);
      if (d >= 14) return " | freshness: ANCIENT";
      if (d >= 7) return " | freshness: STALE";
      if (d >= 3) return " | freshness: NEAR";
      return "";
    };

    // Build a quick lookup of crew members marked as tenant. Used by
    // formatSignal to prefix [TENANT] on signals attributed to them
    // — investment_property households route signals through the
    // tenant rather than household members.
    const tenantNames = new Set();
    for (const m of crewMembers || []) {
      if (m && m.memberType === "tenant" && typeof m.name === "string") {
        tenantNames.add(m.name.toLowerCase().trim());
      }
    }
    const tenantPrefix = (s) => {
      const cm = s?.crewMemberId;
      if (!cm) return "";
      return tenantNames.has(String(cm).toLowerCase().trim()) ? "[TENANT] " : "";
    };

    const formatSignal = (s) => {
      const owner = `[${ownershipTag(s, userId, householdNameMap, isSingleMember)}]`;
      const tenant = tenantPrefix(s);
      if (s._isDeadline) {
        return `- ${owner} ${tenant}[DEADLINE] ${s.description || "Unknown"} | Due: ${etaWithFriendly(s.eta)} | Category: ${s.category || "uncategorized"}`;
      }
      // briefCount >= 3 tag surfaces only when the signal has crossed
      // the escalation threshold — the prompt rule "CARRY-FORWARD
      // ESCALATION" looks for this and reframes accordingly.
      const carryTag =
        typeof s.briefCount === "number" && s.briefCount >= 3
          ? ` | briefCount: ${s.briefCount}`
          : "";
      return `- ${owner} ${tenant}${s.description || "Unknown"} | ${s.status || "Unknown"} | ETA: ${etaWithFriendly(s.eta)} | Type: ${s.type || "unknown"}${freshnessTag(s)}${carryTag}`;
    };
    const formatEvent = (e) => {
      const owner = `[${ownershipTag(e, userId, householdNameMap, isSingleMember)}]`;
      const friendly = friendlyDateTime(e.start);
      const when = friendly || (e.start ? `raw: ${e.start}` : "Unknown");
      return `- ${owner} ${e.title || "Untitled"} | ${when}`;
    };

    // ---------- first-run branch ----------
    // The first brief Conductor ever writes for a household runs on a
    // deliberately starved pipeline: skip the layered context, take at most
    // two strict-filtered signals, fall back through calendar → vault →
    // hardcoded copy. The goal is a calm, welcoming first impression that
    // doesn't try to dazzle with an unfiltered firehose. Whatever path we
    // take, firstRun is flipped to "false" so tomorrow uses the normal
    // pipeline.
    if (isFirstRun) {
      // Strict signal filter: drop type:unknown and signals with neither
      // status nor ETA (no information density at all). Sort by info-density
      // score (eta + sender + description present), break ties by ETA
      // proximity. Keep at most two.
      const firstRunCandidates = activeSignals.filter((s) => {
        if (s.type === "unknown") return false;
        const statusUnknown = !s.status || s.status === "Unknown";
        const etaMissing = s.eta == null || s.eta === "";
        if (statusUnknown && etaMissing) return false;
        return true;
      });

      const infoDensity = (s) =>
        (s.eta ? 1 : 0) + (s.sender ? 1 : 0) + (s.description ? 1 : 0);

      firstRunCandidates.sort((a, b) => {
        const d = infoDensity(b) - infoDensity(a);
        if (d !== 0) return d;
        const ea = parseDateLoose(a.eta);
        const eb = parseDateLoose(b.eta);
        if (ea && eb) return ea.getTime() - eb.getTime();
        if (ea) return -1;
        if (eb) return 1;
        return 0;
      });

      const strictPool = firstRunCandidates.slice(0, 2);

      // Calendar fallback — only consulted when strictPool is empty.
      // Window: next 30 days, with a one-day past-tolerance for events
      // that just rolled over.
      const calendarPool = strictPool.length > 0
        ? []
        : (Array.isArray(calendarEvents) ? calendarEvents : [])
            .filter((e) => {
              const start = parseDateLoose(e.start);
              if (!start) return false;
              const offsetDays = (start.getTime() - Date.now()) / DAY_MS;
              return offsetDays >= -1 && offsetDays <= 30;
            })
            .sort(
              (a, b) =>
                parseDateLoose(a.start).getTime() - parseDateLoose(b.start).getTime()
            )
            .slice(0, 2);

      // Vault fallback — only when both prior pools are empty. One item
      // max; pick the soonest non-handled future renewal.
      const vaultPool =
        strictPool.length > 0 || calendarPool.length > 0
          ? []
          : allDeadlines
              .filter((v) => {
                const eta = parseDateLoose(v.eta);
                return eta && eta.getTime() > Date.now() - DAY_MS;
              })
              .sort(
                (a, b) =>
                  parseDateLoose(a.eta).getTime() - parseDateLoose(b.eta).getTime()
              )
              .slice(0, 1);

      const noSignals =
        strictPool.length === 0 && calendarPool.length === 0 && vaultPool.length === 0;

      const noSignalsCopy =
        "Nothing pressing today — Conductor is getting acquainted with your household and will have more to say tomorrow morning. Enjoy the open day. Conductor is just getting started — today is yours.";

      let firstRunBrief;
      if (noSignals) {
        firstRunBrief = noSignalsCopy;
      } else {
        let contextBlock;
        if (strictPool.length > 0) {
          contextBlock = `SIGNALS:\n${strictPool.map(formatSignal).join("\n")}`;
        } else if (calendarPool.length > 0) {
          contextBlock = `UPCOMING EVENTS:\n${calendarPool.map(formatEvent).join("\n")}`;
        } else {
          contextBlock = `DEADLINE:\n${vaultPool.map(formatSignal).join("\n")}`;
        }

        const firstRunRules = `FIRST-RUN RULES:
- This is the household's first brief. Be welcoming but not effusive.
- Maximum 2-3 sentences total.
- End with EXACTLY this sentence: "Conductor is just getting started — today is yours."
- Do not mention that this is the first brief.
- Tone: warm but not effusive. Give the user permission to relax. Hint at depth without explaining it. Feel like a trusted presence on day one.
- Plain text only, no markdown.
- Do not begin with date or header.
- Personalize to ${userName}.
${isSingleMember
  ? `- This is a single-person household. Always use "you" and "your". Never refer to any other household member by name. All signals belong to you. Never include the bracket tag in the brief.`
  : `- Ownership tags: every item is prefixed [YOURS], [NAME'S], or [HOUSEHOLD]. Use "you" for [YOURS], the named person for [NAME'S], household framing for [HOUSEHOLD]. NEVER include the bracket tags in the brief.`}
- When referring to a future date, lift the day-and-date verbatim from the friendly string already provided in the ETA field. NEVER compute or infer a date.
- If an item's ETA is "Unknown" or missing, do NOT invent or guess a date — even for holidays mentioned in the description. NEVER fabricate a date range or window in place of a missing ETA ("sometime between X and Y", "by the end of the year", "around the end of December" — all forbidden). A dateless item stays dateless.`;

        const firstRunUserPrompt = `Today is ${today}.\n\n${contextBlock}\n\n${firstRunRules}`;
        const firstRunSystemPrompt = `You are Conductor, a household intelligence layer. You write calm, trusted, personal morning briefs for ${userName}. Your voice is like a thought the reader was already having — never assistant-like, never listy, always prose.`;

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
            system: firstRunSystemPrompt,
            messages: [{ role: "user", content: firstRunUserPrompt }],
          }),
        });
        const data = await response.json();
        firstRunBrief = (data && data.content && data.content[0] && data.content[0].text) || "";
        // Defensive: if the model returns empty text, ship the hardcoded
        // copy so the user's first impression isn't a blank screen.
        if (!firstRunBrief) firstRunBrief = noSignalsCopy;
      }

      // Persist the brief and flip the flag. Even on noSignals we flip —
      // otherwise a household with no early signals stays stuck on the
      // welcome copy forever instead of moving onto the normal pipeline.
      if (firstRunBrief) {
        await redis.set(`household:${householdId}:yesterdayTakeoff`, firstRunBrief, {
          ex: 48 * 60 * 60,
        });
      }
      await redis.set(`household:${householdId}:firstRun`, "false");

      // Segment tagging best-effort. Calendar events aren't taggable
      // signals, so when the brief came from the calendar fallback we
      // ship a single text segment.
      const taggableSignals =
        strictPool.length > 0 ? strictPool : vaultPool.length > 0 ? vaultPool : [];
      const segments = noSignals || taggableSignals.length === 0
        ? [{ type: "text", content: firstRunBrief }]
        : await tagBriefSegments(firstRunBrief, taggableSignals);

      return res.status(200).json({
        brief: firstRunBrief,
        segments,
        transparency: null,
        // First-run is deliberately starved; no overflow context to
        // surface beyond the welcome brief itself.
        theRead: null,
        pulse: null,
        pulseFlags: [],
        pulseData: null,
        household: householdId,
        user: userName,
        isFirstRun: true,
        isSingleMember,
        noSignals,
      });
    }

    // Conflict detection runs only on the steady-state path — first-run
    // is deliberately starved and reaches its own early-return above.
    const conflicts = detectConflicts({
      activeSignals,
      allDeadlines,
      calendarEvents: Array.isArray(calendarEvents) ? calendarEvents : [],
      householdNameMap,
      requestingUserId: userId,
      weather,
    });

    // Handoff detection — runs alongside conflicts but is structurally
    // different: a handoff is a coordination prompt rather than a
    // collision. Acked handoffs (the user tapped "I have this") are
    // suppressed via the ackedSignalIds set, scoped to the morning of
    // the appointment.
    const ackHash = await redis
      .hgetall(`household:${householdId}:handoffsAck`)
      .catch(() => ({}));
    const ackedSignalIds = new Set(
      Object.keys(ackHash || {}).filter((k) => {
        // ack record: { acknowledgedBy, acknowledgedAt }. We only honor
        // an ack made in the last 36h so a stale ack from days ago
        // doesn't permanently silence a recurring signal.
        try {
          const r = typeof ackHash[k] === "string" ? JSON.parse(ackHash[k]) : ackHash[k];
          const ms = Date.parse(r?.acknowledgedAt || 0);
          if (isNaN(ms)) return false;
          return Date.now() - ms < 36 * HOUR_MS;
        } catch {
          return false;
        }
      })
    );
    const handoff = detectHandoffs({
      activeSignals,
      calendarEvents: Array.isArray(calendarEvents) ? calendarEvents : [],
      householdNameMap,
      requestingUserId: userId,
      isSingleMember,
      ackedSignalIds,
    });

    const conflictLines =
      conflicts.length > 0
        ? conflicts
            .map((c) => {
              // Ownership tag drives second-person vs name-of-other-
              // member vs neutral-household framing. Same routing the
              // rest of the prompt uses (formatSignal et al.). Without
              // this prefix, Claude anchors on the conflict's framing
              // and defaults to "your X" even when the signal belongs
              // to another household member — verified failure mode
              // with Sarah's seeded travel_conflict before this fix.
              // Vault items don't carry userId (household-level), so
              // they fall through to HOUSEHOLD.
              const owner = isSingleMember
                ? "YOURS"
                : c.signal
                ? ownershipTag(c.signal, userId, householdNameMap, isSingleMember)
                : "HOUSEHOLD";
              const desc =
                c.signal?.description || c.item?.description || "Unknown";
              const base = `- [${owner}] ${c.type}: ${desc} — ${c.reason || "timing conflict"}`;
              // Vault items carry a `consequence` string ("membership
              // lapses", "premium auto-charged to card on file") that
              // calibrates how seriously the deadline reads. Surface it
              // in the prompt so Claude can use the stakes to choose
              // tone — without quoting the field verbatim.
              if (c.item?.consequence) {
                return `${base} (if missed: ${c.item.consequence})`;
              }
              // Travel conflicts gain a lot from naming what they
              // collide with — otherwise Claude has to guess the
              // counterpart from the rest of the prompt. Tag the
              // conflicting signal's owner too so multi-member
              // collisions read correctly ("Sarah's flight collides
              // with [HOUSEHOLD] Window cleaner appointment").
              if (c.conflictingSignal?.description) {
                const collOwner = ownershipTag(
                  c.conflictingSignal,
                  userId,
                  householdNameMap,
                  isSingleMember
                );
                return `${base} (collides with: [${collOwner}] ${c.conflictingSignal.description})`;
              }
              return base;
            })
            .join("\n")
        : "None";

    // Synthesis layer — read every bucketed pool, reduce to a structured
    // household-state object, then issue one Haiku call for The Pulse. The
    // state object gets surfaced verbatim at the top of the brief prompt so
    // the model can take editorial cues from it without re-deriving the
    // signal load / health state / weather state by hand. Pulse generation
    // is best-effort: if it fails, synthesisNote stays null, the prompt
    // still includes the structured state, and the brief still ships.
    // Detect first-year anniversary BEFORE Pulse generation so the
    // Pulse prompt can weave in a warm acknowledgment naturally on
    // the day. memoryEntries is parsed downstream — for the
    // anniversary stats we parse the raw list here directly.
    const anniversaryMemEntries = (rawMemoryEntries || [])
      .map((r) => { try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } })
      .filter(Boolean);
    const anniversary = await detectFirstAnniversary(
      householdId,
      rawMembers || [],
      anniversaryMemEntries
    ).catch((err) => {
      console.warn("[anniversary] detector failed:", err?.message || err);
      return null;
    });

    const synthesisState = synthesizeHouseholdState({
      location: householdLocation,
      urgentForPrompt,
      nearForPrompt,
      conflicts,
      carriedForwardSignals,
      activeSignals,
      allDeadlines,
      healthContext,
      weather,
      upcomingCelebrations,
      travelPrep,
    });
    if (anniversary) synthesisState.anniversaryYearStats = anniversary.yearStats;
    synthesisState.synthesisNote = await generatePulseNote(synthesisState);

    // Emotional calibration block — only emitted when there's an
    // active high-intensity signal worth shaping the brief around.
    // For ordinary days the emotionalState is { dominantValence:
    // 'neutral', ... nulls } and the block stays empty.
    const emo = synthesisState.emotionalState || {};
    const emotionalCalibrationLines = [];
    emotionalCalibrationLines.push(`EMOTIONAL STATE: ${emo.dominantValence || "neutral"}`);
    if (emo.activeGrief) {
      emotionalCalibrationLines.push(
        `GRIEF SIGNAL ACTIVE: ${emo.activeGrief.description || "(unspecified)"}`,
        `RULES: Brief maximum 2 sentences. Only surface genuinely urgent signals.`,
        `No humor. No upbeat framing. No hobby signals. No local events.`,
        `Tone: present, warm, unhurried. Hold space.`
      );
    }
    if (emo.activeStress && emo.activeStress.emotionalIntensity === "high") {
      emotionalCalibrationLines.push(
        `HIGH STRESS SIGNAL ACTIVE: ${emo.activeStress.description || "(unspecified)"}`,
        `RULES: Lead with the stressful signal. Give actionable next steps.`,
        `De-prioritize other signals unless urgent. No pleasantries.`,
        `Tone: trusted advisor who knows things are hard.`
      );
    }
    if (emo.activeMilestone && emo.activeMilestone.emotionalIntensity === "high") {
      emotionalCalibrationLines.push(
        `MILESTONE SIGNAL ACTIVE: ${emo.activeMilestone.description || "(unspecified)"}`,
        `RULES: Acknowledge the milestone first, warmly and genuinely.`,
        `Practical signals come second. Conductor gives permission to be present.`,
        `Tone: celebratory but not performative. One true sentence about what today is.`
      );
    }
    if (emo.activeGrief || emo.activeStress || emo.activeMilestone) {
      emotionalCalibrationLines.push(
        ``,
        `GENERAL EMOTIONAL RULES:`,
        `- Match the register of what the household is experiencing`,
        `- Never be relentlessly practical in the middle of something significant`,
        `- Never manufacture urgency when the household is celebrating`,
        `- Never add levity when the household is grieving`,
        `- The brief should feel like it was written by someone who knows what's happening`
      );
    }

    const householdStateBlock = [
      `HOUSEHOLD STATE TODAY:`,
      `Signal load: ${synthesisState.signalLoad}`,
      `Health: ${synthesisState.healthState || "not connected"}`,
      `Weather: ${synthesisState.weatherState || "unknown"}${
        synthesisState.tempF != null ? `, ${synthesisState.tempF}°F` : ""
      }`,
      `Synthesis flags: ${
        synthesisState.synthesisFlags.length > 0
          ? synthesisState.synthesisFlags.join(", ")
          : "none"
      }`,
      `The Pulse: ${synthesisState.synthesisNote || "(unavailable)"}`,
      ``,
      emotionalCalibrationLines.join("\n"),
      ``,
      `Use this household state to inform the editorial judgment of the brief. A high_stress_load day calls for a calmer, more focused brief. A green_light day allows a slightly warmer opening. A dehydration_risk day warrants a mention of the weather in context. Let the synthesis flags guide the tone and emphasis — but never mention the flags explicitly. The structured fields above (signal load, health, weather state, flags, pulse word) are EDITORIAL CUES, not content. Never quote, paraphrase, or describe these values in the brief — phrases like "your body feels strong", "your body is strong right now", "energy is good", "you're in a strong window", "the day is moderate", "load is light", "it's humid" (when humidity isn't load-bearing for a signal) are all forbidden. The reader should feel the tone shift, not read the diagnostic.`,
    ].join("\n");

    const layeredContext = [
      `Today is ${today}.`,
      ``,
      householdStateBlock,
      ``,
      `TRAVEL PREP (within 72 hours — when this layer is non-empty, lead with it):`,
      travelPrep ? formatTravelPrepBlock() : "None",
      ``,
      `CONFLICTS DETECTED (surface these naturally and specifically — these are the most important things to mention):`,
      conflictLines,
      ``,
      `HANDOFF (one sentence, conversational; never use the word "handoff"; frame as natural household coordination — e.g. "Sarah is out this afternoon — the window cleaning at 2pm will need James to be home."):`,
      handoff ? handoff.message : "None",
      ``,
      `URGENT (surface first if present):`,
      urgentForPrompt.length > 0 ? urgentForPrompt.map(formatSignal).join("\n") : "None",
      ``,
      `HEALTH CONTEXT (one sentence if notable, silent if normal):`,
      healthContext ? JSON.stringify(healthContext) : "Not connected",
      ``,
      `WEATHER TODAY (silent unless it changes what someone should do about a signal):`,
      weather ? weather.summary : "Unknown",
      ``,
      // Annual + (eventually) Eventbrite local events. Tier 1 (safety)
      // always lands; tier 2 (major) only on quiet days or when it
      // directly intersects a signal; tier 3 (awareness) is mute
      // unless the brief otherwise has nothing.
      `LOCAL AND SEASONAL AWARENESS:`,
      (() => {
        const annual = getAnnualEvents(
          householdLocation?.marketRegion || "south_florida",
          new Date().toISOString()
        );
        // localEvents is the Eventbrite-cached live feed (refreshed
        // hourly by sync.js when EVENTBRITE_API_KEY is set) AND now
        // also the Nextdoor neighborhood feed (safety/recommendations
        // bypass this list; lost_found + deals land here). Falls back
        // to [] when the cache key is missing — annual events alone
        // still surface.
        //
        // Pet-relevant lost/found entries from Nextdoor surface only
        // when the household actually has a Crew pet — otherwise it's
        // just noise. crewMembers is in scope from the synthesis
        // block above.
        const hasPet =
          Array.isArray(crewMembers) &&
          crewMembers.some((m) => m?.memberType === "pet");
        const liveEvents = Array.isArray(localEvents) ? localEvents : [];
        const liveLines = liveEvents
          .filter((e) => e && e.date)
          .filter((e) => !e.petRelevant || hasPet)
          .slice(0, 5)
          .map((e) => {
            const ms = Date.parse(e.date);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const daysUntil = !isNaN(ms)
              ? Math.floor((ms - today.getTime()) / 86400000)
              : null;
            const whenLabel =
              daysUntil == null
                ? e.date
                : daysUntil === 0
                  ? "today"
                  : daysUntil < 0
                    ? "happening now"
                    : `in ${daysUntil} days`;
            const cap = e.capacity ? ` (cap ${e.capacity})` : "";
            const prox = e.proximityKm != null ? ` (~${e.proximityKm}km away)` : "";
            const src = e.source === "nextdoor" ? " [Nextdoor]" : "";
            return `- [live]${src} ${e.name} — ${whenLabel}${cap}${prox}`;
          });
        const annualLines = annual.map((e) => {
          const whenLabel =
            e.daysUntil === 0
              ? "today"
              : e.daysUntil < 0
                ? "happening now"
                : `in ${e.daysUntil} days`;
          return `- [tier ${e.tier}] ${e.name} — ${whenLabel}: ${e.note}`;
        });
        const lines = [...liveLines, ...annualLines];
        return lines.length > 0
          ? lines.join("\n")
          : "No major local events this week.";
      })(),
      ``,
      `CHILDCARE (mention if affects today or tomorrow):`,
      childcareEvents.length > 0 ? childcareEvents.map(formatEvent).join("\n") : "None",
      ``,
      `CREW (children and pets — mention only if relevant today or tomorrow, never daily routine):`,
      crewToday.length > 0 ? crewToday.map(formatCrewLine).join("\n") : "None",
      ``,
      `CREW BIRTHDAYS/ANNIVERSARIES (always surface if within 14 days):`,
      upcomingCelebrations.length > 0 ? upcomingCelebrations.map(formatCelebrationLine).join("\n") : "None",
      ``,
      `IN-PERSON HOME REQUIREMENTS (flag if nobody confirmed home):`,
      homeRequirements.length > 0
        ? homeRequirements
            .map((s) => `- ${s.description || "Unknown"} | ${etaWithFriendly(s.eta)}`)
            .join("\n")
        : "None",
      ``,
      `NEAR WINDOW — next 14 days:`,
      nearForPrompt.length > 0 ? nearForPrompt.map(formatSignal).join("\n") : "Nothing in the near window",
      ``,
      `STILL IN MOTION (at most one item — already covered in a prior brief, hasn't changed; mention quietly only if it adds value, otherwise omit):`,
      stillInMotion
        ? `- ${stillInMotion.description || "Unknown"} | ${etaWithFriendly(stillInMotion.eta)}`
        : "None",
      ``,
      `FLAGGED CATEGORIES:`,
      Object.keys(flaggedSignals).length > 0 ? JSON.stringify(flaggedSignals) : "No flagged categories set",
      ``,
      `CARRIED FORWARD FROM YESTERDAY (quiet note, end of brief before horizon, only if present):`,
      carriedForwardSignals.length > 0
        ? carriedForwardSignals.map(formatSignal).join("\n")
        : "None",
      ``,
      `HORIZON SIGNAL (one sentence, end of brief, surprising, specific):`,
      horizonSignal
        ? `- ${horizonSignal.description || "Unknown"} | ETA/Deadline: ${etaWithFriendly(horizonSignal.eta)}`
        : "None this week",
      ``,
      `HORIZON AWARENESS (mention at most once, at end of brief, one sentence only):`,
      horizonAwarenessSignal
        ? `- ${horizonAwarenessSignal.description || "Unknown"} | ETA: ${etaWithFriendly(horizonAwarenessSignal.eta)}`
        : "None",
      ``,
      `FEEDBACK HISTORY: Takeoff thumbs up: ${
        (rawFeedbackStats && rawFeedbackStats.takeoff_up) || 0
      }, thumbs down: ${
        (rawFeedbackStats && rawFeedbackStats.takeoff_down) || 0
      }. Clearance thumbs up: ${
        (rawFeedbackStats && rawFeedbackStats.clearance_up) || 0
      }, thumbs down: ${
        (rawFeedbackStats && rawFeedbackStats.clearance_down) || 0
      }.`,
      ``,
      `NETWORK (connected households — mention ONLY if there is a meaningful change worth surfacing, ONE sentence max, never daily; silent by default):`,
      formatNetworkForPrompt(networkContext),
    ].join("\n");

    const baseRules = `RULES:
- CRITICAL RULE: Maximum 5 sentences in the standard mode. EXCEPTION: when TRAVEL PREP is non-empty (travel within 72 hours), the cap relaxes to 7 sentences total to make room for trip context; drop non-travel content first to stay within that. Count every sentence aloud as you write — when you reach 5 sentences (or 7 in travel mode), STOP and end the brief, even if a layer is still unexplored. The cap is hard. A "Looking ahead" or "Beyond that" closing sentence still counts. A standalone single-sentence paragraph still counts. There is no off-by-one allowance — 6 sentences in standard mode is a rule break.
- CRITICAL RULE — UNIQUENESS: Each signal appears in EXACTLY ONE sentence in the brief. Before writing the final sentence, mentally enumerate every signal you've already named (by sender or short descriptor — "Health Tech Nerds", "Google Home", "Chime Card", "Mia's field trip", etc.) and verify your next sentence does not name any of them again. If the next sentence would re-name a signal already mentioned, DELETE that sentence and stop the brief. There is no exception. A second appearance is a rule break even if the framing is different ("the renewal" vs "the Google Home renewal"), even if separated by a paragraph break, even if the closing sentence "feels right" tonally, even if a horizon-closer phrase is attached. Pattern that ALWAYS fails this rule: body paragraph names a signal with a specific date, then closing sentence references the same signal again with the same date and a horizon closer ("…the Google Home renewal on Thursday, May 28 is worth watching"). That closing sentence is FORBIDDEN — delete it.
- CRITICAL RULE — BANNED CLOSING OPENERS: The phrases "Looking ahead", "Looking further out", "Looking forward", "Beyond that", "Further out", "Down the line", "On the longer horizon", and any equivalent are FORBIDDEN as sentence openers when their subject already appeared earlier in the brief. Even if the closer phrase is grammatical and the sentence reads well, if it re-names a signal that was already named, the sentence is a rule break and must be deleted. If you want to add a horizon-style closing sentence, it must introduce a NEW signal not previously mentioned. Otherwise: do not write that sentence. End the brief on the last unique-signal sentence.
- CRITICAL RULE — HORIZON-CLOSER ELIGIBILITY: The approved horizon-closer phrases (worth watching / Conductor has its eye on this / on the radar / watching for it / we'll flag it when it matters) apply ONLY to signals with day-count STRICTLY GREATER THAN 14 days. That means 15 days or more. Day-counts of 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0 are ALL ineligible for horizon closers — they are the near window and must be referenced by date or by the lifted parenthesized phrase only. The authoritative ETA field includes "(in N days)" — if N is 14 or less, no horizon closer of any kind may attach to that signal. A signal "(in 11 days)" gets "due Thursday, May 28" or "in 11 days" but NEVER "is worth watching" or "Conductor has its eye on this." If the only signal that would justify a horizon-style closing sentence is in the near window, OMIT the closing sentence entirely. Quiet endings are correct.
- SELF-CHECK BEFORE FINISHING: Read your draft once more. (1) For each sentence, identify the signal it names. (2) Confirm no signal name appears in two sentences. (3) For any sentence containing "worth watching", "on the radar", "Conductor has its eye on this", "watching for it", or "we'll flag it when it matters", confirm the signal's day-count is 15 or higher. (4) If any check fails, delete the offending sentence and re-read. A 3-sentence brief that passes all checks is better than a 5-sentence brief that doesn't.
- Synthesize all layers into flowing prose — never a list
- Travel prep: when TRAVEL PREP is non-empty (any item shown beyond "None"), OPEN the brief with travel context. Weave the flight time, accommodation, destination weather, pre-departure deliveries, and any same-day conflicts into 2-3 natural sentences — never list robotically, never bullet, never restate the layer's section headers. Make it feel like a pre-departure checklist assembled by someone who knows the trip. Subsequent layers (urgent renewals, near-window, etc.) become secondary unless they're tied to the trip; mention at most one non-trip item after the travel paragraph, only if it genuinely needs surfacing. In travel mode the brief may run up to 7 sentences total — drop non-travel content first to stay within that. Lift the parenthesized day-count phrases verbatim — never compute your own.
- Lead with urgent if present
- A detected conflict should always appear in the brief if it is high severity
- Medium severity conflicts appear if there is space in the brief
- Never mention work meetings or schedules directly — say "the afternoon looks tight" not "you have meetings"
- Always suggest a specific resolution when mentioning a conflict
- If conflicts exist, lead with the most severe one. Be specific about what the conflict is and what action would resolve it. Never be alarmist — calm and actionable.
- Health context: STRICTLY DEFICIT-ONLY. The brief mentions health ONLY when there is a concrete deficit: sleep.duration under 6 hours OR hrv.current meaningfully below hrv.baseline7d (roughly 15% or more lower). In those cases surface ONE calm, day-shaping sentence (e.g. "${userName} slept under six hours last night — worth keeping the day manageable" or "Recovery looks low today — a lighter afternoon might serve you well"). Never quote specific numbers, percentages, or units — only contextual observations. If sleep and HRV look normal, GOOD, or STRONG — say nothing about health. Never describe a positive or normal health state. Specifically banned: "your body feels strong", "your body is strong right now", "feeling strong", "energy is good", "you're in a strong window", "good timing energy-wise", "strong recovery", "your recovery looks solid", and any other affirmative health framing. A normal/strong healthState in the synthesis layer means the body is fine — the brief stays silent on it. The only reason to mention health is to soften the day's demands; if there is nothing to soften, omit health entirely.
- WEATHER IN BRIEF — STRICT RULE: Weather only appears in the brief when it directly affects a specific named signal (outdoor service appointment, delivery requiring someone home, travel timing). Humidity, heat, and general weather conditions are NEVER mentioned in the brief as standalone observations or closing lines — those belong exclusively in The Pulse. Even when dehydration_risk is an active synthesis flag, the brief stays silent on weather unless a signal is directly affected. The Pulse handles weather context. The brief handles signals. Specifically banned in the brief regardless of context (these are Pulse-only phrasings): "drink water throughout", "drink water today", "drink more water", "stay hydrated", "hydrate today/early/often/throughout/regularly", "keep water close/nearby/handy", "the air is thick/heavy/sticky/soupy", "the air feels heavy/thick", "heavy air today", "humid today", "muggy today", "thick air", "sticky out". A hydration directive or air-quality observation in the brief is a rule break even if it follows a signal mention — those phrasings live in The Pulse only.
- Weather: use weather as context only when it changes what someone should do about a signal. (a) If WEATHER TODAY is rain/showers/thunderstorm AND any outdoor service appointment is scheduled today/tomorrow, mention timing may be affected. (b) If extreme heat (>90°F) AND an HVAC service is scheduled, mention this is good timing for the service. (c) If rain/storm AND any package delivery is arriving today, mention packages may need to be brought in promptly. (d) Otherwise — including all "normal" weather (clear, partly cloudy, mild temperatures) and any case where no signal would actually be affected — say absolutely nothing about weather. CRITICAL: do NOT mention weather as a closing flourish, do NOT use weather as an "everything's fine otherwise" transition, do NOT describe weather to round out a paragraph. Specifically banned closer-phrasings: "Clear skies today", "Clear skies ahead", "Otherwise quiet weather", "Nothing weather-related", "The weather's calm", "the day is clear and warm", "with the nice weather", "given the calm forecast", "weather looks fine". These all count as load-bearing-less weather mentions and are forbidden regardless of where they appear in the brief. A brief without any weather mention reads correctly when weather isn't load-bearing — the reader will not notice it's missing. Never lead with weather. Never quote the temperature or condition string verbatim — paraphrase ("the rain coming through this afternoon") rather than restate ("72°F, Rain"). When in doubt about whether weather is load-bearing, omit it.
- Childcare: mention only if it affects coordination today or tomorrow
- Crew (children and pets): Crew members surface in the brief only when something is happening today or tomorrow that requires the household to act or be present. Never mention routine pickups or recurring activities unless there is a conflict or timing consideration. A pet vet appointment today is as important as a child's activity.
- Co-parent coordination: when a CREW line for a child ends with " | co-parent: NAME", that means a non-household co-parent shares responsibility for that child. Mention coordination naturally ONLY when the event is a handoff-type item (pickup, drop-off, school event, activity) where logistics genuinely warrant a heads-up — e.g. "Mia's soccer game is Thursday at 4 — worth coordinating pickup with [name] if needed." Do NOT include the co-parent in every child mention; if the event doesn't need their involvement (a birthday card from school, a friendly classroom note), leave them out. Never expose the literal "co-parent:" annotation in the brief — it's routing metadata.
- Crew birthdays/anniversaries: any entry in the CREW BIRTHDAYS/ANNIVERSARIES layer within 14 days ALWAYS appears in the brief. On the day itself (0 days), lead with it unless a high-severity conflict outranks it; 3 days out or less, mention with gentle urgency; further out, a single quiet acknowledgment is enough. Lift the parenthesized phrase verbatim ("today", "tomorrow", "in N days") — never compute your own count. Frame anniversaries as a household milestone, not a directive.
- Home requirements: flag naturally if service window conflicts with likely schedule
- Carried forward: if CARRIED FORWARD FROM YESTERDAY is populated, weave in one understated sentence near the end (before the horizon line) — e.g. "Carrying forward from yesterday: the HVAC appointment is still unconfirmed." Never alarming, never repetitive of the main brief narrative. If multiple carry-forwards exist, name at most one or two; the rest are implied.
- LOCAL/SEASONAL EVENTS (use LOCAL AND SEASONAL AWARENESS list): pick at most one event to mention.
  - tier 1 (safety, e.g. Hurricane Season Opens, Wildfire Season): ALWAYS mention regardless of signal load — one practical sentence ("Hurricane season opens June 1 — worth refreshing supplies this weekend").
  - tier 2 (major traffic / closures, e.g. Tortuga, marathons): mention only when the brief is otherwise quiet OR the event directly conflicts with a signal's location/timing.
  - tier 3 (awareness, e.g. Snowbird Season, Spring Break Peak): mention ONLY on a fully quiet day with no other signals to surface.
  - Frame as practical observation, not news ("Tortuga is this weekend — beach traffic will be heavy by Friday"). Never headline-voice. Never list multiple events. Speak like someone who lives in this market.
- CARRY-FORWARD ESCALATION: Any signal whose record carries briefCount >= 3 has been in this household's brief for at least three mornings without resolving. Acknowledge it differently — not as ambient context but as a decision point: "The [description] has been carrying forward for [briefCount] days — worth a quick decision: pursue it or remove it from the radar?" Never just repeat the same framing for a signal that's been in every brief for 3+ days. Pick at most one of these per brief; the rest stay implied. Use the parenthesized briefCount value verbatim — do not compute a different number.
- Still in motion: if STILL IN MOTION has an item, you MAY include one quiet "still moving" mention (e.g. "the renewal is still in motion, due Thursday"). Do NOT include if the same signal was already covered in URGENT or NEAR WINDOW prose this brief, and skip it entirely if doing so would push the brief past 5 sentences. A clean omission is fine — this layer is optional.
- Horizon signal: one sentence at the end, tonal shift to future-aware, specific and surprising
- Horizon awareness: if HORIZON AWARENESS is populated, surface it as one quiet sentence near the end (a "by the way..." not a lead). If both HORIZON SIGNAL and HORIZON AWARENESS are populated, prefer HORIZON AWARENESS — at most one horizon-style sentence per brief total.
- Network: NETWORK is silent by default. Mention a connected household ONLY if there is a meaningful change worth surfacing — an emergency_only connection showing hasEmergency=true, or a watchful/open connection in heavy signalLoad when prior briefs were clear. One sentence at most. Never daily, never as a routine layer. Never name the raw household ID — refer to "the connected household" or by relationship if it's been established elsewhere. If nothing is notable, OMIT the network entirely.
- Feedback tuning: the FEEDBACK HISTORY counts reflect how prior briefs landed. If thumbs-down significantly outnumbers thumbs-up for this brief type (takeoff or clearance, depending on which you're writing), be more concise and specific — trim discretionary sentences, lean harder into the most concrete signals. If thumbs-up is high or both counts are low, maintain current voice. Never reference the feedback in the brief output.
- If multiple layers are silent, the brief is shorter — that is correct and good
- A quiet brief is a gift — end with confidence not apology
- Never say "here is your brief" or use assistant language
- Never reference your own process, scanning, monitoring, or pipeline
- Never say you are looking for signals, watching for signals, or running sweeps
- Never use the words: alert, monitor, scan, detect, pipeline, sweep, system, tracking
- Simply say what you know. Never explain how you know it.
- When mentioning a signal more than 14 days out, end that sentence with EXACTLY ONE of these approved phrases — no variations, no additions, no suffixes:
   * "worth watching"
   * "Conductor has its eye on this"
   * "on the radar"
   * "watching for it"
   * "we'll flag it when it matters"
  Never modify these phrases. Never append "as it gets closer" or any other tail. Never use "we're watching" or any other subject substitution — always "Conductor" or one of the passive forms above. Never use the same phrase twice in one brief.
  Use these phrases verbatim only — never append additional words like "one", "too", "as well", or any other suffix. The phrase ends exactly as written.
- Plain text only, no markdown
- Do not begin with date or header
- Personalize to ${userName} — use "you" naturally
${isSingleMember
  ? `- This is a single-person household. Always use "you" and "your" throughout. Never refer to any other household member by name. All signals belong to you. The bracket tag will always be [YOURS] — never include the bracket tag in the brief.`
  : `- Ownership tags: every signal, deadline, and calendar event is prefixed with [YOURS], a household member's name in the form [NAME'S], or [HOUSEHOLD]. When the tag is [YOURS], speak in second person — "your spray tan tonight." When it's [SARAH'S] (or any other name), use that person's first name naturally — "Sarah has a spray tan tonight." When it's [HOUSEHOLD], use neutral household framing — "the vehicle registration renewal is due Wednesday." Flagged-categories signals carry an "owner" field with the same possible values; treat it identically. NEVER include the bracket tags or the literal word "owner" in the brief — they're routing metadata.`}
- When referring to a future date, lift the day-and-date verbatim from the friendly string already provided in the ETA field (e.g., "Sunday, May 10"). NEVER compute, infer, or recalculate a day-of-week or date — the resolved string is authoritative. Ignore the "raw:" portion. Drop the year unless it differs from the current year.
- If a signal's ETA is "Unknown" or missing, do NOT invent or guess a date for it — even if the description mentions a holiday or named event. Either omit the date or use a phrase like "no confirmed date yet". Do NOT translate "Mother's Day", "the weekend", or similar phrases into specific calendar dates yourself.
- Anticipated signals: signals with type "anticipated" OR anticipated:true represent a recurring sender that's overdue — they're inferred, not confirmed. Frame them as expected-but-unconfirmed: "Your usual [description] from [sender] is due — hasn't arrived yet." Never frame as definite ("the renewal is here"); never invent timing for them beyond what the expectedByDate field carries.
- LOCAL SAFETY (Nextdoor): signals with type "local_safety" come from the household's Nextdoor neighborhood feed (sender: "Nextdoor"). These are tier-1 — surface them regardless of signal load, and lead with them when present today. Frame as neighborhood awareness, not panic: "A break-in was reported on the next block — worth locking the side gate before bed." Never invent details beyond what the description carries; if the description is sparse, keep the mention short and add "from a Nextdoor post" so the user can verify in-app.
- Threaded signals: when multiple signals share the same threadId, narrate them as ONE item rather than separately. Use the thread summary as the subject and weave the individual pieces into the same sentence. Example: instead of "Your hotel reservation is confirmed. Your dinner reservation is set. Your airport transfer is booked." write "Your Paris trip has three things moving — hotel, dinner, and airport transfer all look set." Treat the thread as the single referent for purposes of the uniqueness rule (one mention, one sentence, one closer).
- CRITICAL — NO INVENTED DATE RANGES OR WINDOWS: When a signal has no specific ETA, do NOT fabricate a date range or vague window in place of the missing date. Specifically banned: "sometime between {X} and {Y}", "expected sometime in {month/season}", "by the end of {the year/month/quarter}", "around the {end/middle/start} of {month/year}", "in the next {month/quarter/season} or so", "anywhere from {X} to {Y}", "{date} through {date}" when neither bound came from the authoritative ETA. A signal with no ETA stays dateless — acceptable phrasings: "no confirmed date yet", "still in motion", "details still coming through", "Conductor is watching for it". Fabricated windows are NEVER acceptable, even when they feel like a reasonable guess (e.g. a "Chime Card on its way" signal does NOT get "expected sometime between mid-December and the end of the year" — it stays dateless).
- CRITICAL RULE — INTER-SIGNAL GAP PHRASES: When two future-dated items appear in the same brief, do NOT characterize the gap between them with a relative-duration phrase. ANY number — digit ("11", "5", "8") OR spelled out ("eleven", "five", "eight", "twelve", "fifteen", "twenty", "thirty", any English number word) OR quantifier ("a", "a few", "several", "a couple of", "about two", "roughly three") — combined with ANY time unit ("day", "days", "week", "weeks", "month", "months", "year", "years") and ANY linking preposition or adverb ("later", "after", "before", "ahead", "out", "away", "from now", "earlier", "down the line", "down the road", "afterward", "subsequently", "thereafter") forms a FORBIDDEN gap phrase. Concrete forbidden examples (all banned): "eleven days later", "11 days later", "five days after", "5 days after", "a week later", "two weeks later", "twelve days afterward", "eight days out", "three weeks ahead", "a couple of days after". The dates themselves convey the timing — May 20 and May 28 already tell the reader the gap. Permitted sequential framings: "the following Thursday", "and another", "then", "on the {weekday}, {date}", or just two complete sentences with both dates. If you wrote a sentence containing any "<number-or-quantifier> <time-unit> <linking-word>" pattern referring to the spacing between two signals, DELETE that phrase and let the dates stand alone.
- The ETA friendly field includes an authoritative parenthesized phrase like "(in 6 days)", "(in 2 weeks)", "(today)", or "(tomorrow)". The server picks the unit — it emits a weeks-form ONLY when the gap is an exact multiple of 7 days; otherwise it emits days. If you want to convey how soon something is, lift that phrase VERBATIM as a contiguous substring of your sentence — character-for-character, including the leading word ("in"). Examples of CORRECT lifts: "renewing in 5 days", "her birthday is in 1 week", "due today". Examples of INCORRECT lifts even though they preserve the timing: "gives you a week to think" (dropped "in", changed "1" → "a"), "5 days from today" (added "from today"), "a week away" (paraphrased "in 1 week"). The exact authoritative tokens must appear; embedding into a longer prose phrase is fine as long as the lifted substring is intact. Never substitute one unit for another: do NOT convert "(in 14 days)" to "in 2 weeks", do NOT convert "(in 5 days)" to "a few days", do NOT round "(in 13 days)" to "in 2 weeks". The ONLY two acceptable timing forms in the brief are: (1) the lifted parenthesized phrase verbatim, and (2) the day-and-date ("Wednesday, May 20"). Any other quantified duration is forbidden — this is a PATTERN rule, not a list-of-examples rule. The forbidden pattern is "<number-or-quantifier> <time-unit> <preposition>" where number-or-quantifier is anything like "5", "five", "a", "a couple of", "several", "a few", "about two", time-unit is days/weeks/months/years (singular OR plural), and preposition is away/out/left/remaining/from now/to <verb>/until <date>/later/before. Non-exhaustive examples that are ALL forbidden: "five days away", "5 days out", "five days left", "five days to renew", "two weeks later", "two weeks out", "two weeks away", "two weeks left", "a week out", "a couple of weeks away", "in about three weeks", "a few days from now", "next week", "soon", "shortly". If you find yourself constructing any duration phrase that isn't the lifted parenthesized phrase, stop and use the date alone instead — the day-and-date is always sufficient on its own. When using a lifted "(in N days)" phrase, NEVER place it after the word "until", "before", or "by" — the construction "until in N days", "before in N days", "by in N days" is ungrammatical and always reads as broken English. Examples of FORBIDDEN glue: "doesn't come due until in 11 days", "isn't needed before in 5 days", "wraps up by in 3 days". Instead either (1) use the date only — "doesn't come due until Thursday, May 28" — or (2) restructure so the lifted phrase starts the timing clause — "comes due in 11 days, on Thursday, May 28". The lifted phrase belongs at the start of a timing reference, not glued after a preposition. Also forbidden: window phrases like "in the next N days/weeks", "over the next N days", "within the next N days", "the next N days", "in the coming N days". N here means ANY quantity slot — digit ("3", "11"), spelled-out number ("three", "eleven"), OR quantifier ("few", "several", "couple", "handful", "couple of", "a few", "a couple of"). Every variant is forbidden: "in the next three days", "in the next 3 days", "in the next few days", "in the next several days", "over the coming couple of days", "within the next handful of days" — all banned. These are paraphrased windows, not lifted authoritative phrases. Use specific dates only, or lift the exact parenthesized phrase provided. Example: instead of "Two subscriptions need attention in the next three days" or "Two subscriptions need attention in the next few days" write "Two subscriptions are due this week — Health Tech Nerds on Wednesday and Google Home on the 28th."
- The parenthesized phrase also surfaces past dates as "(yesterday)" or "(already passed N days ago)". Treat these signals as already-happened, NOT upcoming. Never write "looking ahead to..." or "her trip is set for..." or "watch for it as the date approaches" about a past-dated item — those framings are reserved for genuinely future dates. A past-dated signal usually means it's still open or unresolved (e.g., a delivery that never arrived, an appointment that wasn't marked done); if it warrants mention, frame it as a stale-or-outstanding item ("the spray tan from last Thursday hasn't been confirmed resolved", or simply omit). If a past-dated item has no actionable open thread, omit it entirely — do not pad the brief with retrospective recaps.`;

    // Life-transition tone rule — appended to the rules block when
    // activeTransition is present. Each type gets a tailored softener;
    // divorce additionally trips the isSingleMember flag earlier in
    // the pipeline so multi-member narration mechanics quiet down.
    // Behavioral patterns — used to shape the brief's voice based
    // on how the household actually operates over time. The prompt
    // section is non-quoted (the model is instructed to NEVER name
    // these explicitly), and the language gates by householdAge so
    // early days carry less assertive personality framing.
    const memoryEntries = (rawMemoryEntries || [])
      .map((r) => { try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } })
      .filter(Boolean);
    const behavior = analyzeBehaviorPatterns(memoryEntries);

    let composedRules = baseRules;
    if (behavior.totalSignalsHandled > 0) {
      const personalityHint = behavior.personalityType === "proactive"
        ? "This household acts fast — trust them to handle things. The brief can be slightly more forward-looking; you don't need to spell out timing or consequences in detail."
        : behavior.personalityType === "reactive"
        ? "This household tends to let things sit. The brief can be slightly more explicit about timing and consequences — not alarming, just concrete."
        : "This household is steady. Neutral voice — they're consistent.";

      // Tier the language gates by household age so early voice is
      // tentative, then earns the right to reference patterns.
      const ageGate = behavior.householdAge >= 90
        ? "You have genuine knowledge of this household now. Use it sparingly but meaningfully when it actually serves a sentence — e.g. 'Your Amazon deliveries usually clear quickly, so this one sitting three days is worth a glance.' Never overuse."
        : behavior.householdAge >= 30
        ? "You can reference patterns naturally when relevant — e.g. 'this one's been sitting longer than usual'. Only when the observation actually adds value, not as filler."
        : "Voice should be calibrated to the personality cue but never reference patterns explicitly yet. Too early.";

      const patternsRule = `- HOUSEHOLD PATTERNS (voice cues only, never mention explicitly, never use phrases like "based on your patterns" or "I've noticed"): ${
        behavior.totalSignalsHandled
      } signals handled over ${behavior.householdAge} days. ${
        behavior.fastResolvers.length > 0
          ? `Tends to clear ${behavior.fastResolvers.join(", ")} quickly. `
          : ""
      }${
        behavior.slowResolvers.length > 0
          ? `Lets ${behavior.slowResolvers.join(", ")} sit longer. `
          : ""
      }${behavior.peakDay ? `Most active on ${behavior.peakDay}. ` : ""}Personality: ${behavior.personalityType}. ${personalityHint} ${ageGate}`;
      composedRules = `${composedRules}\n${patternsRule}`;
    }

    if (activeTransition && activeTransition.type) {
      const t = activeTransition.type;
      const TRANSITION_RULES = {
        new_baby:
          "- ACTIVE TRANSITION — NEW BABY: This household just welcomed a baby. Soften tone for 30 days. Be warmer, less urgent. Lead with what matters today, not the full pile. Never use the word 'deadline' on baby-related items — frame as 'when you're ready'. Sleep-deficit framing in the Pulse is fine; do not moralize about it.",
        new_home:
          "- ACTIVE TRANSITION — NEW HOME: This household just moved. Tone is practical-supportive. Expect to surface move-in vault items (mail forward, license, panel) ahead of older signals when timing demands. Acknowledge the move-in chaos when it fits naturally — never lecture.",
        divorce:
          "- ACTIVE TRANSITION — SEPARATION: Treat the household as a single member for the next 90 days regardless of membership. Never mention the other member by name or relationship. Suppress any signal owned by the other member (skip it silently — no narration). Tone is steady and respectful; never warm-and-fuzzy, never breezy, never hollow-cheerful. The brief is briefer during this window — only what actually needs attention.",
        health_diagnosis:
          "- ACTIVE TRANSITION — HEALTH DIAGNOSIS: This household received a medical diagnosis. For 60 days, weight health context more heavily and frame everything with extra gentleness. The Pulse may surface body state more often when recovery is low — always supportive, never alarmed. Lead with care-related signals when they're current; keep non-medical items quieter.",
        job_change:
          "- ACTIVE TRANSITION — JOB CHANGE: This household is transitioning employment. For 90 days, give extra weight to benefits / insurance / financial signals from the seeded vault items. Acknowledge change naturally if it fits, never as a directive.",
        loss:
          "- ACTIVE TRANSITION — LOSS: This household is in bereavement. For 60 days, tone is extra gentle. Never mention deadlines without warm framing — replace any directive language ('renew', 'submit', 'deadline') with softer equivalents ('when you're ready', 'when it feels right', 'whenever you can'). A quiet brief is correct. Never breezy.",
      };
      const rule = TRANSITION_RULES[t];
      if (rule) composedRules = `${baseRules}\n${rule}`;
    }

    // Household profile voice adjustments. Profile is set during
    // onboarding (POST /api/signals?type=profile). New schema:
    //   { who, housing, modifiers[] }
    // Legacy schema (older households):
    //   { type, ownOrRent }
    // We prefer the new fields and fall back to legacy so existing
    // briefs don't lose their voice on the day this ships.
    try {
      const rawProfile = await redis.get(`household:${householdId}:profile`);
      const profile = rawProfile
        ? (typeof rawProfile === "string" ? JSON.parse(rawProfile) : rawProfile)
        : null;
      if (profile) {
        const block = buildHouseholdProfileRule(profile);
        if (block) {
          composedRules = `${composedRules}\n${block}`;
        }
      }
    } catch (err) {
      console.warn("[brief] profile rule load failed:", err?.message);
    }

    // User-tunable voice preferences — tone (direct/balanced/warm),
    // humor (yes/occasionally/no), and detail (brief/standard/thorough).
    // Each modifies the assistant's voice independently, so we layer
    // three rule fragments and append them once.
    try {
      const tone = preferences?.communicationTone;
      const humor = preferences?.communicationHumor;
      const detail = preferences?.communicationDetail;
      const styleRule = buildStyleRule(tone, humor, detail);
      if (styleRule) {
        composedRules = `${composedRules}\n${styleRule}`;
      }
    } catch (err) {
      console.warn("[brief] style rule build failed:", err?.message);
    }

    // Signal freshness rule — each signal carries an optional
    // " | freshness: NEAR/STALE/ANCIENT" suffix indicating days since
    // last update. Use it to calibrate framing without ever quoting
    // the tag itself.
    composedRules = `${composedRules}\n- SIGNAL FRESHNESS: Each signal line may end with "| freshness: NEAR" (3-6d), "STALE" (7-13d), or "ANCIENT" (14d+). For STALE signals, briefly acknowledge the staleness if you surface them — e.g. "the garage door estimate has been quiet for over a week." ANCIENT signals belong in The Read, not the brief — only surface them if they are urgently approaching a deadline. Fresh signals (no tag, or NEAR) get normal treatment. Never quote the literal "freshness:" annotation — it's routing metadata.`;

    // Household priorities — what the user told us matters most during
    // onboarding (Step 3). Stored at household:{id}:priorities as
    // either an array or a { values: [...] } object. The prompt
    // appendage tells Claude how to order competing lead candidates.
    try {
      const rawPriorities = await redis.get(`household:${householdId}:priorities`);
      const parsed = rawPriorities
        ? (typeof rawPriorities === "string" ? JSON.parse(rawPriorities) : rawPriorities)
        : null;
      const priorities = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.values)
        ? parsed.values
        : [];
      if (priorities.length > 0) {
        const priorityLabels = {
          deadlines: "Vault deadlines and renewals",
          kids_schedules: "Children's schedules and crew events",
          kids: "Children's schedules and crew events",
          home_maintenance: "Home maintenance and service signals",
          home: "Home maintenance and service signals",
          financial: "Financial anomalies and subscription changes",
          health: "Health synthesis and Oura readiness",
          travel: "Travel signals and trip preparation",
          service_providers: "Service appointments and contractor signals",
          providers: "Service appointments and contractor signals",
          deliveries: "Package deliveries and order tracking",
          essentials: "Only genuinely urgent items — be conservative",
        };
        const labels = priorities
          .map((p) => priorityLabels[p] || p)
          .filter(Boolean);
        const conservativeNote = priorities.includes("essentials")
          ? "\nIf 'essentials' is selected: apply conservative filtering — only surface signals with genuine urgency or deadlines within 14 days."
          : "";
        const priorityRule = `- HOUSEHOLD PRIORITIES — lead with these signal types: ${labels.join(" → ")}. When multiple signals compete for brief lead, highest priority type wins.${conservativeNote}`;
        composedRules = `${composedRules}\n${priorityRule}`;
      }
    } catch (err) {
      console.warn("[brief] priorities rule failed:", err?.message);
    }

    // Household hobbies — joie-de-vivre layer. Stored at
    // household:{id}:hobbies (POST /api/signals?type=hobbies). On quiet
    // days we want the brief to surface invitations, not obligations,
    // and the prompt addendum below tells Claude how to frame them.
    // We also opportunistically enrich with surf conditions when 'water'
    // is selected and the household has coords — Claude can choose to
    // lift the conditions as an invitation when load is light/clear.
    try {
      const rawHobbies = await redis.get(`household:${householdId}:hobbies`);
      const hobbiesParsed = rawHobbies
        ? (typeof rawHobbies === "string" ? JSON.parse(rawHobbies) : rawHobbies)
        : null;
      const hobbies = Array.isArray(hobbiesParsed?.values) ? hobbiesParsed.values : [];
      if (hobbies.length > 0) {
        const HOBBY_LABELS = {
          water: "water", music: "music", food: "food & dining", golf: "golf",
          fitness: "fitness", art: "art", travel: "travel", sports: "sports",
          outdoors: "outdoors", film: "film", wine: "wine & spirits",
          cycling: "cycling", books: "books", gaming: "gaming", wellness: "wellness",
        };
        const labelled = hobbies.map((h) => HOBBY_LABELS[h] || h);

        // Best-effort surf conditions when 'water' is chosen and we have
        // coords. Wrapped tightly so a NOAA hiccup never blocks the brief.
        let surfNote = "";
        try {
          if (hobbies.includes("water") && householdLocation?.lat && householdLocation?.lon) {
            const { getSurfConditions } = await import("./hobbies.js");
            const surf = await getSurfConditions(
              householdLocation.lat,
              householdLocation.lon,
              hobbies
            );
            if (surf && surf.conditions) {
              const whTxt = typeof surf.waveHeight === "number"
                ? `${surf.waveHeight.toFixed(1)}ft seas`
                : "";
              const windTxt = surf.windDirection && surf.windSpeed
                ? `, wind ${surf.windDirection} ${Math.round(surf.windSpeed)}mph`
                : "";
              surfNote = `\nCURRENT MARINE: ${surf.conditions.toUpperCase()} (${whTxt}${windTxt}). Lift this only as an invitation on light/clear days.`;
            }
          }
        } catch (err) {
          console.warn("[brief] surf enrichment failed:", err?.message);
        }

        const hobbyRule = [
          `- HOUSEHOLD HOBBIES AND INTERESTS: ${labelled.join(", ")}.`,
          `  On quiet days (signalLoad is 'light' or 'clear'): surface one relevant opportunity from local events or conditions. Frame as an invitation, not an obligation. "The surf is up at Sebastian Inlet this weekend." not "You should go surfing." "Khruangbin tickets go on sale Friday." not "Buy tickets."`,
          `  On normal days: hobby signals may appear below brief obligations if space allows. Never let hobby signals crowd out urgent household signals.`,
          `  Hobby signals get a different visual treatment — not a chip, a quiet observation. The brief closes with the opportunity rather than opening with it.${surfNote}`,
        ].join("\n");
        composedRules = `${composedRules}\n${hobbyRule}`;
      }
    } catch (err) {
      console.warn("[brief] hobbies rule failed:", err?.message);
    }

    // Seasonal personality — one-line context appended to the
    // prompt rules. Falls through silently for markets we don't
    // have a map for; other regions can be added without touching
    // the brief assembly logic. The rule tells the model to lift
    // this naturally only when it actually shapes a signal.
    try {
      const SEASONAL_CONTEXT = {
        south_florida: {
          1:  "January in Fort Lauderdale. Snowbird season peak. Traffic is 40% heavier.",
          2:  "February. Still peak season. The weather is perfect and everyone knows it.",
          3:  "March. Spring break approaches. Beach traffic building.",
          4:  "April. Last of the good weather before summer arrives.",
          5:  "May. Summer is coming. The humidity is beginning to have opinions.",
          6:  "June 1st is hurricane season. The Conductor is paying attention to the Atlantic.",
          7:  "July. Full South Florida summer. The humidity is not subtle.",
          8:  "August. Storm season peak. The Conductor is watching the tropics.",
          9:  "September. Still hurricane season. Still watching.",
          10: "October. Boat Show month. Downtown Fort Lauderdale becomes complicated.",
          11: "November. Season begins. The snowbirds return. Traffic resumes.",
          12: "December in Fort Lauderdale. The year is ending. Christmas approaching. The Conductor notes the warmth of the season — in temperature and spirit. Brief tone: warm, slightly reflective, celebratory when earned. The household has made it through another year. That matters.",
        },
      };
      const region = householdLocation?.marketRegion || "south_florida";
      const month = new Date().getMonth() + 1;
      const seasonal = SEASONAL_CONTEXT[region]?.[month];
      if (seasonal) {
        composedRules = `${composedRules}\n- SEASONAL AWARENESS: ${seasonal} Reference this naturally only when the season genuinely affects something in the brief. Never force it.`;
      }
    } catch (err) {
      console.warn("[brief] seasonal rule failed:", err?.message || err);
    }

    // Quiet day detection — when there's genuinely nothing in motion,
    // we deserve a different brief shape rather than fabricating prose
    // around emptiness. Conditions:
    //   - No active signals
    //   - No vault deadlines within 14 days
    //   - No crew events today/tomorrow
    const FOURTEEN_DAYS_MS = 14 * 24 * HOUR_MS;
    const nowMs = Date.now();
    const upcomingVaultIn14 = (allDeadlines || []).filter((d) => {
      const ms = d?.renewalDate ? Date.parse(d.renewalDate) : NaN;
      return !isNaN(ms) && ms >= nowMs && ms - nowMs <= FOURTEEN_DAYS_MS;
    }).length;
    const quietDay =
      activeSignals.length === 0 &&
      upcomingVaultIn14 === 0 &&
      crewToday.length === 0;

    // First-run is handled by an early-return branch above; this path is
    // always the steady-state pipeline.
    const userPrompt = quietDay
      ? `${layeredContext}\n\nQUIET DAY PROMPT:
This household has a genuinely quiet day — nothing urgent, nothing approaching, nothing needing attention.

Write a brief that acknowledges this warmly. 2-3 sentences maximum.
Options:
- Acknowledge the quiet as a gift: "Nothing pressing today. The household is clear."
- Use it as an opportunity: "Clear day ahead — good morning to handle something you've been putting off, or simply enjoy the space."
- Reference the weather or season naturally: "Clear day in ${householdLocation?.city || "your city"}. Nothing in motion. Take it."
- Occasional wit: "Conductor has been watching. Nothing to report. Enjoy it — this is rare."

Never manufacture urgency. Never apologize for having nothing to say. The quiet brief is one of Conductor's best moments — use it well.`
      : `${layeredContext}\n\n${composedRules}`;

    // Language preference. Default English; Spanish/Portuguese/
    // French households add a directive so the brief is generated
    // natively rather than translated.
    const userLang = preferences?.language || "en";
    const languageDirective =
      userLang === "es" ? "\n\nIMPORTANT: Generate this entire brief in natural, conversational Spanish — not translated English. The voice should feel native to a Spanish-speaking household."
      : userLang === "pt" ? "\n\nIMPORTANT: Generate this entire brief in natural, conversational Portuguese."
      : userLang === "fr" ? "\n\nIMPORTANT: Generate this entire brief in natural, conversational French."
      : "";
    const systemPrompt = `You are Conductor, a household intelligence layer. You write calm, trusted, personal morning briefs for ${userName}. Your voice is like a thought the reader was already having — never assistant-like, never listy, always prose.${languageDirective}`;

    // Generate-then-sweep loop. Prompt rules are a soft constraint; the
    // model honors them most of the time but occasionally slips on
    // window/gap phrasings, banned closers, or positive-health framings.
    // After each generation, run a deterministic regex sweep against the
    // known offender patterns. On violation, retry once with the offending
    // phrases enumerated in the prompt. After MAX_ATTEMPTS, accept the
    // last result regardless — a 5% degraded brief is still better than a
    // 500 to the user, and the [brief] sweep logs surface the residual
    // for offline tuning.
    const MAX_ATTEMPTS = 2;
    let brief = "";
    let attempts = 0;
    let lastViolations = [];
    while (attempts < MAX_ATTEMPTS) {
      attempts++;
      const promptToUse = lastViolations.length > 0
        ? userPrompt + buildRetryAddendum(lastViolations)
        : userPrompt;

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 500,
          system: systemPrompt,
          messages: [{ role: "user", content: promptToUse }],
        }),
      });

      const data = await response.json();
      if (!response.ok || !data?.content?.[0]?.text) {
        console.error("[brief] Anthropic main-call non-content response", {
          status: response.status,
          type: data?.type,
          errorType: data?.error?.type,
          errorMessage: data?.error?.message,
          stopReason: data?.stop_reason,
          rawHead: JSON.stringify(data).slice(0, 400),
        });
        // Auth / billing / model errors aren't fixable by retry — break.
        brief = data?.content?.[0]?.text || "";
        break;
      }

      brief = data.content[0].text;
      const violations = sweepBriefForViolations(brief);
      if (violations.length === 0) {
        if (attempts > 1) {
          console.log(`[brief] sweep clean on retry attempt ${attempts}`);
        }
        lastViolations = [];
        break;
      }
      console.log(
        `[brief] sweep violations on attempt ${attempts}:`,
        violations.map((v) => `${v.rule}=${v.matches.length}`).join(" ")
      );
      lastViolations = violations;
    }
    if (lastViolations.length > 0) {
      console.log(
        `[brief] shipping after ${attempts} attempts with residual violations:`,
        lastViolations.map((v) => `${v.rule}[${v.matches.join("|")}]`).join(" ; ")
      );
    }

    // Brief quality score — surfaced via /api/admin/quality. Pure
    // post-hoc; never affects the response. Captures signals about
    // brief generation health: prompt-rule violations, retries, length
    // sanity, and Pulse presence.
    try {
      const wordCount = (brief || "").trim().split(/\s+/).filter(Boolean).length;
      let score = 100;
      score -= (lastViolations?.length || 0) * 10;
      if (!synthesisState?.synthesisNote) score -= 5;
      if (wordCount < 30) score -= 10;
      if (wordCount > 200) score -= 10;
      if (attempts > 1) score -= 5 * (attempts - 1);
      score = Math.max(0, Math.min(100, score));
      const qualityRecord = {
        score,
        wordCount,
        attempts,
        violationCount: lastViolations?.length || 0,
        hasPulse: !!synthesisState?.synthesisNote,
        householdId,
        timestamp: new Date().toISOString(),
      };
      await Promise.all([
        redis.lpush(`household:${householdId}:briefQuality`, JSON.stringify(qualityRecord)),
        redis.ltrim(`household:${householdId}:briefQuality`, 0, 29),
        redis.lpush("global:briefQuality", JSON.stringify(qualityRecord)),
        redis.ltrim("global:briefQuality", 0, 199),
      ]);
    } catch (err) {
      console.warn("[brief] quality scoring failed:", err?.message);
    }

    // Stash the most-recent generated brief at a stable key with a 48h TTL
    // so the Yesterday's Programme modal can always recover it. Naming is
    // product copy ("yesterday") rather than literal — the key holds the
    // most recent run and gets overwritten on each subsequent generation.
    if (brief) {
      await redis.set(`household:${householdId}:yesterdayTakeoff`, brief, { ex: 48 * 60 * 60 });
    }

    // Tag clickable signal phrases — pass everything that could plausibly appear.
    const tagPool = [...urgentForPrompt, ...nearForPrompt, ...homeRequirements, ...carriedForwardSignals];
    // Horizon items are vault deadlines — augment with type:"deadline"
    // so the segmenter's idToType map records the canonical signalType
    // (vault raw category is "subscription"/"insurance"/etc. which
    // isn't in the allowed enum and would let the segmenter drift to
    // "unknown" even with the post-parse coercion in place).
    if (horizonSignal) tagPool.push({ ...horizonSignal, _isDeadline: true, type: "deadline" });
    if (horizonAwarenessSignal) tagPool.push({ ...horizonAwarenessSignal, _isDeadline: true, type: "deadline" });

    // Also feed the segmenter the full unhandled vault, not just items
    // that fell into the urgent/near time windows. The brief can mention
    // a longer-horizon vault item via The Read or a horizon line, and
    // we want those phrases to tag back to their vault id too. Pre-
    // existing tagPool ids take precedence — these are deduped below.
    const fullVaultForTagging = (rawDeadlines || [])
      .map(safeJson)
      .filter(Boolean)
      .filter((v) => !v.handled)
      .map((v) => ({
        ...v,
        eta: v.renewalDate || v.eta,
        _isDeadline: true,
        type: "deadline",
      }));
    tagPool.push(...fullVaultForTagging);

    // dedupe by id
    const seen = new Set();
    const tagSignals = tagPool.filter((s) => {
      const key = String(s.id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // Run segment tagging, transparency, and The Read generation in
    // parallel — all three depend only on the brief text and existing
    // pools, so there's no ordering constraint between them. Saves
    // ~two Claude round-trips of latency vs sequential.
    const poolsForClaude = {
      urgent: urgentForPrompt,
      near: nearForPrompt,
      healthContext,
      weather: weather ? weather.summary : null,
      childcare: childcareEvents,
      homeRequirements,
      horizon: horizonAwarenessSignal || horizonSignal,
      carriedForward: carriedForwardSignals,
      // Signals that were muted from the main brief because they were
      // already narrated and unchanged. The Read picks these up so they
      // get acknowledged in background-awareness prose rather than going
      // completely silent.
      backgroundRest,
    };
    // allDeadlines holds vault items shaped like signals (consequence,
    // eta, etc.). Filter to the 60-day window for the question prompt.
    const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
    const vaultUpcoming = (allDeadlines || []).filter((v) => {
      const ms = v.eta ? Date.parse(v.eta) : NaN;
      return !isNaN(ms) && ms - Date.now() < SIXTY_DAYS_MS && ms > Date.now() - 24 * 60 * 60 * 1000;
    });
    // Patterns + crew upcoming feed the proactive-question prompt.
    // Both are best-effort reads; failures fall through to empty.
    const patternsForQ = await redis
      .lrange(`household:${householdId}:patterns`, 0, -1)
      .then((arr) => (arr || []).map((r) => { try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } }).filter(Boolean))
      .catch(() => []);
    const crewForQ = upcomingCelebrations || [];

    const [segments, transparency, theRead, conductorQuestion] = await Promise.all([
      tagBriefSegments(brief, tagSignals),
      generateTransparency(brief, poolsForClaude),
      generateTheRead(brief, poolsForClaude),
      generateConductorQuestion({
        activeSignals,
        vaultUpcoming,
        patterns: patternsForQ,
        crewUpcoming: crewForQ,
      }),
    ]);

    // Track which signals Claude actually narrated this run so the next brief
    // knows what to mute. Lookup uses the union of pools we considered, since
    // a signal can land in segments from any of them.
    const signalLookup = new Map();
    for (const s of [...activeSignals, ...allDeadlines]) {
      signalLookup.set(String(s.id), s);
    }
    if (horizonSignal) signalLookup.set(String(horizonSignal.id), horizonSignal);
    if (horizonAwarenessSignal) {
      signalLookup.set(String(horizonAwarenessSignal.id), horizonAwarenessSignal);
    }

    const briefedTodayKey = `household:${householdId}:briefedToday`;
    const briefedTodayFields = {};
    const briefedSignalIds = new Set();
    for (const seg of segments || []) {
      if (!seg || seg.type !== "signal" || seg.signalId == null) continue;
      const id = String(seg.signalId);
      const sig = signalLookup.get(id);
      if (!sig) continue;
      briefedTodayFields[id] = JSON.stringify({
        status: sig.status || "",
        state: sig.state || "",
        ring: computeRing(sig),
      });
      briefedSignalIds.add(id);
    }

    // briefCount — increment for each signal that was actually narrated
    // in this brief AND is still unresolved. Becomes the substrate for
    // the carry-forward escalation prompt rule (briefCount >= 3 gets
    // softer "make a decision" framing) and the mobile Finale amber
    // "Carried forward N days" badge. Read-modify-write per signal so
    // a fresh fetch of :signals reflects the bump immediately.
    if (briefedSignalIds.size > 0) {
      const signalsListKey = `household:${householdId}:signals`;
      try {
        const rawList = await redis.lrange(signalsListKey, 0, -1);
        for (let i = 0; i < rawList.length; i++) {
          let parsed;
          try { parsed = typeof rawList[i] === "string" ? JSON.parse(rawList[i]) : rawList[i]; }
          catch { continue; }
          if (!parsed || !parsed.id) continue;
          if (!briefedSignalIds.has(String(parsed.id))) continue;
          // Skip resolved/expired — incrementing a resolved signal's
          // count would mislead the FinaleSheet badge after a Rest tap.
          if (parsed.state === "resolved" || parsed.state === "expired") continue;
          const next = {
            ...parsed,
            briefCount: (typeof parsed.briefCount === "number" ? parsed.briefCount : 0) + 1,
            lastBriefedAt: new Date().toISOString(),
          };
          await redis.lset(signalsListKey, i, JSON.stringify(next));
        }
      } catch (err) {
        console.warn("[brief] briefCount bump failed:", err?.message || err);
      }
    }
    if (Object.keys(briefedTodayFields).length > 0) {
      await redis.hset(briefedTodayKey, briefedTodayFields);
      // Refresh TTL so a signal that keeps appearing stays muted; once it
      // stops appearing the entire hash drops in 20 hours.
      await redis.expire(briefedTodayKey, 20 * 60 * 60);

      // morningBriefed mirrors the same shape but with a 26h TTL so it
      // survives until tomorrow morning and clearance can read it tonight to
      // build the LAST CHANCE pool. Distinct from briefedToday, which
      // clearance also writes into and which has shorter TTL purely for
      // narration-mute purposes.
      const morningBriefedKey = `household:${householdId}:morningBriefed`;
      await redis.hset(morningBriefedKey, briefedTodayFields);
      await redis.expire(morningBriefedKey, 26 * 60 * 60);
    }

    // Acknowledge the horizon-awareness pick for the week. We mark it whether
    // or not Claude explicitly inlined it — the prompt budget is already spent
    // and re-offering the same signal next morning would feel repetitive.
    if (horizonAwarenessSignal) {
      const briefedThisWeekKey = `household:${householdId}:briefedThisWeek`;
      await redis.sadd(briefedThisWeekKey, String(horizonAwarenessSignal.id));
      await redis.expire(briefedThisWeekKey, 6 * 24 * 60 * 60);
    }

    // Structured payload backing the expanded Pulse card on Ground. Raw
    // fields only — mobile decides formatting, color thresholds, and which
    // sections to render based on null-vs-present checks. Each leaf is the
    // value from the underlying source (healthContext / weather snapshot)
    // or null when that source is unavailable.
    const pulseData = {
      health: healthContext ? {
        sleep: healthContext.sleep?.duration ?? null,
        hrv: {
          current: healthContext.hrv?.current ?? null,
          baseline7d: healthContext.hrv?.baseline7d ?? null,
        },
        restingHR: healthContext.restingHR ?? null,
        steps: healthContext.steps ?? null,
        activeCalories: healthContext.activeCalories ?? null,
        // Oura subset passed through verbatim — mobile decides which
        // metrics to surface in the expanded card.
        oura: healthContext.oura ? {
          readinessScore: healthContext.oura.readiness?.score ?? null,
          deepSleepSeconds: healthContext.oura.sleep?.deep_sleep_duration ?? null,
          temperatureContrib: healthContext.oura.readiness?.contributors?.body_temperature ?? null,
        } : null,
      } : null,
      weather: weather ? {
        tempF: weather.tempF ?? null,
        heatIndex: synthesisState.heatIndex,
        humidity: weather.humidity ?? null,
        conditions: conditionsLabel(weather),
        // Today's timeline — populated from the new Open-Meteo
        // hourly/daily fetch. All four may be null if the location
        // is at extreme latitude (no sunset in summer / no rain).
        rainWindow: weather.rainWindow ?? null,
        uvPeak: weather.uvPeak ?? null,
        temperaturePeak: weather.temperaturePeak ?? null,
        sunrise: weather.sunrise ?? null,
        sunset: weather.sunset ?? null,
      } : null,
      signalLoad: synthesisState.signalLoad,
      urgentCount: synthesisState.urgentCount,
      synthesisFlags: synthesisState.synthesisFlags,
    };

    // Anniversary closer — append exactly once per anniversary year.
    // The 48h TTL key guards against duplicate appends if the user
    // refreshes the brief multiple times during the day.
    // Maintenance plan offer — only true when (a) inventory is
    // sufficient + no fresh plan exists + user hasn't dismissed
    // AND (b) we haven't shown the offer in the last 7 days. The
    // 7-day cooldown is enforced via a per-household TTL key so
    // the offer doesn't appear daily and become noise.
    let maintenancePlanOffer = false;
    try {
      const ready = await isMaintenanceOfferReady(householdId);
      if (ready) {
        const lastOfferedRaw = await redis.get(`household:${householdId}:maintenanceOfferShownAt`);
        const sevenDays = 7 * 24 * 60 * 60 * 1000;
        const lastOffered = lastOfferedRaw ? parseInt(String(lastOfferedRaw), 10) : 0;
        if (!lastOffered || Date.now() - lastOffered > sevenDays) {
          maintenancePlanOffer = true;
          await redis.set(
            `household:${householdId}:maintenanceOfferShownAt`,
            String(Date.now()),
            { ex: 7 * 24 * 60 * 60 }
          );
        }
      }
    } catch (err) {
      console.warn("[brief] maintenance offer check failed:", err?.message || err);
    }

    // First-brief acknowledgment — exactly one sentence introducing
    // the Directory, prepended once and never again. Permanent key
    // (no TTL) so the welcome line never reappears on a re-onboard
    // or a brief regeneration weeks later.
    let isFirstBrief = false;
    try {
      const firstSentKey = `household:${householdId}:firstBriefSent`;
      const alreadySent = await redis.get(firstSentKey);
      if (!alreadySent) {
        isFirstBrief = true;
        await redis.set(firstSentKey, "1");
      }
    } catch (err) {
      console.warn("[brief] firstBrief check failed:", err?.message || err);
    }

    let finalBrief = brief;
    if (isFirstBrief) {
      const welcome = "Conductor is built for households like yours — complex, busy, always in motion. A Directory in Your House covers everything whenever you're ready.";
      finalBrief = `${welcome}\n\n${brief}`.trim();
    }
    if (anniversary) {
      try {
        const ackKey = `household:${householdId}:anniversaryAcknowledged:${anniversary.anniversaryYearKey}`;
        const already = await redis.get(ackKey);
        if (!already) {
          const closer = await generateAnniversaryClosing(anniversary.yearStats);
          if (closer && typeof closer === "string") {
            finalBrief = `${brief.trim()}\n\n${closer}`.trim();
            await redis.set(ackKey, "1", { ex: 48 * 60 * 60 });
          }
        }
      } catch (err) {
        console.warn("[anniversary] closer failed:", err?.message || err);
      }
    }

    // ── Personality layer additions ──

    // Icon note — surfaced on the 1st of each month when the user
    // has auto-icon-update enabled (default true). Single line that
    // lives just below The Pulse on mobile. Off-day briefs leave the
    // field null. The 1st-of-month gate matches the launch-time
    // suggestion sheet so the brief copy and the icon offer align.
    let iconNote = null;
    try {
      const now = new Date();
      const dayOfMonth = now.getDate();
      if (dayOfMonth === 1) {
        const MONTH_NAMES = [
          "January", "February", "March", "April", "May", "June",
          "July", "August", "September", "October", "November", "December",
        ];
        const monthName = MONTH_NAMES[now.getMonth()];
        // Region-specific flavor where it earns its line; falls
        // through to a neutral copy for everywhere else.
        const flavorByMonth = {
          January:   "The Conductor has put on a new year look.",
          February:  "The Conductor is feeling the peak season.",
          March:     "The Conductor has dressed for the change in air.",
          April:     "The Conductor has put on something green.",
          May:       "The Conductor is feeling the South Florida energy.",
          June:      "The Conductor has its eye on the Atlantic.",
          July:      "The Conductor is dressed for the heat.",
          August:    "The Conductor is at attention.",
          September: "The Conductor has put on autumn.",
          October:   "The Conductor is dressed for Boat Show month.",
          November:  "The Conductor is dressed for gratitude.",
          December:  "The Conductor has put on its Christmas look.",
        };
        const flavor = flavorByMonth[monthName] || `The Conductor has put on a new look.`;
        iconNote = `${monthName} has arrived. ${flavor}`;
      }
    } catch (err) {
      console.warn("[brief] icon note failed:", err?.message || err);
    }

    // December 25 / December 31 — overrides land BEFORE the regular
    // sign-off + radar-clear additions so the Christmas / NYE copy
    // gets the final word. Both override the brief's lead, but only
    // when the brief isn't a firstRun or red-alert (those have their
    // own opinionated copy).
    try {
      const now = new Date();
      const month = now.getMonth(); // 11 = December
      const day = now.getDate();
      if (month === 11 && day === 25 && !isFirstRun) {
        finalBrief = `Merry Christmas. The Conductor has the rest. Enjoy the day.\n\n${finalBrief.trim()}`;
      } else if (month === 11 && day === 31 && !isFirstRun) {
        // Days-since-onboarding count for the NYE close. Falls
        // through to a neutral copy when we can't compute it.
        let daysSince = null;
        try {
          const rawCreated = await redis.get(`household:${householdId}:createdAt`);
          const created = rawCreated
            ? (typeof rawCreated === "string" ? Date.parse(rawCreated) : Number(rawCreated))
            : null;
          if (created && !isNaN(created)) {
            daysSince = Math.max(1, Math.floor((Date.now() - created) / (24 * 60 * 60 * 1000)));
          }
        } catch { /* ignore */ }
        const dayLine = daysSince
          ? `The Conductor has been watching your household for ${daysSince} days.`
          : `The Conductor has been watching your household this year.`;
        finalBrief = `The last brief of the year. ${dayLine}\n\n${finalBrief.trim()}\n\nIt's been, by most measures, worth watching.`;
      }
    } catch (err) {
      console.warn("[brief] dec25/31 override failed:", err?.message || err);
    }

    // Streak milestone observation — surfaced when the household
    // hits one of the named thresholds. Stored as a separate
    // streakObservation field so the mobile renderer can give it
    // distinct treatment (brass color, slight size bump per spec).
    let streakObservation = null;
    try {
      const streakRaw = await redis.get(`household:${householdId}:streakData`);
      const data = streakRaw
        ? (typeof streakRaw === "string" ? JSON.parse(streakRaw) : streakRaw)
        : null;
      const cur = Number(data?.currentStreak) || 0;
      const milestones = {
        7:   "Seven days. The Conductor notes the streak is real.",
        14:  "Two weeks. The household has found its rhythm.",
        21:  "21 days. Most habits form in less time than this.",
        30:  "30 days. The Conductor doesn't often say this: well done.",
        60:  "Two months. The Conductor has been watching for 60 days. It approves of what it sees.",
        90:  "90 days. The Conductor knows this household now.",
        100: "100 days. The Conductor marks this quietly.",
        365: "One year. The Conductor has been watching your household for 365 days. It has been, by most measures, worth watching.",
      };
      if (milestones[cur]) {
        // Acknowledged-once latch — same household won't see the
        // milestone twice if their streak hovers at the threshold
        // (resolve a signal at 30 days, signal expires, resolve
        // another, streak ticks back to 30). Keyed by milestone
        // value so future thresholds don't suppress.
        const ackKey = `household:${householdId}:streakAck:${cur}`;
        const already = await redis.get(ackKey).catch(() => null);
        if (!already) {
          streakObservation = milestones[cur];
          await redis.set(ackKey, "1", { ex: 90 * 24 * 60 * 60 }).catch(() => null);
        }
      }
    } catch (err) {
      console.warn("[brief] streak milestone failed:", err?.message || err);
    }

    // Radar-clear sign-off — when there are genuinely zero active
    // signals, append the special quiet-day closing. Skipped if
    // isFirstRun (the firstRun noSignals copy is already custom).
    if (!isFirstRun && synthesisState.signalLoad === "clear") {
      const radarClearSignOff =
        "The Conductor has nothing to report. The radar is clear. This is genuinely rare. The Conductor recommends being outside more than you currently are.";
      finalBrief = `${finalBrief.trim()}\n\n${radarClearSignOff}`;
    }

    // Brief sign-off — ~40% chance of appending a one-liner, never
    // the same as yesterday's. Suppressed when isFirstRun /
    // isFirstBrief / red-alert / radar-clear so the line lands at
    // the right moment, not on top of another sign-off. Persisted
    // at household:{id}:lastSignOff (no TTL — we want the
    // anti-repeat to last across many days).
    try {
      const suppressSignOff =
        isFirstRun
        || isFirstBrief
        || synthesisState.signalLoad === "clear"
        || synthesisState.synthesisFlags?.includes?.("red_alert");
      if (!suppressSignOff && Math.random() < 0.4) {
        const SIGN_OFFS = [
          "The Conductor has the rest.",
          "It's safe to look away.",
          "The radar is yours.",
          "The Conductor is watching.",
          "Nothing else from The Conductor today.",
          "That's what matters. The rest can wait.",
          "The Conductor has everything else.",
          "Go. The Conductor is here.",
        ];
        const lastSignOff = await redis.get(`household:${householdId}:lastSignOff`).catch(() => null);
        const pool = SIGN_OFFS.filter((s) => s !== lastSignOff);
        const pick = pool[Math.floor(Math.random() * pool.length)];
        if (pick) {
          finalBrief = `${finalBrief.trim()}\n\n${pick}`;
          await redis.set(`household:${householdId}:lastSignOff`, pick).catch(() => null);
        }
      }
    } catch (err) {
      console.warn("[brief] sign-off failed:", err?.message || err);
    }

    // Spoken summary — 2-sentence speech-friendly condensation of
    // the brief for the morning Takeoff voice playback. Best-effort;
    // null when the Haiku call fails (mobile falls back to silent).
    let spokenSummary = null;
    try {
      const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 200,
          messages: [
            {
              role: "user",
              content: `Summarize this brief as 2 spoken sentences. What are the 1-2 most important things? Natural speech, no formatting, no preface.

Brief: ${finalBrief}

Return only the spoken text.`,
            },
          ],
        }),
      });
      if (apiRes.ok) {
        const data = await apiRes.json();
        const text = data?.content?.[0]?.text;
        if (text && typeof text === "string") spokenSummary = text.trim();
      }
    } catch (err) {
      console.warn("[brief] spokenSummary failed:", err?.message);
    }

    // Expose householdName from the profile so mobile surfaces
    // (Summary card, Settings header, network display) can lift it
    // without an extra round trip.
    let householdName = null;
    try {
      const rawProfile = await redis.get(`household:${householdId}:profile`);
      const profile = rawProfile
        ? (typeof rawProfile === "string" ? JSON.parse(rawProfile) : rawProfile)
        : null;
      if (profile?.householdName) householdName = profile.householdName;
    } catch { /* skip */ }

    // First-brief morning question — onboarding moment that
    // introduces The Conductor at exactly the right time. The mobile
    // Ground screen reads isFirstBrief + morningQuestion together
    // and renders the question with a real "Tell The Conductor →"
    // button rather than the muted weekly variant.
    const morningQuestion = isFirstBrief
      ? "What would make this week feel successful for your household?"
      : null;

    // Emotional joke offer — the in-between zone where the household
    // is having a hard but not catastrophic time. Surfaced rare
    // enough to feel meaningful: medium-intensity stress dominant,
    // no high-intensity stress/grief, no active red alert, and the
    // load or health is dragging. Once-per-day cap via
    // household:{id}:jokeOfferedToday with midnight TTL so the same
    // household isn't offered twice on a single tough day.
    let jokeOffer = null;
    let jokeOffered = false;
    try {
      // Detect medium-intensity dominant stress directly from
      // activeSignals rather than synthesisState (which currently
      // only tracks high-intensity). High-intensity grief/stress
      // anywhere in the active pool disqualifies — those days get
      // the calibration block, not a joke.
      const mediumStress = (activeSignals || []).find(
        (s) => s?.emotionalIntensity === "medium" && s?.emotionalValence === "stressful"
      );
      const highGrief = (activeSignals || []).some(
        (s) => s?.emotionalIntensity === "high" && s?.emotionalValence === "grief"
      );
      const highStress = (activeSignals || []).some(
        (s) => s?.emotionalIntensity === "high" && s?.emotionalValence === "stressful"
      );
      const hasActiveAlert = !!(await redis.get(`household:${householdId}:activeAlert`).catch(() => null));
      const loadHeavyish = synthesisState.signalLoad === "heavy" || synthesisState.signalLoad === "moderate";
      const healthDragging = synthesisState.healthState === "low" || synthesisState.healthState === "poor";

      const eligible =
        !!mediumStress
        && !highGrief
        && !highStress
        && !hasActiveAlert
        // Never offer a joke on the household's first brief — that
        // moment belongs to the onboarding morning question.
        && !isFirstBrief
        && (loadHeavyish || healthDragging);

      if (eligible) {
        const dailyKey = `household:${householdId}:jokeOfferedToday`;
        const alreadyOffered = await redis.get(dailyKey).catch(() => null);
        if (!alreadyOffered) {
          // Carried-forward count for the prompt — falls through to
          // 0 when the array isn't populated yet on this path.
          const cfCount = Array.isArray(carriedForwardSignals)
            ? carriedForwardSignals.length
            : 0;
          const offerPrompt = `The household is having a stressful but not catastrophic time.
Signals: ${synthesisState.signalLoad}
Health: ${synthesisState.healthState || "not connected"}
Carried forward signals: ${cfCount}

Write one understated offer line that gently offers a laugh.
Don't say 'cheer up' or anything patronizing.
The tone is: a trusted friend who noticed you're tired and has something that might help.
Maximum 12 words. End with an em dash — The Conductor will show the joke on tap.

Examples of the right tone:
'Heavy week. The Conductor has one more thing if you need it —'
'A lot in motion. Something lighter, if you want it —'
'Rough combination today. The Conductor noticed. Also —'
'These signals have been waiting a while. So has this —'

Return only the offer line.`;
          try {
            const haikuRes = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": process.env.ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
              },
              body: JSON.stringify({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 100,
                messages: [{ role: "user", content: offerPrompt }],
              }),
            });
            if (haikuRes.ok) {
              const data = await haikuRes.json();
              const text = (data?.content?.[0]?.text || "").trim();
              if (text && text.length <= 120) {
                jokeOffer = text.replace(/^["'“”]+|["'“”]+$/g, "").trim();
                jokeOffered = true;
                // Midnight TTL — compute seconds until next local
                // midnight UTC-side. Slightly imprecise on DST days
                // but close enough; the key isn't load-bearing past
                // the daily window.
                const now = new Date();
                const nextMidnight = new Date(now);
                nextMidnight.setUTCHours(24, 0, 0, 0);
                const ttlSec = Math.max(60, Math.floor((nextMidnight.getTime() - now.getTime()) / 1000));
                await redis.set(dailyKey, "1", { ex: ttlSec }).catch(() => null);
              }
            }
          } catch (err) {
            console.warn("[brief] joke offer Haiku failed:", err?.message || err);
          }
        }
      }
    } catch (err) {
      console.warn("[brief] joke offer eligibility failed:", err?.message || err);
    }

    const briefResponse = {
      brief: finalBrief,
      spokenSummary,
      householdName,
      quietDay,
      segments,
      transparency,
      theRead,
      pulse: synthesisState.synthesisNote,
      pulseFlags: synthesisState.synthesisFlags,
      pulseData,
      household: householdId,
      user: userName,
      isFirstRun,
      isSingleMember,
      handoff: handoff
        ? { signalId: handoff.signalId, message: handoff.message, type: handoff.type }
        : null,
      conductorQuestion: conductorQuestion || null,
      // Maintenance plan offer — surfaced when inventory is rich
      // enough to plan against AND no offer has been shown to this
      // household in the last 7 days. The mobile Ground card reads
      // this flag to show the "Build plan →" card.
      maintenancePlanOffer: maintenancePlanOffer,
      isFirstBrief,
      morningQuestion,
      jokeOffer,
      jokeOffered,
      streakObservation,
      iconNote,
    };

    // Cache the per-user response so a subsequent /api/brief call for
    // the same user within the TTL window returns the same prose —
    // keeps the push body and the app brief in sync.
    if (userId) {
      await redis.set(
        `user:${userId}:currentTakeoff`,
        JSON.stringify(briefResponse),
        { ex: CURRENT_TAKEOFF_TTL_S }
      );
    }

    return res.status(200).json(briefResponse);
  } catch (error) {
    console.error("Brief error:", error);
    return res.status(500).json({ error: "Failed to generate brief" });
  }
}
