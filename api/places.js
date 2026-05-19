// Google Places + Distance Matrix helpers. Credential-gated on
// GOOGLE_PLACES_KEY and GOOGLE_MAPS_KEY (the same key works for both
// when Places API + Distance Matrix API are both enabled).
//
// Every export returns null on missing credentials, API errors, or
// empty results — callers should treat these as best-effort signals
// and never block the brief / import path on a Places failure.

const PLACES_BASE = "https://maps.googleapis.com/maps/api/place/textsearch/json";
const MATRIX_BASE = "https://maps.googleapis.com/maps/api/distancematrix/json";
const FETCH_TIMEOUT_MS = 4000;

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Try to resolve a real-world location from a signal's description +
// sender. Strategy: query "{sender} {first 60 chars of description}"
// — sender is usually a business name, description fills in context.
// Falls back to description-only if no sender. Returns the top hit
// when results.length > 0; null on any failure.
export async function extractSignalLocation(description, sender) {
  const key = process.env.GOOGLE_PLACES_KEY;
  if (!key) return null;
  const desc = (description || "").trim();
  const senderStr = (sender || "").trim();
  const queryParts = [senderStr, desc.slice(0, 60)].filter(Boolean);
  if (queryParts.length === 0) return null;
  const query = queryParts.join(" ");

  const url =
    `${PLACES_BASE}?query=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const json = await res.json();
    const top = Array.isArray(json?.results) ? json.results[0] : null;
    if (!top) return null;
    const loc = top.geometry?.location;
    if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") {
      return null;
    }
    return {
      name: top.name || null,
      address: top.formatted_address || null,
      lat: loc.lat,
      lng: loc.lng,
      placeId: top.place_id || null,
    };
  } catch (err) {
    console.warn("[places] extractSignalLocation failed:", err?.message || err);
    return null;
  }
}

// Drive time + distance from origin to destination at a future
// departure time. departureTime accepts either a Date, an ISO string,
// or a unix-seconds number; defaults to 'now'. The Distance Matrix
// API surfaces traffic-aware durations when a future departure is
// specified — we always pass one so the returned ETA reflects what
// the user will actually experience, not a free-flow estimate.
export async function getTravelTime(originLat, originLng, destLat, destLng, departureTime) {
  const key = process.env.GOOGLE_MAPS_KEY || process.env.GOOGLE_PLACES_KEY;
  if (!key) return null;
  if (
    typeof originLat !== "number" || typeof originLng !== "number" ||
    typeof destLat !== "number" || typeof destLng !== "number"
  ) {
    return null;
  }
  let depSeconds;
  if (departureTime == null) {
    depSeconds = "now";
  } else if (typeof departureTime === "number") {
    depSeconds = departureTime > 1e12 ? Math.floor(departureTime / 1000) : departureTime;
  } else if (departureTime instanceof Date) {
    depSeconds = Math.floor(departureTime.getTime() / 1000);
  } else {
    const ms = Date.parse(String(departureTime));
    depSeconds = isNaN(ms) ? "now" : Math.floor(ms / 1000);
  }
  // Distance Matrix rejects past timestamps for traffic-aware queries.
  // Snap any timestamp < now+30s up to 'now'.
  if (typeof depSeconds === "number" && depSeconds * 1000 < Date.now() + 30_000) {
    depSeconds = "now";
  }

  const params = [
    `origins=${originLat},${originLng}`,
    `destinations=${destLat},${destLng}`,
    `departure_time=${depSeconds}`,
    `key=${encodeURIComponent(key)}`,
  ].join("&");
  const url = `${MATRIX_BASE}?${params}`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const json = await res.json();
    const row = json?.rows?.[0]?.elements?.[0];
    if (!row || row.status !== "OK") return null;
    // duration_in_traffic only present when a future departure_time is
    // accepted; fall back to duration (free-flow) when not.
    const dur = row.duration_in_traffic || row.duration;
    const dist = row.distance;
    if (!dur) return null;
    return {
      durationMinutes: Math.round((dur.value || 0) / 60),
      durationText: dur.text || null,
      distanceMiles: dist?.value != null
        ? Math.round((dist.value / 1609.344) * 10) / 10
        : null,
    };
  } catch (err) {
    console.warn("[places] getTravelTime failed:", err?.message || err);
    return null;
  }
}
