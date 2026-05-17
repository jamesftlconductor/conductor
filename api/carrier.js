// Carrier tracking integration.
//
// Five package carriers (UPS, FedEx, USPS, DHL, AMZL) + FlightAware
// for air-travel signals. Each tracker returns a standardized shape
// so the cron and notification paths don't care which carrier they
// came from:
//
//   { carrier, status, eta, location, lastUpdate, events }
//
// Status is normalized to a small enum: "Label Created", "In Transit",
// "Out for Delivery", "Delayed", "Delivered", "Delivery Attempted".
//
// When credentials are absent or a call fails, every tracker returns
// `null` rather than throwing — the cron should treat null as "no
// update this round" and skip notification logic.
//
// AMZL is detectable from tracking-number format but cannot be tracked
// via API. Its status flows in via parseAmazonDeliveryEmail() from
// import.js when delivery-progress emails arrive.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ---------- Carrier detection ----------

const TRACKING_PATTERNS = [
  { carrier: "UPS",  re: /^1Z[A-Z0-9]{16}$/i },
  { carrier: "UPS",  re: /^T\d{17}$/i },
  { carrier: "AMZL", re: /^TBA\d{12}$/i },
  // USPS prefixes (priority + tracking variants) + 82-digit IMpb.
  { carrier: "USPS", re: /^(9400|9205|9361|9300|9270|9410)\d{18}$/ },
  { carrier: "USPS", re: /^82\d{8}$/ },
  // FedEx — 12, 15, or 20 numeric digits. Detected AFTER UPS so 1Z
  // codes (alpha-prefixed) take precedence, and AFTER USPS so the
  // longer USPS formats don't get misclassified.
  { carrier: "FedEx", re: /^\d{12}$/ },
  { carrier: "FedEx", re: /^\d{15}$/ },
  { carrier: "FedEx", re: /^\d{20}$/ },
  // DHL alpha-prefixed and shorter numeric variants. Numeric DHL is
  // ambiguous with FedEx-12 — caller can disambiguate with sender
  // context if it matters.
  { carrier: "DHL", re: /^1L[A-Z0-9]{8,}$/i },
  { carrier: "DHL", re: /^\d{10,11}$/ },
];

export function detectCarrier(trackingNumber) {
  if (!trackingNumber || typeof trackingNumber !== "string") return null;
  const t = trackingNumber.trim().toUpperCase();
  for (const { carrier, re } of TRACKING_PATTERNS) {
    if (re.test(t)) return carrier;
  }
  return null;
}

// ---------- Status normalization ----------

const STATUS_MAP = [
  { re: /delivered/i, status: "Delivered" },
  { re: /out for delivery|on vehicle|with courier|with driver/i, status: "Out for Delivery" },
  { re: /delivery attempted|attempted delivery/i, status: "Delivery Attempted" },
  { re: /exception|delay|delayed|on hold|held/i, status: "Delayed" },
  { re: /label created|shipment information sent|pre[- ]transit|order processed/i, status: "Label Created" },
  { re: /in transit|in.?transit|departed|arrived|processed at|origin scan|on the way/i, status: "In Transit" },
];

export function normalizeStatus(raw) {
  if (!raw) return "In Transit";
  for (const { re, status } of STATUS_MAP) {
    if (re.test(raw)) return status;
  }
  return "In Transit";
}

// ---------- OAuth token cache ----------
//
// UPS tokens live ~4 hours; FedEx tokens ~1 hour. Caching them in
// Redis avoids hitting the token endpoints on every tracking call.
// Cache key: `carrier:token:{carrier}`. Stored with the carrier's
// reported expiry minus 60s safety margin.

async function getCachedToken(carrier) {
  const raw = await redis.get(`carrier:token:${carrier}`);
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (raw && typeof raw === "object" && raw.token) return raw.token;
  return null;
}

async function setCachedToken(carrier, token, expiresInSec) {
  const ttl = Math.max(60, Math.floor((expiresInSec || 3600) - 60));
  await redis.set(`carrier:token:${carrier}`, token, { ex: ttl });
}

// ---------- UPS ----------

