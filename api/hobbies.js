// Hobby-driven environmental enrichment. Right now this covers the
// water cluster (surf/marine) only — golf, cycling, etc. can follow
// the same shape (gate on the hobby key, fetch a free environmental
// source, normalize to a small classification).
//
// All helpers degrade gracefully: if the hobby isn't selected, or the
// upstream NOAA endpoints don't return marine data for the coords
// (most inland points), return null and the brief just doesn't
// surface anything. Failures are silent — this is opportunity layer,
// not core obligation, so a 500 from NOAA shouldn't bubble.

// Lightweight tag so NOAA returns something instead of rate-limiting
// us. Their docs ask for an identifying UA on every request.
const NOAA_UA = "Conductor (conductor-ivory.vercel.app)";

async function fetchJson(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": NOAA_UA, Accept: "application/geo+json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Extracts a numeric wave-height (ft) from a forecast period detailedForecast
// string. NOAA writes things like "Seas 3 to 4 feet." or "Waves 1 foot or
// less." — we scan for the first "<N> to <M> feet" or "<N> foot" mention.
function parseWaveHeightFt(text) {
  if (typeof text !== "string") return null;
  // "Seas X to Y feet" or "Waves X to Y feet"
  const range = text.match(/(?:seas|waves)\s+(\d+(?:\.\d+)?)\s+to\s+(\d+(?:\.\d+)?)\s+feet/i);
  if (range) {
    const lo = parseFloat(range[1]);
    const hi = parseFloat(range[2]);
    if (!isNaN(lo) && !isNaN(hi)) return (lo + hi) / 2;
  }
  const single = text.match(/(?:seas|waves)\s+(\d+(?:\.\d+)?)\s+foot/i);
  if (single) {
    const v = parseFloat(single[1]);
    if (!isNaN(v)) return v;
  }
  // "Waves around 2 feet"
  const around = text.match(/(?:seas|waves)[^.]*?around\s+(\d+(?:\.\d+)?)\s+feet/i);
  if (around) {
    const v = parseFloat(around[1]);
    if (!isNaN(v)) return v;
  }
  return null;
}

// Wind direction (cardinal) + speed (mph) — NOAA gives windSpeed as
// "10 to 15 mph" and windDirection as "NE" on the period object.
function parseWindSpeedMph(windSpeed) {
  if (typeof windSpeed !== "string") return null;
  const range = windSpeed.match(/(\d+)\s+to\s+(\d+)/);
  if (range) {
    return (parseInt(range[1], 10) + parseInt(range[2], 10)) / 2;
  }
  const single = windSpeed.match(/(\d+)/);
  if (single) return parseInt(single[1], 10);
  return null;
}

// "Offshore" / "onshore" depends on coastline orientation. For the East
// Coast (Atlantic), offshore = west-component winds (W, NW, SW); onshore
// = east-component (E, NE, SE). For West Coast we'd flip it. Without
// coastline metadata we assume Atlantic-east-coast, which covers most
// of Conductor's current user base; misclassification on a Pacific
// coast just means "fair" instead of "good" on some days, not a hard
// error.
const OFFSHORE_DIRS_ATLANTIC = new Set(["W", "WNW", "WSW", "NW", "SW"]);
const ONSHORE_DIRS_ATLANTIC = new Set(["E", "ENE", "ESE", "NE", "SE"]);

function isOffshore(dir) {
  if (!dir) return false;
  return OFFSHORE_DIRS_ATLANTIC.has(String(dir).toUpperCase());
}
function isOnshore(dir) {
  if (!dir) return false;
  return ONSHORE_DIRS_ATLANTIC.has(String(dir).toUpperCase());
}

function classifySurf(waveHeightFt, windDirection, windSpeedMph) {
  // Falls through tiers from best → worst. Tier ladder mirrors the
  // user's spec verbatim; only the wind-component classification is
  // our own judgment.
  const wh = typeof waveHeightFt === "number" ? waveHeightFt : 0;
  const ws = typeof windSpeedMph === "number" ? windSpeedMph : 0;
  const offshore = isOffshore(windDirection);
  const onshore = isOnshore(windDirection);
  const lightWind = ws <= 10;
  const strongOnshore = onshore && ws > 15;

  // Excellent: waves 3ft+, offshore or light wind
  if (wh >= 3 && (offshore || lightWind)) return "excellent";
  // Good: waves 2-3ft, light wind
  if (wh >= 2 && wh < 3 && lightWind) return "good";
  // Poor: flat or strong onshore wind
  if (wh < 1 || strongOnshore) return "poor";
  // Fair: waves 1-2ft or onshore wind
  return "fair";
}

// Public — gate on the water hobby and return null when the user
// hasn't selected it. Caller (brief.js) only invokes us once it
// already has the household's hobbies array; the gate here is a
// belt-and-braces against future refactors.
export async function getSurfConditions(lat, lon, hobbies = []) {
  if (!Array.isArray(hobbies) || !hobbies.includes("water")) return null;
  if (typeof lat !== "number" || typeof lon !== "number") return null;

  // Step 1: points → grid forecast URL
  const points = await fetchJson(`https://api.weather.gov/points/${lat},${lon}`);
  const forecastUrl = points?.properties?.forecast;
  if (!forecastUrl) return null;

  // Step 2: forecast — periods contain detailedForecast (where NOAA
  // mentions seas/waves for coastal points) + windDirection + windSpeed
  const forecast = await fetchJson(forecastUrl);
  const periods = forecast?.properties?.periods;
  if (!Array.isArray(periods) || periods.length === 0) return null;

  // Use the first daytime period — surf calls are typically daylight
  // hour assessments. Fall back to the first period if no day flag.
  const period = periods.find((p) => p?.isDaytime) || periods[0];

  const waveHeight = parseWaveHeightFt(period?.detailedForecast || "");
  const windDirection = period?.windDirection || null;
  const windSpeed = parseWindSpeedMph(period?.windSpeed || "");

  // If the forecast doesn't mention any wave/sea info at all, this
  // is most likely an inland point — return null rather than emit a
  // bogus surf call.
  if (waveHeight == null) return null;

  return {
    waveHeight,
    windDirection,
    windSpeed,
    conditions: classifySurf(waveHeight, windDirection, windSpeed),
    period: period?.name || null,
  };
}

// Default export so the file works as a Vercel serverless function too,
// for ad-hoc verification: GET /api/hobbies?lat=N&lon=N&hobbies=water
export default async function handler(req, res) {
  const lat = parseFloat(req.query?.lat);
  const lon = parseFloat(req.query?.lon);
  const hobbiesParam = req.query?.hobbies || "";
  const hobbies = String(hobbiesParam).split(",").map((s) => s.trim()).filter(Boolean);
  const surf = await getSurfConditions(lat, lon, hobbies);
  return res.status(200).json({ ok: true, surf });
}
