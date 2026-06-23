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
    keywords: [
      // destinations / airports
      "paris", "nice", "montpellier", "cdg", "orly",
      // air
      "flight", "hotel",
      // rail
      "train", "eurostar", "tgv", "rail", "sncf",
      // travel-day artifacts
      "check-in", "boarding pass", "gate",
      // booking artifacts
      "confirmation", "voucher", "itinerary",
    ],
    etaStart: "2026-06-12T00:00:00",
    etaEnd: "2026-06-23T23:59:59",
    // etaOnly: pull ANY still-open signal whose ETA lands in the trip
    // window into the thread, regardless of type or keyword — so a leg
    // that doesn't name a city (and any household member's signals,
    // including Sarah's, since synthesis runs over the whole household
    // signal list) all fold into the one Paris trip.
    etaOnly: true,
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
    if (!w.etaOnly && !descriptionMatchesKeywords(signal.description, w.keywords)) continue;
    return w;
  }
  return null;
}

// Group a list of signals by the trip window they match. Only still-open
// signals (no state, "incoming", or "active") participate — a resolved
// flight shouldn't keep dragging a trip cluster onto the radar. Returns
// an array of { window, signals } for windows with 2+ members (a single
// signal isn't a "thread").
// ---------- generic auto-threading ----------
//
// Beyond the hand-defined TRIP_WINDOWS, automatically detect clusters of
// related signals so home renovations, medical episodes, school stretches,
// and unplanned trips all thread without manual config. Rule: 3+ still-open
// signals whose ETAs all fall inside a 14-day span, with at least one
// travel- or service-type signal anchoring the cluster. The theme label is
// generated once by Claude Haiku and cached on the thread record, so this
// stays cheap on the hot path (no model call unless membership changes).

const AUTO_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const AUTO_ANCHOR_TYPES = new Set(["travel", "flight", "service", "appointment", "reservation"]);

// Greedy ETA clustering: signals sorted ascending; a signal joins the
// current cluster while it stays within 14 days of the cluster's earliest
// ETA, otherwise it starts a new one. Returns arrays of { index, signal }.
function clusterByEta(entries) {
  const dated = entries
    .map((e) => ({ ...e, ms: e.signal.eta ? Date.parse(e.signal.eta) : NaN }))
    .filter((e) => !isNaN(e.ms))
    .sort((a, b) => a.ms - b.ms);
  const clusters = [];
  let cur = [];
  for (const e of dated) {
    if (cur.length === 0 || e.ms - cur[0].ms <= AUTO_WINDOW_MS) {
      cur.push(e);
    } else {
      clusters.push(cur);
      cur = [e];
    }
  }
  if (cur.length) clusters.push(cur);
  return clusters.filter(
    (c) =>
      c.length >= 3 &&
      c.some((e) => AUTO_ANCHOR_TYPES.has(String(e.signal.type || "").toLowerCase()))
  );
}

// Ask Haiku for a short theme label. Best-effort: returns a neutral
// fallback when the key is missing or the call fails so threading never
// blocks on the model.
async function generateThreadTheme(descriptions) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const fallback = "Related items";
  if (!apiKey) return fallback;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 24,
        messages: [
          {
            role: "user",
            content:
              "These related signals all cluster within a two-week window for one household. " +
              "Write a SHORT theme label (3-6 words, Title Case, no quotes, no trailing punctuation) " +
              "naming what they're collectively about — e.g. a trip, a home renovation, a medical " +
              "episode, a school stretch.\n\nSignals:\n" +
              descriptions.map((d) => `- ${d}`).join("\n") +
              "\n\nTheme:",
          },
        ],
      }),
    });
    const data = await res.json();
    const text = (data?.content?.[0]?.text || "")
      .trim()
      .split("\n")[0]
      .replace(/^["']|["']$/g, "")
      .replace(/[.]+$/, "")
      .trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}

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

  // ---------- auto-detected threads ----------
  // Cluster still-open signals that AREN'T already in a configured trip
  // window. 3+ within a 14-day ETA span + a travel/service anchor → thread.
  const threadedIndices = new Set();
  for (const g of groups.values()) for (const e of g.entries) threadedIndices.add(e.index);
  const candidates = [];
  for (let i = 0; i < parsed.length; i++) {
    const s = parsed[i];
    if (!s) continue;
    if (threadedIndices.has(i)) continue;
    if (s.state && s.state !== "incoming" && s.state !== "active") continue;
    if (matchTripWindow(s)) continue;
    candidates.push({ index: i, signal: s });
  }

  for (const cluster of clusterByEta(candidates)) {
    // Deterministic id from the oldest member so re-runs reuse the thread.
    const oldestId = cluster
      .map((e) => e.signal.id)
      .filter((id) => id != null)
      .sort((a, b) => Number(a) - Number(b))[0];
    if (oldestId == null) continue;
    const threadId = `auto-trip-${oldestId}`;
    const signalIds = cluster.map((e) => String(e.signal.id));

    let stampedAny = false;
    for (const e of cluster) {
      if (e.signal.threadId === threadId) continue;
      e.signal.threadId = threadId;
      e.signal.tripThread = threadId;
      await redis.lset(key, e.index, JSON.stringify(e.signal));
      stampedAny = true;
    }

    const recKey = `household:${householdId}:threads:${threadId}`;
    const existingRaw = await redis.get(recKey);
    let existing = null;
    try {
      existing = typeof existingRaw === "string" ? JSON.parse(existingRaw) : existingRaw;
    } catch {
      existing = null;
    }
    const prevIds = JSON.stringify(((existing && existing.signals) || []).slice().sort());
    const membershipChanged = !existing || prevIds !== JSON.stringify(signalIds.slice().sort());

    // Steady state: nothing changed → no model call, no write.
    if (!stampedAny && !membershipChanged && existing) {
      written.push(existing);
      continue;
    }

    // Generate the theme only when there's no cached one or membership moved.
    let theme = existing && existing.theme;
    if (!theme || membershipChanged) {
      theme = await generateThreadTheme(
        cluster.map((e) => e.signal.description || "Untitled").slice(0, 8)
      );
    }
    const latestEtaMs = cluster
      .map((e) => (e.signal.eta ? Date.parse(e.signal.eta) : NaN))
      .filter((n) => !isNaN(n))
      .sort((a, b) => b - a)[0];
    const record = {
      threadId,
      theme,
      destination: null,
      signalIds,
      summary: theme,
      primaryType: "auto",
      latestEta: latestEtaMs ? new Date(latestEtaMs).toISOString() : null,
      signals: signalIds,
      synthetic: true,
      auto: true,
      updatedAt: Date.now(),
    };
    await redis.set(recKey, JSON.stringify(record));
    console.log(
      `[trip-thread] auto ${householdId} ${threadId}: "${theme}" (${signalIds.length} signals)`
    );
    written.push(record);
  }

  return written;
}