async function getUPSToken() {
  const cached = await getCachedToken("ups");
  if (cached) return cached;
  const id = process.env.UPS_CLIENT_ID;
  const secret = process.env.UPS_CLIENT_SECRET;
  if (!id || !secret) return null;
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await fetch("https://onlinetools.ups.com/security/v1/oauth/token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    console.warn(`[ups] token fetch ${res.status}`);
    return null;
  }
  const data = await res.json();
  if (!data.access_token) return null;
  await setCachedToken("ups", data.access_token, parseInt(data.expires_in, 10));
  return data.access_token;
}

export async function trackUPS(trackingNumber) {
  const token = await getUPSToken();
  if (!token) return null;
  const url = `https://onlinetools.ups.com/api/track/v1/details/${encodeURIComponent(trackingNumber)}`;
  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "transId": `conductor-${Date.now()}`,
      "transactionSrc": "conductor",
    },
  });
  if (!res.ok) {
    console.warn(`[ups] track ${trackingNumber} → ${res.status}`);
    return null;
  }
  const data = await res.json();
  // Response shape: trackResponse.shipment[0].package[0].{activity, currentStatus, deliveryDate}
  const pkg = data?.trackResponse?.shipment?.[0]?.package?.[0] || {};
  const activity = Array.isArray(pkg.activity) ? pkg.activity : [];
  const latest = activity[0] || {};
  const eta = (pkg.deliveryDate && pkg.deliveryDate[0]?.date) || null;
  const status = normalizeStatus(pkg.currentStatus?.description || latest.status?.description);
  return {
    carrier: "UPS",
    status,
    eta: eta ? formatUpsDate(eta) : null,
    location: latest.location?.address?.city || null,
    lastUpdate: latest.date ? formatUpsDate(latest.date) : null,
    events: activity.slice(0, 5).map((a) => ({
      status: a.status?.description || "",
      location: a.location?.address?.city || "",
      timestamp: a.date ? formatUpsDate(a.date) : null,
    })),
  };
}

function formatUpsDate(yyyymmdd) {
  // UPS dates are "YYYYMMDD" with no separators.
  const m = String(yyyymmdd).match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return yyyymmdd;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// ---------- FedEx ----------

async function getFedExToken() {
  const cached = await getCachedToken("fedex");
  if (cached) return cached;
  const id = process.env.FEDEX_CLIENT_ID;
  const secret = process.env.FEDEX_CLIENT_SECRET;
  if (!id || !secret) return null;
  const res = await fetch("https://apis.fedex.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}`,
  });
  if (!res.ok) {
    console.warn(`[fedex] token fetch ${res.status}`);
    return null;
  }
  const data = await res.json();
  if (!data.access_token) return null;
  await setCachedToken("fedex", data.access_token, parseInt(data.expires_in, 10));
  return data.access_token;
}

export async function trackFedEx(trackingNumber) {
  const token = await getFedExToken();
  if (!token) return null;
  const res = await fetch("https://apis.fedex.com/track/v1/trackingnumbers", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-locale": "en_US",
    },
    body: JSON.stringify({
      trackingInfo: [{ trackingNumberInfo: { trackingNumber } }],
      includeDetailedScans: true,
    }),
  });
  if (!res.ok) {
    console.warn(`[fedex] track ${trackingNumber} → ${res.status}`);
    return null;
  }
  const data = await res.json();
  const result = data?.output?.completeTrackResults?.[0]?.trackResults?.[0] || {};
  const latest = result.latestStatusDetail || {};
  const scans = Array.isArray(result.scanEvents) ? result.scanEvents : [];
  const etaWin = result.estimatedDeliveryTimeWindow?.window || {};
  return {
    carrier: "FedEx",
    status: normalizeStatus(latest.statusByLocale || latest.description),
    eta: etaWin.ends || etaWin.begins || result.standardTransitTimeWindow?.window?.ends || null,
    location: latest.scanLocation?.city || null,
    lastUpdate: scans[0]?.date || null,
    events: scans.slice(0, 5).map((s) => ({
      status: s.eventDescription || "",
      location: s.scanLocation?.city || "",
      timestamp: s.date || null,
    })),
  };
}

