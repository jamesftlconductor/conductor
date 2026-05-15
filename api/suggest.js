import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// 12-hour TTL. Suggestions are tied to a signal's current state
// (status/eta); since user-edits and import updates rewrite the signal
// in place, the TTL is the upper bound on staleness even if downstream
// state changes don't bust the cache explicitly. Tap-twice within the
// window returns the same suggestion — keeps the UI stable.
const SUGGEST_TTL_SECONDS = 12 * 60 * 60;

export const config = { maxDuration: 15 };

function safeJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

async function callClaude(prompt) {
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
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Claude ${response.status}: ${errText.slice(0, 200)}`);
  }
  const data = await response.json();
  return data?.content?.[0]?.text?.trim() || "";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const {
    userId,
    signalId,
    signalType,
    description,
    sender,
    status,
    eta,
  } = req.body || {};

  if (!signalId) {
    return res.status(400).json({ error: "Missing signalId" });
  }

  const cacheKey = `signal:${signalId}:suggestion`;

  // Cache hit short-circuits the Claude call entirely. Important for
  // tap-twice and for the Hover prefetch path — both call /api/suggest
  // for the same signal and should get identical text.
  try {
    const cached = await redis.get(cacheKey);
    const parsed = safeJson(cached);
    if (parsed && typeof parsed.suggestion === "string" && parsed.suggestion.length > 0) {
      return res.status(200).json({ suggestion: parsed.suggestion, cached: true });
    }
  } catch (err) {
    // Cache read failure shouldn't block the suggestion — fall through
    // to generation and log for observability.
    console.warn(`[suggest] cache read failed for ${signalId}:`, err.message);
  }

  // Compose the prompt with whatever fields the caller provided. Missing
  // fields render as "Unknown" so Claude still has structural cues.
  const prompt = `Given this household signal, suggest one specific next action the user could take right now. Be concrete and actionable. Maximum 1 sentence. Examples:
- Package out for delivery → "Check your doorbell camera around 3pm so you can grab it before it gets left out."
- Subscription renewing in 5 days → "Log in to Health Tech Nerds and decide if you want to keep or cancel before Wednesday."
- Flight tomorrow → "Check in online now — most airlines open check-in 24 hours before departure."
- Appointment unconfirmed → "Call The Studio to confirm your appointment is still on the books."
- Registration due in 5 days → "Renew your vehicle registration at dmv.com — takes about 5 minutes online."

Signal: ${signalType || "unknown"} — ${description || "Unknown"} from ${sender || "Unknown"}. Status: ${status || "Unknown"}. ETA: ${eta || "Unknown"}.

Return one sentence only. No preamble. No explanation. Just the action.`;

  let suggestion;
  try {
    suggestion = await callClaude(prompt);
  } catch (err) {
    console.error(`[suggest] Claude call failed for ${signalId}:`, err.message);
    return res.status(502).json({ error: "Suggestion generation failed" });
  }

  // Strip surrounding quotes Claude sometimes adds despite "No preamble".
  suggestion = suggestion.replace(/^["'“”]+|["'“”]+$/g, "").trim();

  if (!suggestion) {
    return res.status(502).json({ error: "Empty suggestion returned" });
  }

  try {
    await redis.set(cacheKey, JSON.stringify({ suggestion, generatedAt: Date.now() }), {
      ex: SUGGEST_TTL_SECONDS,
    });
  } catch (err) {
    console.warn(`[suggest] cache write failed for ${signalId}:`, err.message);
  }

  return res.status(200).json({ suggestion, cached: false });
}
