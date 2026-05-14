import { Redis } from "@upstash/redis";
import { getValidToken } from "./refresh.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Stable content key for a parsed signal. Mirrors the dedup logic used by the
// one-shot cleanup so the messageId-less legacy entries collapse against new
// imports of the same email.
function contentFingerprint(signal) {
  const tracking = signal.trackingNumber && signal.trackingNumber !== "Unknown"
    ? signal.trackingNumber
    : null;
  if (tracking) return `tracking:${tracking}`;
  const desc = (signal.description || "").trim().toLowerCase();
  const sender = (signal.sender || "").trim().toLowerCase();
  return `desc:${desc}|from:${sender}`;
}

// Word-bounded so "office" / "officer" don't trip the "off" rule. The "% off"
// branch is separate because the leading "%" isn't a word character. Phrases
// like "special buys" / "save up to" were added empirically after the patterns
// endpoint surfaced Home Depot Pro promo emails escaping the original list.
const PROMO_REGEX = /\b(?:sale|off|discount|promo|deal|offer|coupon|shop now|limited time|exclusive|unsubscribe|special buys?|save up to|promo code|shop today|now extended|free shipping|free delivery)\b|%\s*off/i;
const PROMO_SENDER_PREFIXES = ["noreply", "no-reply", "marketing", "promotions"];

// Substrings that, when present anywhere in the From header, mark the email
// as a delivery-system bounce — those carry no real signal and Claude tends
// to classify them as "service" with a "Delayed" status that defeats the
// promo-sender rule's status-bearing override. Checked against the full
// From header rather than the local-part because Mail Delivery Subsystem
// often shows up as `mailer-daemon@googlemail.com` with the friendly name
// in the display portion.
const BOUNCE_FROM_SUBSTRINGS = ["mail delivery subsystem", "mailer-daemon", "postmaster"];

function senderLocalPart(from) {
  const match = from.match(/<([^>]+)>/) || from.match(/(\S+@\S+)/);
  if (!match) return "";
  return match[1].toLowerCase().split("@")[0];
}

function isBounceFrom(from) {
  const lower = (from || "").toLowerCase();
  return BOUNCE_FROM_SUBSTRINGS.some((p) => lower.includes(p));
}

// Numeric 1-10 quality score, computed from field presence after Claude
// extracts the signal. Replaces the earlier string-confidence + all-or-
// nothing field gates with a single tunable threshold. Stored on the
// signal so dedup can use it as a tie-breaker.
function signalConfidenceScore(signal) {
  let score = 0;
  const desc = typeof signal.description === "string" ? signal.description.trim() : "";
  if (desc && desc !== "Unknown") score += 2;
  const sender = typeof signal.sender === "string" ? signal.sender.trim() : "";
  if (sender && sender !== "Unknown") score += 2;
  const etaParsed = signal.eta ? Date.parse(signal.eta) : NaN;
  if (!isNaN(etaParsed)) score += 2;
  if (signal.status && signal.status !== "Unknown") score += 1;
  if (signal.type && signal.type !== "unknown") score += 1;
  if (signal.trackingNumber) score += 1;
  if (desc.length > 20) score += 1;
  return score;
}

// Runs after Claude parses the email but before we write the signal. Returns
// a reason string when the signal should be discarded, or null to keep.
function postParseDiscardReason(signal, from) {
  // Delivery-system bounce — the cheapest, most specific signal that this
  // email carries no real arrival. Checked first so it short-circuits the
  // other gates.
  if (isBounceFrom(from)) return "bounce-sender";

  // Promo language in the description — Claude correctly extracted the words
  // but the email is marketing, not a real arrival.
  if (PROMO_REGEX.test(signal.description || "")) return "promo-keyword";
  // Promo sender — kept if status conveys real info (e.g. "Order shipped"
  // notices legitimately come from noreply@).
  const local = senderLocalPart(from);
  if (
    PROMO_SENDER_PREFIXES.some(p => local.startsWith(p)) &&
    (!signal.status || signal.status === "Unknown")
  ) {
    return "promo-sender";
  }

  // Numeric quality gate. Replaces the previous low-description /
  // missing-sender / all-unknown / low-confidence-unknown checks with a
  // single threshold against the 1-10 score. 4 is the floor where the
  // signal has enough structure to drive a brief sentence.
  if (typeof signal.confidence === "number" && signal.confidence < 4) {
    return `low-confidence-score-${signal.confidence}`;
  }

  return null;
}

// ---------- Semantic deduplication ----------

// Word-overlap ratio against the shorter set, ignoring very common short
// words. Deliberately simple — no Claude call, no embedding lookup, just
// "do these two descriptions feel like the same thing." Returns a value
// in [0, 1].
const OVERLAP_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "your", "this", "that",
  "you", "are", "was", "will", "has", "have", "been", "ord",
]);