// ---------- USPS ----------
//
// The legacy XML "Web Tools" API at secure.shippingapis.com was
// retired Jan 25, 2026. Current path is OAuth 2.0 + REST at
// apis.usps.com, identical pattern to UPS/FedEx — two creds
// (Consumer Key + Consumer Secret) and a Bearer token cached in
// Redis.

async function getUSPSToken() {
  const cached = await getCachedToken("usps");
  if (cached) return cached;
  const id = process.env.USPS_CONSUMER_KEY;
  const secret = process.env.USPS_CONSUMER_SECRET;
  if (!id || !secret) return null;
  const res = await fetch("https://apis.usps.com/oauth2/v3/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: id,
      client_secret: secret,
    }),
  });
  if (!res.ok) {
    console.warn(`[usps] token fetch ${res.status}`);
    return null;
  }
  const data = await res.json();
  if (!data.access_token) return null;
  await setCachedToken("usps", data.access_token, parseInt(data.expires_in, 10));
  return data.access_token;
}

export async function trackUSPS(trackingNumber) {
  const token = await getUSPSToken();
  if (!token) return null;
  const url = `https://apis.usps.com/tracking/v3/tracking/${encodeURIComponent(trackingNumber)}`;
  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
    },
  });
  if (!res.ok) {
    console.warn(`[usps] track ${trackingNumber} → ${res.status}`);
    return null;
  }
  const data = await res.json();
  // USPS v3 response: trackingNumber, trackingEvents[], expectedDeliveryDate,
  // statusCategory/statusSummary at the top level. Field names may carry
  // minor variants across release — use first-defined fallbacks.
  const events = Array.isArray(data.trackingEvents) ? data.trackingEvents : [];
  const latest = events[0] || {};
  const summaryText =
    data.statusSummary || data.statusCategory || latest.eventType || latest.eventDescription || "";
  function eventTime(e) {
    if (!e) return null;
    if (e.eventTimestamp) return e.eventTimestamp;
    if (e.eventDate) return e.eventTime ? `${e.eventDate} ${e.eventTime}` : e.eventDate;
    return null;
  }
  function eventCity(e) {
    if (!e) return null;
    return e.eventCity || e.city || e.location?.city || null;
  }
  function eventDesc(e) {
    if (!e) return "";
    return e.eventType || e.eventDescription || e.description || "";
  }
  return {
    carrier: "USPS",
    status: normalizeStatus(summaryText),
    eta: data.expectedDeliveryDate || data.estimatedDeliveryDate || null,
    location: eventCity(latest),
    lastUpdate: eventTime(latest),
    events: events.slice(0, 5).map((e) => ({
      status: eventDesc(e),
      location: eventCity(e) || "",
      timestamp: eventTime(e),
    })),
  };
}

// ---------- DHL ----------

export async function trackDHL(trackingNumber) {
  const apiKey = process.env.DHL_API_KEY;
  if (!apiKey) return null;
  const url = `https://api-eu.dhl.com/track/shipments?trackingNumber=${encodeURIComponent(trackingNumber)}`;
  const res = await fetch(url, { headers: { "DHL-API-Key": apiKey } });
  if (!res.ok) {
    console.warn(`[dhl] track ${trackingNumber} → ${res.status}`);
    return null;
  }
  const data = await res.json();
  const shipment = data?.shipments?.[0] || {};
  const events = Array.isArray(shipment.events) ? shipment.events : [];
  const latest = events[0] || {};
  return {
    carrier: "DHL",
    status: normalizeStatus(shipment.status?.description || latest.description),
    eta: shipment.estimatedTimeOfDelivery || null,
    location: latest.location?.address?.addressLocality || null,
    lastUpdate: latest.timestamp || null,
    events: events.slice(0, 5).map((e) => ({
      status: e.description || "",
      location: e.location?.address?.addressLocality || "",
      timestamp: e.timestamp || null,
    })),
  };
}

// ---------- Dispatch ----------

