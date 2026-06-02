// Trip-thread synthesis — pulls all the signals belonging to a single
// multi-leg trip (flights, hotels, intra-trip connections, possibly
// spanning several cities) under ONE stable threadId so the brief
// narrates the trip as a single item and the Hover radar clusters it
// into a single expandable dot.
//
// Why this exists alongside the generic detector in api/import.js:
// `isSameThread` groups by shared city keyword + ETA proximity, and it
// deliberately SPLITS a multi-city trip — its negative rule N1 ("both
// name cities but none overlap → different trips") keeps a Paris leg, a
// Nice leg, and a Montpellier leg in three separate threads. A trip that
// spans destinations therefore needs an explicit, window-scoped
// definition to gather every leg under one semantic threadId.
//
// Both api/signals.js (stamps threadId + persists the thread record for
// the radar) and api/brief.js (builds the authoritative TRIP THREAD
// narration block) import from here so the grouping criteria can't drift.

// Each entry defines one known trip. `keywords` match as whole words
// against the signal description; `etaStart`/`etaEnd` bound the ETA.
// A signal belongs to the trip when it matches a keyword AND its ETA
// falls inside the window.
export const TRIP_WINDOWS = [
  {
    threadId: "paris-trip-june-2026",
    theme: "Paris trip — June 12-23",
    destination: "Paris/Nice/Montpellier",
    keywords: ["paris", "nice", "montpellier", "flight", "hotel"],
    etaStart: "2026-06-12T00:00:00",
    etaEnd: "2026-06-23T23:59:59",
  },
];

function descriptionMatchesKeywords(description, keywords) {
  const lower = (description || "").toLowerCase();
  return keywords.some((k) => {
    const re = new RegExp(`\\b${k.replace(/\s+/g, "\\s+")}\\b`, "i");
    return re.test(lower);
  });
}

// Returns the TRIP_WINDOWS entry a signal belongs to, or null. Pure —
// safe to call from anywhere (brief synthesis, radar grouping).
export function matchTripWindow(signal) {
  if (!signal) return null;
  const etaMs = signal.eta ? Date.parse(signal.eta) : NaN;
  if (isNaN(etaMs)) return null;
  for (const w of TRIP_WINDOWS) {
    const startMs = Date.parse(w.etaStart);
    const endMs = Date.parse(w.etaEnd);
    if (etaMs < startMs || etaMs > endMs) continue;
    if (!descriptionMatchesKeywords(signal.description, w.keywords)) continue;
    return w;
  }
  return null;
}

// Group a list of signals by the trip window they match. Only still-open
// signals (no state, "incoming", or "active") participate — a resolved
// flight shouldn't keep dragging a trip cluster onto the radar. Returns
// an array of { window, signals } for windows with 2+ members (a single
// signal isn't a "thread").
export function groupSignalsByTrip(signals) {
  const byThread = new Map();
  for (const s of signals || []) {
    if (!s) continue;
    if (s.state && s.state !== "incoming" && s.state !== "active") continue;
    const w = matchTripWindow(s);
    if (!w) continue;
    if (!byThread.has(w.threadId)) byThread.set(w.threadId, { window: w, signals: [] });
    byThread.get(w.threadId).signals.push(s);
  }
  return [...byThread.values()].filter((g) => g.signals.length >= 2);
}

// Stamp threadId onto every member of each detected trip and persist the
// thread record at household:{id}:threads:{threadId}. Idempotent: it only
// issues Redis writes when a member is missing the threadId or the thread
// membership actually changed, so calling it on every signals GET stays
// cheap once steady-state. Returns the thread records it wrote/confirmed.
export async function synthesizeTripThreads(redis, householdId) {
  if (!redis || !householdId) return [];
  const key = `household:${householdId}:signals`;
  const raw = await redis.lrange(key, 0, -1);
  const parsed = raw.map((r) => {
    try {
      return typeof r === "string" ? JSON.parse(r) : r;
    } catch {
      return null;
    }
  });

  // Build groups carrying the source index so we can lset in place.
  const groups = new Map(); // threadId -> { window, entries: [{ index, signal }] }
  for (let i = 0; i < parsed.length; i++) {
    const s = parsed[i];
    if (!s) continue;
    if (s.state && s.state !== "incoming" && s.state !== "active") continue;
    const w = matchTripWindow(s);
    if (!w) continue;
    if (!groups.has(w.threadId)) groups.set(w.threadId, { window: w, entries: [] });
    groups.get(w.threadId).entries.push({ index: i, signal: s });
  }

  const written = [];
  for (const [threadId, g] of groups) {
    if (g.entries.length < 2) continue;

    // Stamp threadId on members that don't already carry the right one.
    let stampedAny = false;
    for (const { index, signal } of g.entries) {
      if (signal.threadId === threadId) continue;
      signal.threadId = threadId;
      await redis.lset(key, index, JSON.stringify(signal));
      stampedAny = true;
    }

    const memberSignals = g.entries.map((e) => e.signal);
    const signalIds = memberSignals.map((s) => String(s.id));
    const latestEtaMs = memberSignals
      .map((s) => (s.eta ? Date.parse(s.eta) : NaN))
      .filter((n) => !isNaN(n))
      .sort((a, b) => b - a)[0];

    const record = {
      threadId,
      // User-requested fields.
      theme: g.window.theme,
      destination: g.window.destination,
      signalIds,
      // Fields the existing thread-read endpoint (api/signals.js ?type=
      // thread) and the Hover thread expansion consume: `summary` for the
      // header, `signals` for member resolution.
      summary: g.window.theme,
      primaryType: "travel",
      latestEta: latestEtaMs ? new Date(latestEtaMs).toISOString() : null,
      signals: signalIds,
      synthetic: true,
      updatedAt: Date.now(),
    };

    const recKey = `household:${householdId}:threads:${threadId}`;
    let membershipChanged = stampedAny;
    if (!membershipChanged) {
      const existingRaw = await redis.get(recKey);
      let existing = null;
      try {
        existing = typeof existingRaw === "string" ? JSON.parse(existingRaw) : existingRaw;
      } catch {
        existing = null;
      }
      const prevIds = JSON.stringify(((existing && existing.signals) || []).slice().sort());
      membershipChanged = !existing || prevIds !== JSON.stringify(signalIds.slice().sort());
    }
    if (membershipChanged) {
      await redis.set(recKey, JSON.stringify(record));
      console.log(
        `[trip-thread] ${householdId} ${threadId}: "${g.window.theme}" (${signalIds.length} signals)`
      );
    }
    written.push(record);
  }
  return written;
}