function descriptionOverlap(a, b) {
  if (!a || !b) return 0;
  const toWords = (s) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !OVERLAP_STOPWORDS.has(w))
    );
  const wordsA = toWords(a);
  const wordsB = toWords(b);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let common = 0;
  for (const w of wordsA) if (wordsB.has(w)) common++;
  return common / Math.min(wordsA.size, wordsB.size);
}

// Strip common business-entity suffixes so "Amazon Inc", "Amazon, Inc.",
// and "Amazon" all compare equal. Used as the fuzzy sender match in
// dedup rule A.
const COMPANY_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "co", "company",
  "corp", "corporation", "ltd", "limited",
]);

function normalizeSender(s) {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/[.,]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !COMPANY_SUFFIXES.has(w))
    .join(" ")
    .trim();
}

// True when the new signal is plausibly the same as an existing one
// according to either of two rules:
//   A. Same type + fuzzy sender match (suffix-stripped, case-insensitive)
//      + ETAs within 5 days of each other.
//   B. Same type + description word overlap > 50% AND both signals are
//      still in motion (incoming or active).
function isSemanticDuplicate(newSig, existing) {
  if (newSig.type !== existing.type) return false;

  const newSender = normalizeSender(newSig.sender);
  const exSender = normalizeSender(existing.sender);
  if (newSender && exSender && newSender === exSender) {
    const newEta = newSig.eta ? Date.parse(newSig.eta) : NaN;
    const exEta = existing.eta ? Date.parse(existing.eta) : NaN;
    if (!isNaN(newEta) && !isNaN(exEta)) {
      const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
      if (Math.abs(newEta - exEta) <= FIVE_DAYS_MS) return true;
    }
  }

  const newInMotion =
    !newSig.state || newSig.state === "incoming" || newSig.state === "active";
  const exInMotion =
    !existing.state || existing.state === "incoming" || existing.state === "active";
  if (newInMotion && exInMotion) {
    const overlap = descriptionOverlap(newSig.description, existing.description);
    if (overlap > 0.5) return true;
  }

  return false;
}