export async function trackPackage(trackingNumber) {
  const carrier = detectCarrier(trackingNumber);
  if (!carrier) return null;
  switch (carrier) {
    case "UPS":   return trackUPS(trackingNumber);
    case "FedEx": return trackFedEx(trackingNumber);
    case "USPS":  return trackUSPS(trackingNumber);
    case "DHL":   return trackDHL(trackingNumber);
    case "AMZL":  return null; // No public API; status flows via email parse.
    default:      return null;
  }
}

// ---------- Tracking number extraction from email body ----------
//
// Run AFTER Claude classifies the signal — so we only pull tracking
// numbers out of emails that already look like package notifications.
// The regexes are intentionally tight (anchored prefixes for the
// non-ambiguous carriers, validated digit counts for the rest) to
// minimize false positives on stray numbers in marketing copy.

const EXTRACT_PATTERNS = [
  // Anchored carriers first — these can't be mistaken for anything else.
  { carrier: "UPS",  re: /\b1Z[A-Z0-9]{16}\b/gi },
  { carrier: "AMZL", re: /\bTBA\d{12}\b/gi },
  { carrier: "USPS", re: /\b9[2345][0-9]{18}\b/g },
  { carrier: "USPS", re: /\b82\d{8}\b/g },
  { carrier: "DHL",  re: /\b1L[A-Z0-9]{8,}\b/gi },
  // Numeric-only patterns: validate length boundaries (\b on either
  // side of \d{N} ensures we don't slice the middle out of a longer
  // run of digits). FedEx 12 collides with DHL 10-11; we prefer
  // FedEx since DHL packages are rare in US households. Caller can
  // override via sender context if needed.
  { carrier: "FedEx", re: /\b\d{20}\b/g },
  { carrier: "FedEx", re: /\b\d{15}\b/g },
  { carrier: "FedEx", re: /\b\d{12}\b/g },
];

export function extractTrackingNumbers(text) {
  if (!text || typeof text !== "string") return [];
  const found = new Map();
  for (const { carrier, re } of EXTRACT_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const num = m[0].toUpperCase();
      if (!found.has(num)) found.set(num, carrier);
    }
  }
  return [...found.entries()].map(([trackingNumber, carrier]) => ({
    trackingNumber,
    carrier,
  }));
}

// ---------- AMZL email parsing ----------
//
// Amazon Logistics has no tracking API, but delivery-progress emails
// from Amazon are highly structured. The phrases below are stable
// across their template variants and map cleanly onto our status
// enum. Caller passes in the parsed-text body (Claude already strips
// HTML upstream).

const AMZL_RULES = [
  { re: /your package was delivered|has been delivered/i, status: "Delivered" },
  { re: /your package is\s+(\d+)\s+stops?\s+away/i, status: "Out for Delivery", noteFromGroup: 1, noteTemplate: "X stops away" },
  { re: /will be delivered today|arriving today/i, status: "Out for Delivery" },
  { re: /your delivery has been attempted|we missed you/i, status: "Delivery Attempted" },
  { re: /shipped|on the way|out for delivery/i, status: "Out for Delivery" },
];

export function parseAmazonDeliveryEmail(text) {
  if (!text || typeof text !== "string") return null;
  for (const rule of AMZL_RULES) {
    const m = text.match(rule.re);
    if (m) {
      let note = null;
      if (rule.noteFromGroup) {
        note = (rule.noteTemplate || "").replace("X", m[rule.noteFromGroup]);
      }
      return { status: rule.status, note };
    }
  }
  return null;
}

// ---------- FlightAware ----------

// Flight number — IATA-ish prefix + 1-4 digits. Examples: AA123,
// UA456, B6234. The pattern is loose enough to misfire on prose
// (e.g. "B6" in a date range), so the extractor runs ONLY on travel-
// typed signals and uses word boundaries to filter shortest noise.
const FLIGHT_NUMBER_RE = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\d{1,4}\b/g;

export function extractFlightNumbers(text) {
  if (!text || typeof text !== "string") return [];
  const found = new Set();
  FLIGHT_NUMBER_RE.lastIndex = 0;
  let m;
  while ((m = FLIGHT_NUMBER_RE.exec(text)) !== null) {
    found.add(m[0].toUpperCase());
  }
  return [...found];
}

