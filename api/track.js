// Hourly carrier/flight tracking refresh.
//
// Cron: 30 * * * * (runs at :30, offset from /api/followup at :00 so
// the two crons don't contend on the same minute).
//
// Scans every household for signals carrying a trackingNumber (with
// state in {incoming, active}) and flight signals with extractable
// flight numbers. Skips AMZL (no API). Refresh cadence is tiered by
// proximity to ETA — closer = more frequent.
//
// Status changes fan out as push notifications via /api/notify?type=tracking.
//
// Hard cap of 100 calls per cron run to avoid API abuse / rate limits.

import { Redis } from "@upstash/redis";
import { applyTrackingUpdate } from "./import.js";
import { trackFlight, extractFlightNumbers } from "./carrier.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const BASE_URL = "https://conductor-ivory.vercel.app";

export const config = { maxDuration: 60 };

const HOUR = 60 * 60 * 1000;
const MAX_CALLS_PER_RUN = 100;

function safeJson(v) {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
}

async function listHouseholds() {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, { match: "user:*:household", count: 100 });
    cursor = next;
    if (batch?.length) keys.push(...batch);
  } while (cursor !== "0" && cursor !== 0);

  const set = new Set();
  for (const key of keys) {
    const userId = key.slice("user:".length, -":household".length);
    const hid = (await redis.get(key)) || userId;
    set.add(hid);
  }
  return [...set];
}

// Tiered refresh cadence for packages. Returns the minimum age (in
// ms) a signal's last tracking update must have before we re-poll.
// "Out for Delivery" gets the tightest window since the next event
// (delivered/attempted) is usually within the hour.
function packageRefreshAge(signal) {
  if (signal.status === "Out for Delivery") return 30 * 60 * 1000;
  const etaMs = signal.eta ? Date.parse(String(signal.eta).slice(0, 10)) : NaN;
  if (isNaN(etaMs)) return 12 * HOUR; // No ETA → low-frequency poll.
  const until = etaMs - Date.now();
  if (until < 24 * HOUR) return 1 * HOUR;
  if (until < 48 * HOUR) return 4 * HOUR;
  return 12 * HOUR;
}

// Flight signals get their own cadence — much tighter close to
// departure because gate/delay changes can flip in 5-min windows.
function flightRefreshAge(signal) {
  const depMs = signal.eta ? Date.parse(signal.eta) : NaN;
  if (isNaN(depMs)) return 2 * HOUR;
  const until = depMs - Date.now();
  if (until < 2 * HOUR) return 10 * 60 * 1000;
  if (until < 6 * HOUR) return 30 * 60 * 1000;
  return 2 * HOUR;
}

function isEligiblePackage(signal) {
  if (!signal.trackingNumber) return false;
  if (signal.carrier === "AMZL") return false;
  if (signal.state && signal.state !== "incoming" && signal.state !== "active") return false;
  const last = signal.trackingUpdatedAt ? Date.parse(signal.trackingUpdatedAt) : 0;
  const age = Date.now() - last;
  return age >= packageRefreshAge(signal);
}

function isEligibleFlight(signal) {
  if (signal.type !== "travel") return false;
  if (signal.state && signal.state !== "incoming" && signal.state !== "active") return false;
  const last = signal.flightUpdatedAt ? Date.parse(signal.flightUpdatedAt) : 0;
  const age = Date.now() - last;
  return age >= flightRefreshAge(signal);
}

async function pushTrackingNotification(householdId, signal, kind, extra) {
  let title;
  let body;
  const desc = signal.description || "Package";
  if (kind === "out-for-delivery") {
    title = "Out for delivery";
    body = `${desc} is out for delivery today.`;
  } else if (kind === "delivered") {
    title = "Delivered";
    body = `${desc} has been delivered.`;
  } else if (kind === "delayed") {
    title = "Delayed";
    body = `${desc} has been delayed.`;
  } else if (kind === "flight-delayed") {
    title = "Flight delayed";
    body = `Flight ${extra?.flightNumber || ""} is delayed ${extra?.minutes || "?"} minutes.`;
  } else {
    return;
  }
  try {
    await fetch(`${BASE_URL}/api/notify?type=tracking`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ householdId, title, body }),
    });
  } catch (err) {
    console.warn("[track] notify failed:", err?.message || err);
  }
}

function statusTransitionKind(prev, next) {
  if (prev === next) return null;
  if (next === "Delivered") return "delivered";
  if (next === "Out for Delivery") return "out-for-delivery";
  if (next === "Delayed") return "delayed";
  return null;
}