function safeParseSignal(raw) {
  if (raw == null) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

export async function runImport(userId) {
  if (!userId) throw new Error("No userId provided");

  const accessToken = await getValidToken(userId);
  const householdId = (await redis.get(`user:${userId}:household`)) || userId;
  const importedSetKey = `household:${householdId}:importedMessages`;
  const fingerprintSetKey = `household:${householdId}:contentFingerprints`;

  const thirtyDaysAgo = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
  const query = `after:${thirtyDaysAgo} subject:(tracking OR shipped OR "your order" OR "order confirmed" OR "order shipped" OR delivery OR arriving OR "out for delivery" OR "return confirmed" OR reservation OR flight OR hotel OR appointment OR instacart OR doordash)`;

  const searchResponse = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=5`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  const searchData = await searchResponse.json();

  if (!searchData.messages || searchData.messages.length === 0) {
    return { imported: 0, debug: "No messages found" };
  }

  let imported = 0;

  for (const message of searchData.messages) {
    try {
      // Skip messages already imported into this household — set is populated
      // on every successful parse, so re-runs don't duplicate signals or burn
      // Anthropic calls re-classifying the same email.
      if (await redis.sismember(importedSetKey, message.id)) continue;

      const msgResponse = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=full`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const msgData = await msgResponse.json();

      const headers = msgData.payload?.headers || [];
      const subject = headers.find(h => h.name === "Subject")?.value || "";
      const from = headers.find(h => h.name === "From")?.value || "";

      let emailText = "";
      const parts = msgData.payload?.parts || [];

      for (const part of parts) {
        if (part.mimeType === "text/plain" && part.body?.data) {
          emailText = Buffer.from(part.body.data, "base64").toString("utf-8");
          break;
        }
      }

      if (!emailText) {
        for (const part of parts) {
          const nestedParts = part.parts || [];
          for (const nested of nestedParts) {
            if (nested.mimeType === "text/plain" && nested.body?.data) {
              emailText = Buffer.from(nested.body.data, "base64").toString("utf-8");
              break;
            }
          }
          if (emailText) break;
        }
      }

      if (!emailText && msgData.payload?.body?.data) {
        emailText = Buffer.from(msgData.payload.body.data, "base64").toString("utf-8");
      }

      if (!emailText) {
        emailText = `Subject: ${subject}\nFrom: ${from}`;
      }

      console.log("Parsing:", subject);

      const parseResponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 500,
          messages: [{
            role: "user",
            content: `Extract shipping/order info from this email. Return ONLY a JSON object:
{
  "description": "what the item or service is",
  "carrier": "UPS, FedEx, USPS, DHL, or Unknown",
  "trackingNumber": null,
  "status": "In Transit, Delivered, Out for Delivery, Delayed, or Unknown",
  "eta": "date or null",
  "sender": "who sent it",
  "type": "package, food, grocery, service, reservation, travel, or unknown",
  "notes": "any additional context about timing, location, or special instructions (or null)",
  "confidence": "high, medium, or low — how confident you are in the extracted data"
}

Subject: ${subject}
From: ${from}

Email body:
${emailText.substring(0, 1000)}`,
          }],
        }),
      });

      const parseData = await parseResponse.json();
      console.log("Claude response:", JSON.stringify(parseData).substring(0, 200));

      const text = parseData?.content?.[0]?.text || "{}";
      const clean = text.replace(/```json|```/g, "").trim();
      const signal = JSON.parse(clean);

      // Overwrite Claude's string confidence with the numeric 1-10 score
      // before the gate runs so the same field can drive both filtering
      // and dedup tie-breaking.
      signal.confidence = signalConfidenceScore(signal);

      // Mark as imported once parsing succeeds — covers both the lpush path
      // below and the stale-eta skip, so neither gets re-processed.
      await redis.sadd(importedSetKey, message.id);

      // Quality gate — runs after the messageId is stamped so we don't reprocess
      // the same junk on every sync. The signal is silently dropped (no list
      // write, no fingerprint write) when Claude's output is meaningless or the
      // email is clearly promotional.
      const discardReason = postParseDiscardReason(signal, from);
      if (discardReason) {
        console.log(
          `[import] discard ${discardReason}: "${(signal.description || "").slice(0, 60)}" from "${from.slice(0, 60)}"`
        );
        continue;
      }

      // Content guard catches duplicates the messageId set can't see — e.g.
      // legacy signals stored before messageId was tracked, or the same order
      // arriving via two different Gmail messages.
      const fp = contentFingerprint(signal);
      if (await redis.sismember(fingerprintSetKey, fp)) continue;

      const etaParsed = signal.eta ? Date.parse(signal.eta) : NaN;
      if (!isNaN(etaParsed) && etaParsed < Date.now() - 7 * 24 * 60 * 60 * 1000) {
        continue;
      }

      signal.id = Date.now() + imported;
      signal.messageId = message.id;
      signal.lastUpdate = new Date().toLocaleString();
      signal.userId = userId;
      signal.source = "import";

      // Semantic dedup against the last 100 stored signals. Picks up
      // cases where the messageId differs and the content fingerprint
      // differs (e.g., a follow-up email with a more specific ETA) but
      // it's clearly the same underlying real-world signal. Higher
      // confidence wins via LSET; existing equal-or-higher drops the new.
      const signalsKey = `household:${householdId}:signals`;
      const recentRaw = await redis.lrange(signalsKey, 0, 99);
      const recent = recentRaw.map(safeParseSignal).filter(Boolean);
      let dupIndex = -1;
      let dupExisting = null;
      for (let i = 0; i < recent.length; i++) {
        if (isSemanticDuplicate(signal, recent[i])) {
          dupIndex = i;
          dupExisting = recent[i];
          break;
        }
      }

      if (dupIndex !== -1) {
        // Existing signals stored before this change have no numeric
        // confidence — recompute it on the fly so the comparison is
        // apples-to-apples.
        const exConfidence =
          typeof dupExisting.confidence === "number"
            ? dupExisting.confidence
            : signalConfidenceScore(dupExisting);
        if (signal.confidence > exConfidence) {
          // New one is richer — replace the existing record in place.
          // Carry forward state/notedAt from the existing signal where
          // they exist, since those represent user intent we don't want
          // to lose.
          const merged = {
            ...signal,
            id: dupExisting.id,
            state: dupExisting.state || signal.state,
            notedAt: dupExisting.notedAt || signal.notedAt,
          };
          await redis.lset(signalsKey, dupIndex, JSON.stringify(merged));
          await redis.sadd(fingerprintSetKey, fp);
          console.log(
            `[import] Merged signal ${signal.id} into ${dupExisting.id} (confidence ${signal.confidence} > ${exConfidence}, replaced): "${(signal.description || "").slice(0, 60)}"`
          );
          imported++;
        } else {
          console.log(
            `[import] Merged signal ${signal.id} into ${dupExisting.id} (confidence ${signal.confidence} <= ${exConfidence}, kept existing): "${(signal.description || "").slice(0, 60)}"`
          );
        }
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      await redis.lpush(signalsKey, JSON.stringify(signal));
      await redis.sadd(fingerprintSetKey, fp);
      imported++;

      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      console.error("Error:", err.message);
      continue;
    }
  }

  return { imported };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: "No userId provided" });
  }

  try {
    const result = await runImport(userId);
    return res.status(200).json(result);
  } catch (error) {
    console.error("Import error:", error);
    return res.status(500).json({ error: "Import failed" });
  }
}