const FLIGHT_STATUS_MAP = [
  { re: /landed|arrived/i, status: "Landed" },
  { re: /in.?air|en.?route|airborne|departed/i, status: "In Flight" },
  { re: /delay/i, status: "Delayed" },
  { re: /scheduled|on.?time/i, status: "On Time" },
  { re: /cancelled|canceled/i, status: "Cancelled" },
];

function normalizeFlightStatus(raw) {
  if (!raw) return "On Time";
  for (const { re, status } of FLIGHT_STATUS_MAP) {
    if (re.test(raw)) return status;
  }
  return "On Time";
}

// AviationStack flight_status values map directly onto our flight
// status enum. Checked before the regex normalizer so "active" doesn't
// fall through to the "On Time" default.
const AVIATIONSTACK_STATUS_MAP = {
  scheduled: "On Time",
  active: "In Flight",
  landed: "Landed",
  cancelled: "Cancelled",
  incident: "Delayed",
  diverted: "Delayed",
};

export async function trackFlight(flightNumber, departureDate) {
  const apiKey = process.env.AVIATIONSTACK_API_KEY;
  if (!apiKey) return null;
  if (!flightNumber) return null;
  // Free tier is HTTP-only (HTTPS requires paid plan) and capped at
  // 100 req/mo — the cron's tiered refresh keeps us well under that
  // for a single household running one or two travel signals at a
  // time. The flight_date filter also requires a paid plan, so we
  // pull whatever results AviationStack returns for the IATA code
  // and pick the row whose scheduled departure is closest to the
  // signal's eta.
  const url = `http://api.aviationstack.com/v1/flights?access_key=${encodeURIComponent(
    apiKey
  )}&flight_iata=${encodeURIComponent(flightNumber)}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`[aviationstack] ${flightNumber} → ${res.status}`);
    return null;
  }
  const data = await res.json();
  // AviationStack also returns an `error` object on quota/key
  // failures with HTTP 200 — surface that as a null result so the
  // cron skips this signal until next run.
  if (data?.error) {
    console.warn(
      `[aviationstack] api error: ${data.error.code || "?"} ${
        data.error.message || data.error.info || ""
      }`
    );
    return null;
  }
  const flights = Array.isArray(data?.data) ? data.data : [];
  if (flights.length === 0) return null;

  // Pick the flight whose scheduled departure is closest to the
  // signal's eta. Without that anchor, default to the first row.
  let target = flights[0];
  if (departureDate) {
    const want = Date.parse(departureDate);
    if (!isNaN(want)) {
      let bestDelta = Infinity;
      for (const f of flights) {
        const t = Date.parse(f?.departure?.scheduled || 0);
        if (isNaN(t)) continue;
        const d = Math.abs(t - want);
        if (d < bestDelta) { bestDelta = d; target = f; }
      }
    }
  }

  const dep = target?.departure || {};
  const arr = target?.arrival || {};
  const schedOut = dep.scheduled || null;
  const estOut = dep.actual || dep.estimated || schedOut;
  const schedIn = arr.scheduled || null;
  const estIn = arr.actual || arr.estimated || schedIn;
  // Delay in minutes — AviationStack provides departure.delay
  // directly (in minutes) when available; derive from
  // scheduled-vs-estimated otherwise.
  let delayMinutes = null;
  if (typeof dep.delay === "number") {
    delayMinutes = dep.delay;
  } else if (schedOut && estOut) {
    delayMinutes = Math.round((Date.parse(estOut) - Date.parse(schedOut)) / 60000);
  }

  const rawStatus = String(target.flight_status || "").toLowerCase();
  const mappedStatus = AVIATIONSTACK_STATUS_MAP[rawStatus] || normalizeFlightStatus(rawStatus);

  return {
    flightNumber: target?.flight?.iata || flightNumber,
    status: mappedStatus,
    scheduledDeparture: schedOut,
    estimatedDeparture: estOut,
    scheduledArrival: schedIn,
    estimatedArrival: estIn,
    departureGate: dep.gate || null,
    arrivalGate: arr.gate || null,
    delayMinutes,
  };
}