// Apply a flight-tracking result to a signal record. Mirrors
// applyTrackingUpdate from import.js but for travel signals.
async function applyFlightUpdate(householdId, signal, flightNumber) {
  const departureDate = signal.eta || null;
  let result;
  try {
    result = await trackFlight(flightNumber, departureDate);
  } catch (err) {
    console.warn(`[flight] ${flightNumber} fetch failed:`, err?.message || err);
    return null;
  }
  if (!result) return null;
  const key = `household:${householdId}:signals`;
  const raw = await redis.lrange(key, 0, -1);
  for (let i = 0; i < raw.length; i++) {
    const parsed = safeJson(raw[i]);
    if (!parsed || parsed.id !== signal.id) continue;
    const prevStatus = parsed.flightStatus || null;
    const prevDelay = parsed.flightDelayMinutes || 0;
    parsed.flightNumber = result.flightNumber;
    parsed.flightStatus = result.status;
    parsed.flightDelayMinutes = result.delayMinutes ?? 0;
    parsed.flightScheduledDeparture = result.scheduledDeparture;
    parsed.flightEstimatedDeparture = result.estimatedDeparture;
    parsed.flightScheduledArrival = result.scheduledArrival;
    parsed.flightEstimatedArrival = result.estimatedArrival;
    parsed.flightDepartureGate = result.departureGate;
    parsed.flightArrivalGate = result.arrivalGate;
    parsed.flightUpdatedAt = new Date().toISOString();
    if (result.status === "Landed" && parsed.state !== "resolved") {
      parsed.state = "resolved";
      parsed.resolvedAt = new Date().toISOString();
    }
    await redis.lset(key, i, JSON.stringify(parsed));
    return { signal: parsed, prevStatus, prevDelay, result };
  }
  return null;
}

export default async function handler(req, res) {
  const startedAt = Date.now();
  const stats = { households: 0, packages: 0, flights: 0, changed: 0, skipped: 0, errors: 0 };

  try {
    const households = await listHouseholds();
    stats.households = households.length;
    let callsRemaining = MAX_CALLS_PER_RUN;

    for (const householdId of households) {
      if (callsRemaining <= 0) break;
      let raw;
      try {
        raw = await redis.lrange(`household:${householdId}:signals`, 0, -1);
      } catch (err) {
        stats.errors++;
        continue;
      }
      const signals = (raw || []).map(safeJson).filter(Boolean);

      // Packages
      for (const signal of signals) {
        if (callsRemaining <= 0) break;
        if (!isEligiblePackage(signal)) { stats.skipped++; continue; }
        callsRemaining--;
        stats.packages++;
        try {
          const update = await applyTrackingUpdate(householdId, signal);
          if (update) {
            const kind = statusTransitionKind(update.previousStatus, update.tracking.status);
            if (kind) {
              stats.changed++;
              await pushTrackingNotification(householdId, update.signal, kind);
            }
          }
        } catch (err) {
          stats.errors++;
          console.error("[track] package error:", err?.message || err);
        }
      }

      // Flights
      for (const signal of signals) {
        if (callsRemaining <= 0) break;
        if (!isEligibleFlight(signal)) continue;
        const flightCandidates = signal.flightNumber
          ? [signal.flightNumber]
          : extractFlightNumbers(signal.description || "");
        if (flightCandidates.length === 0) continue;
        callsRemaining--;
        stats.flights++;
        try {
          const update = await applyFlightUpdate(householdId, signal, flightCandidates[0]);
          if (update) {
            const { result, prevDelay } = update;
            // Notify when delay jumps by 15+ minutes from the prior
            // snapshot OR a fresh delay first appears (prevDelay 0 →
            // any). Avoids hammering the user with every minor tweak.
            if (
              result.status === "Delayed" &&
              result.delayMinutes &&
              Math.abs(result.delayMinutes - prevDelay) >= 15
            ) {
              stats.changed++;
              await pushTrackingNotification(householdId, update.signal, "flight-delayed", {
                flightNumber: result.flightNumber,
                minutes: result.delayMinutes,
              });
            }
          }
        } catch (err) {
          stats.errors++;
          console.error("[track] flight error:", err?.message || err);
        }
      }
    }

    const elapsed = Date.now() - startedAt;
    console.log(`[track] done in ${elapsed}ms`, stats);
    return res.status(200).json({ ok: true, elapsed, stats });
  } catch (err) {
    console.error("[track] handler error:", err);
    return res.status(500).json({ error: err?.message || String(err), stats });
  }
}
