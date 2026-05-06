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
// branch is separate because the leading "%" isn't a word character.
const PROMO_REGEX = /\b(?:sale|off|discount|promo|deal|offer|coupon|shop now|limited time|exclusive|unsubscribe)\b|%\s*off/i;
const PROMO_SENDER_PREFIXES = ["noreply", "no-reply", "marketing", "promotions"];

function senderLocalPart(from) {
  const match = from.match(/<([^>]+)>/) || from.match(/(\S+@\S+)/);
  if (!match) return "";
  return match[1].toLowerCase().split("@")[0];
}

// Runs after Claude parses the email but before we write the signal. Returns
// a reason string when the signal should be discarded, or null to keep.
function postParseDiscardReason(signal, from) {
  // All-Unknown shell: Claude couldn't extract anything actionable. Storing
  // these clutters the ring with phantom signals.
  if (
    signal.type === "unknown" &&
    signal.status === "Unknown" &&
    !signal.eta &&
    !signal.trackingNumber
  ) {
    return "all-unknown";
  }
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
  return null;
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
  "type": "package, food, grocery, service, reservation, travel, or unknown"
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

      await redis.lpush(`household:${householdId}:signals`, JSON.stringify(signal));
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
