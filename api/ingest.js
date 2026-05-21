// External signal ingestion. POST /api/ingest with an API key in the
// X-Conductor-Key header lands a new signal directly in the household's
// active list, bypassing the Gmail import path. Useful for webhook
// integrations, Zapier-style automations, or any external service that
// can push a structured event.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const VALID_SIGNAL_TYPES = new Set([
  "package", "delivery", "food", "grocery", "service", "reservation",
  "appointment", "travel", "deadline", "unknown",
]);

// Resolve which household owns this API key. Stored at
// household:{id}:apiKey (single-key-per-household for v1). We do a
// targeted SCAN over household:*:apiKey to find the match — small
// keyspace, fast in practice.
async function householdForApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== "string") return null;
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, {
      match: "household:*:apiKey",
      count: 100,
    });
    cursor = next;
    for (const key of batch || []) {
      const stored = await redis.get(key);
      if (stored === apiKey) {
        // household:{id}:apiKey → strip prefix + suffix to get the id.
        return key.slice("household:".length, -":apiKey".length);
      }
    }
  } while (cursor !== "0" && cursor !== 0);
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = req.headers["x-conductor-key"] || req.headers["X-Conductor-Key"];
  if (!apiKey) {
    return res.status(401).json({ error: "Missing X-Conductor-Key header" });
  }

  const householdId = await householdForApiKey(apiKey);
  if (!householdId) {
    return res.status(401).json({ error: "Invalid API key" });
  }

  const { type, description, sender, eta, status, metadata, shortcutId, source: sourceField } = req.body || {};

  // Validate the type enum strictly so the radar / brief / signal
  // segmenter never get an unknown enum value. If callers pass
  // something unexpected we coerce to "unknown" rather than rejecting
  // (the signal still has value — we just lose its type-specific
  // emoji/color in the UI).
  const safeType = typeof type === "string" && VALID_SIGNAL_TYPES.has(type)
    ? type : "unknown";

  if (!description || typeof description !== "string" || description.length === 0) {
    return res.status(400).json({ error: "description required" });
  }

  // Build the signal record. Shape matches imports + manual additions
  // so loadSignals, the segmenter, expiry logic, and brief pools all
  // treat it identically. confidence: 10 marks the source as
  // externally-vouched-for (vs. LLM-parsed signals which carry lower
  // confidence) — surfaces in the brief prompt as a credibility cue
  // when relevant.
  // Distinct source tags let downstream consumers (brief prompt,
  // attribution UI, dedup) differentiate raw webhook / API ingests
  // from iOS Shortcuts / IFTTT / Zapier flows. We accept the caller's
  // `source` field when it matches the allowed enum; otherwise fall
  // through to "api". Same applies for the shortcutId tag.
  const ALLOWED_SOURCES = new Set(["api", "ios_shortcut", "ifttt", "zapier", "webhook"]);
  const sourceTag = typeof sourceField === "string" && ALLOWED_SOURCES.has(sourceField)
    ? sourceField
    : "api";
  // Shortcut sources carry slightly lower confidence than direct API
  // hits — a webhook from a known integration is stronger than a
  // user-built Shortcut whose mapping we don't control.
  const sourceConfidence = sourceTag === "api" ? 10 : 7;

  const now = Date.now();
  const signal = {
    id: now,
    description: description.trim(),
    sender: typeof sender === "string" && sender.length > 0 ? sender.trim() : "API",
    eta: typeof eta === "string" && eta.length > 0 ? eta : null,
    status: typeof status === "string" && status.length > 0 ? status : null,
    type: safeType,
    source: sourceTag,
    shortcutId: typeof shortcutId === "string" ? shortcutId : null,
    confidence: sourceConfidence,
    state: "incoming",
    lastUpdate: new Date(now).toLocaleString(),
    metadata: metadata && typeof metadata === "object" ? metadata : null,
  };

  try {
    await redis.lpush(`household:${householdId}:signals`, JSON.stringify(signal));
  } catch (err) {
    console.error("[ingest] LPUSH failed:", err?.message || err);
    return res.status(500).json({ error: "Failed to store signal" });
  }

  console.log(
    `[ingest] household=${householdId} type=${safeType} sender=${signal.sender}: ${signal.description}`
  );

  return res.status(201).json({
    signalId: signal.id,
    created: true,
    household: householdId,
  });
}
