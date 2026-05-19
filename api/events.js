// Eventbrite local-event fetcher. Credential-gated on
// EVENTBRITE_API_KEY (private token from eventbrite.com/account/api-keys).
//
// Strategy: query events near the household centroid in the next 30
// days, filter to ones likely to actually affect a household (large
// capacity or close-in geographically), and cache the result in
// household:{id}:localEvents with a 7-day TTL. The brief reads this
// alongside the ANNUAL_EVENTS hardcoded calendar (api/brief.js) so
// the two feeds merge into a single LOCAL AND SEASONAL AWARENESS
// section.
//
// All exports return [] on missing credentials, API errors, or empty
// results — never throws, never blocks the sync pipeline.

const API_BASE = "https://www.eventbriteapi.com/v3/events/search/";
const FETCH_TIMEOUT_MS = 6000;
const DAY_MS = 24 * 60 * 60 * 1000;

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Distance between two lat/lng points in kilometers (haversine).
// Used to score "near household" filter — events within 5km of the
// household centroid are kept regardless of capacity.
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export async function fetchLocalEvents(lat, lon, radiusKm = 25) {
  const key = process.env.EVENTBRITE_API_KEY;
  if (!key) return [];
  if (typeof lat !== "number" || typeof lon !== "number") return [];

  const now = new Date();
  const start = now.toISOString();
  const end = new Date(now.getTime() + 30 * DAY_MS).toISOString();
  const params = [
    `location.latitude=${lat}`,
    `location.longitude=${lon}`,
    `location.within=${radiusKm}km`,
    `expand=venue`,
    `sort_by=date`,
    `start_date.range_start=${encodeURIComponent(start)}`,
    `start_date.range_end=${encodeURIComponent(end)}`,
  ].join("&");
  const url = `${API_BASE}?${params}`;

  try {
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      console.warn(`[eventbrite] HTTP ${res.status}`);
      return [];
    }
    const json = await res.json();
    const events = Array.isArray(json?.events) ? json.events : [];

    // Filter: keep events that are "household-relevant" — either
    // large enough to throw off traffic (capacity > 1000) OR close
    // enough that proximity alone matters (within 5km), OR both.
    // Strip down to the shape brief.js wants.
    const filtered = [];
    for (const e of events) {
      const venue = e.venue || {};
      const venueLat = Number(venue.latitude);
      const venueLon = Number(venue.longitude);
      const capacity = Number(e.capacity) || 0;
      const proximityKm =
        !isNaN(venueLat) && !isNaN(venueLon)
          ? haversineKm(lat, lon, venueLat, venueLon)
          : null;
      const closeEnough = proximityKm != null && proximityKm <= 5;
      const bigEnough = capacity > 1000;
      if (!closeEnough && !bigEnough) continue;
      filtered.push({
        id: e.id,
        name: e.name?.text || e.name || "Untitled event",
        date: e.start?.local || e.start?.utc || null,
        venue: venue.address?.localized_address_display || venue.name || null,
        lat: !isNaN(venueLat) ? venueLat : null,
        lng: !isNaN(venueLon) ? venueLon : null,
        capacity: capacity || null,
        proximityKm: proximityKm != null ? Math.round(proximityKm * 10) / 10 : null,
        url: e.url || null,
      });
    }
    return filtered;
  } catch (err) {
    console.warn("[eventbrite] fetch failed:", err?.message || err);
    return [];
  }
}

// Convenience: store the fetched events at household:{id}:localEvents
// with a 7d TTL. Called from sync.js once per household per run.
export async function refreshLocalEventsCache(redis, householdId, lat, lon) {
  const events = await fetchLocalEvents(lat, lon);
  if (events.length === 0) return 0;
  try {
    const key = `household:${householdId}:localEvents`;
    await redis.set(key, JSON.stringify(events));
    await redis.expire(key, 7 * 24 * 60 * 60);
    console.log(`[eventbrite] cached ${events.length} events for ${householdId}`);
  } catch (err) {
    console.warn("[eventbrite] cache write failed:", err?.message || err);
  }
  return events.length;
}
