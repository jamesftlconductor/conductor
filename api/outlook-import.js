// Microsoft Graph API import — parallel to api/import.js (Gmail) but
// fed from /me/messages instead of Gmail's search endpoint. Calendar
// events come from /me/calendarView and write into the same
// household:{id}:calendar:{userId} per-user key the Google calendar
// path uses, so the multi-driver merge in api/calendar-loader.js
// folds them in automatically.
//
// v1 scope: subject + from + receivedDateTime + body → Claude Haiku
// classifier → same-sender merge + semantic dedup → LPUSH to :signals.
// Financial branch, AMZL parsing, carrier tracking, recurring pattern
// detection, and thread detection are NOT included in this initial
// build — they live in api/import.js's per-message loop and would
// require either a refactor or a duplicate. The minimal pipeline
// covers the dominant case (work-email order confirmations / hotel
// bookings / appointment confirmations) and leaves room to layer in
// the extras after the integration is live.

import { Redis } from "@upstash/redis";
import { getValidOutlookToken } from "./outlook-token.js";
import { writeCommonsRecord, logAutoResolvedMemory } from "./commons.js";
import { extractSignalLocation } from "./places.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const GRAPH = "https://graph.microsoft.com/v1.0";

// Confidence score 1-10. Mirrors signalConfidenceScore from import.js
// for now — keep in sync if that file's scoring changes.
function signalConfidenceScore(s) {
  let score = 1;
  if (s.eta) score += 3;
  if (s.trackingNumber) score += 2;
  if (s.confirmationNumber) score += 2;
  if (s.description && s.description.length > 20) score += 1;
  if (s.sender) score += 1;
  if (s.confidence === "high") score += 2;
  else if (s.confidence === "medium") score += 1;
  return Math.min(10, score);
}

function normalizeSender(name) {
  if (!name) return "";
  return String(name).toLowerCase().replace(/\s+/g, " ").trim();
}

// Stable content key for dedup. Mirrors the Gmail import shape so
// Outlook-derived signals dedup against Gmail-derived ones for the
// same underlying event (a hotel booking confirmation often arrives
// in both inboxes when the user forwards or BCCs).
function contentFingerprint(signal) {
  const parts = [
    signal.type || "",
    normalizeSender(signal.sender),
    (signal.description || "").toLowerCase().trim().slice(0, 60),
    signal.eta || "",
  ];
  return parts.join("|");
}

// HTML → plain text. Outlook bodies arrive as `<html><body>...</body></html>`
// with inline CSS. We don't need a full parser; stripping tags and
// collapsing whitespace is enough to feed the classifier.
function htmlToText(html) {
  if (!html) return "";
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function classifyMessage(subject, from, emailText) {
  // Same Haiku prompt + parsing shape as the Gmail path. Kept here
  // inline (rather than importing from import.js) so a future shift
  // in the Gmail prompt doesn't silently change Outlook's parsing.
  // When the two need to converge, extract this to a shared helper.
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
  "description": "the most specific human-readable summary possible (see rules below)",
  "carrier": "UPS, FedEx, USPS, DHL, or Unknown",
  "trackingNumber": null,
  "status": "In Transit, Delivered, Out for Delivery, Delayed, or Unknown",
  "eta": "date or null",
  "sender": "who sent it",
  "type": "package, food, grocery, service, reservation, travel, or unknown",
  "notes": "any additional context about timing, location, or special instructions (or null)",
  "confidence": "high, medium, or low — how confident you are in the extracted data"
}

Description must be as specific as possible.
Include: what the item is, quantity if known, specific amount if financial,
scheduled time if appointment, specific product name if identifiable.
Examples:
GOOD: 'Amazon — Lightly Lined Underwire Bra + 2 items, arriving Thursday'
BAD: 'Amazon package'
GOOD: 'Netflix Standard Plan — $15.49 renews July 3'
BAD: 'Netflix renewal'
GOOD: 'Dr. Sarah Martinez annual checkup — Cleveland Clinic, Tuesday 2pm'
BAD: 'Doctor appointment'
GOOD: 'Air Pros USA HVAC tune-up — scheduled Tuesday 2pm-4pm'
BAD: 'HVAC service'
Be specific. Users recognize items by their actual names, not categories.

Subject: ${subject}
From: ${from}

Email body:
${(emailText || "").substring(0, 1000)}`,
      }],
    }),
  });
  const parseData = await parseResponse.json();
  const text = parseData?.content?.[0]?.text || "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  let signal;
  try {
    signal = JSON.parse(clean);
  } catch {
    return null;
  }
  signal.confidence = signalConfidenceScore(signal);
  return signal;
}

export async function runOutlookImport(userId) {
  if (!userId) throw new Error("No userId provided");
  const accessToken = await getValidOutlookToken(userId);
  const householdId = (await redis.get(`user:${userId}:household`)) || userId;
  const importedSetKey = `household:${householdId}:importedMessages`;
  const fingerprintSetKey = `household:${householdId}:contentFingerprints`;
  const signalsKey = `household:${householdId}:signals`;

  // Sync window — last 30 days first run, otherwise resume from the
  // stored cursor. Graph filters with $filter=receivedDateTime ge ...
  // (ISO 8601, UTC).
  const lastSyncRaw = await redis.get(`user:${userId}:outlookLastSync`);
  const thirtyDaysAgoIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const sinceIso = lastSyncRaw || thirtyDaysAgoIso;

  const msgUrl =
    `${GRAPH}/me/messages?` +
    `$filter=${encodeURIComponent(`receivedDateTime ge ${sinceIso}`)}` +
    `&$select=${encodeURIComponent("id,subject,from,receivedDateTime,body")}` +
    `&$top=50` +
    `&$orderby=${encodeURIComponent("receivedDateTime desc")}`;

  const msgResponse = await fetch(msgUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!msgResponse.ok) {
    const detail = await msgResponse.text();
    throw new Error(`Graph /me/messages failed: ${msgResponse.status} ${detail.slice(0, 200)}`);
  }
  const msgJson = await msgResponse.json();
  const messages = Array.isArray(msgJson?.value) ? msgJson.value : [];

  let imported = 0;
  let latestReceived = sinceIso;

  for (const msg of messages) {
    try {
      // Track the newest message we've seen so the cursor advances
      // even when nothing gets imported (avoids re-scanning the same
      // 50 messages each run).
      if (msg.receivedDateTime && msg.receivedDateTime > latestReceived) {
        latestReceived = msg.receivedDateTime;
      }

      // Dedup by messageId. The set is shared with Gmail's
      // importedMessages — Outlook messageIds are different formats
      // so collisions are essentially impossible, and the shared key
      // gives us cross-driver dedup if a Gmail-forwarded email later
      // shows up via Outlook (or vice versa).
      if (await redis.sismember(importedSetKey, msg.id)) continue;

      const subject = msg.subject || "";
      const fromAddr = msg.from?.emailAddress?.address || "";
      const fromName = msg.from?.emailAddress?.name || "";
      const from = fromName ? `${fromName} <${fromAddr}>` : fromAddr;
      const rawBody = msg.body?.content || "";
      const emailText = msg.body?.contentType === "html"
        ? htmlToText(rawBody)
        : rawBody;

      const signal = await classifyMessage(subject, from, emailText);
      if (!signal) {
        console.log(`[outlook] classification returned null for "${subject.slice(0, 60)}"`);
        await redis.sadd(importedSetKey, msg.id);
        continue;
      }

      // Quality gate — same threshold as Gmail (confidence >= 5).
      if (typeof signal.confidence !== "number" || signal.confidence < 5) {
        console.log(`[outlook] low-confidence signal dropped: "${subject.slice(0, 60)}"`);
        await redis.sadd(importedSetKey, msg.id);
        continue;
      }
      // Drop unknowns + obvious noise.
      if (signal.type === "unknown" && !signal.eta && !signal.trackingNumber) {
        await redis.sadd(importedSetKey, msg.id);
        continue;
      }
      // Stale-eta skip — same 7-day-backward window Gmail uses.
      const etaMs = signal.eta ? Date.parse(signal.eta) : NaN;
      if (!isNaN(etaMs) && etaMs < Date.now() - 7 * 24 * 60 * 60 * 1000) {
        await redis.sadd(importedSetKey, msg.id);
        continue;
      }

      signal.id = Date.now() + imported;
      signal.messageId = msg.id;
      signal.lastUpdate = new Date().toLocaleString();
      signal.userId = userId;
      signal.source = "outlook";
      signal.receivedAt = msg.receivedDateTime;
      signal.createdAt = Date.now();

      // Content-fingerprint dedup against the shared set. If we've
      // already seen the same {type, sender, description-prefix, eta}
      // tuple from either driver, skip.
      const fp = contentFingerprint(signal);
      if (await redis.sismember(fingerprintSetKey, fp)) {
        console.log(`[outlook] fingerprint dup: "${signal.description?.slice(0, 60)}"`);
        await redis.sadd(importedSetKey, msg.id);
        continue;
      }

      // Same-sender merge — abbreviated version of the Gmail path. If
      // a same-sender + same-type signal in incoming/active state
      // already exists with no ETA/tracking and the new one supplies
      // either, merge into it rather than creating a duplicate.
      const recentRaw = await redis.lrange(signalsKey, 0, 99);
      const recent = recentRaw
        .map((r) => { try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } })
        .filter(Boolean);
      const newSenderNorm = normalizeSender(signal.sender);
      let merged = false;
      if (newSenderNorm) {
        for (let i = 0; i < recent.length; i++) {
          const ex = recent[i];
          if (!ex || ex.type !== signal.type) continue;
          if (ex.state && ex.state !== "incoming" && ex.state !== "active") continue;
          if (normalizeSender(ex.sender) !== newSenderNorm) continue;

          const addsTracking = !!signal.trackingNumber && !ex.trackingNumber;
          const addsEta = !!signal.eta && !ex.eta;
          const longerDesc = (signal.description || "").length > (ex.description || "").length + 20;
          if (!addsTracking && !addsEta && !longerDesc) continue;

          const mergedRecord = {
            ...ex,
            description: longerDesc ? signal.description : ex.description,
            eta: addsEta ? signal.eta : ex.eta,
            trackingNumber: addsTracking ? signal.trackingNumber : ex.trackingNumber,
            source: "merged",
            lastUpdate: new Date().toLocaleString(),
            mergedFromMessageIds: Array.isArray(ex.mergedFromMessageIds)
              ? [...ex.mergedFromMessageIds, msg.id]
              : (ex.messageId ? [ex.messageId, msg.id] : [msg.id]),
          };
          await redis.lset(signalsKey, i, JSON.stringify(mergedRecord));
          await redis.sadd(fingerprintSetKey, fp);
          await redis.sadd(importedSetKey, msg.id);
          console.log(
            `[outlook] Merged signal from ${signal.sender} — updated existing ${ex.id} rather than creating duplicate`
          );
          imported++;
          merged = true;
          break;
        }
      }
      if (merged) continue;

      // Location enrichment for service/appointment/reservation types
      // — credential-gated via places.js. Same shape Gmail uses.
      if (
        (signal.type === "service" ||
          signal.type === "appointment" ||
          signal.type === "reservation") &&
        !signal.location
      ) {
        try {
          const place = await extractSignalLocation(signal.description, signal.sender);
          if (place) signal.location = place;
        } catch (err) {
          console.warn("[outlook] places lookup error:", err?.message || err);
        }
      }

      await redis.lpush(signalsKey, JSON.stringify(signal));
      await redis.sadd(fingerprintSetKey, fp);
      await redis.sadd(importedSetKey, msg.id);
      imported++;
      console.log(`[outlook] imported signal: "${signal.description?.slice(0, 60)}"`);
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.error("[outlook] message error:", err?.message || err);
    }
  }

  // Calendar slice — write to the per-user key so the multi-driver
  // calendar-loader can merge with Google calendar events. v1: 30-
  // day forward window only. Body content is dropped; we keep
  // subject/start/end/location/organizer.
  try {
    const calStart = new Date().toISOString();
    const calEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const calUrl =
      `${GRAPH}/me/calendarView?` +
      `startDateTime=${encodeURIComponent(calStart)}` +
      `&endDateTime=${encodeURIComponent(calEnd)}` +
      `&$select=${encodeURIComponent("id,subject,start,end,location,organizer")}` +
      `&$top=100`;
    const calRes = await fetch(calUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: "outlook.timezone=\"UTC\"",
      },
    });
    if (calRes.ok) {
      const calJson = await calRes.json();
      const events = (Array.isArray(calJson?.value) ? calJson.value : []).map((e) => ({
        id: `outlook_${e.id}`,
        title: e.subject || "Untitled",
        start: e.start?.dateTime ? `${e.start.dateTime}Z` : null,
        end: e.end?.dateTime ? `${e.end.dateTime}Z` : null,
        location: e.location?.displayName || null,
        organizer: e.organizer?.emailAddress?.address || null,
        userId,
        source: "outlook",
      }));
      const calKey = `household:${householdId}:calendar:${userId}`;
      // The shape Gmail/Google use here is "merged JSON array" stored
      // under the per-user key. Mirror that.
      await redis.set(calKey, JSON.stringify(events));
      console.log(`[outlook] wrote ${events.length} calendar events for ${userId}`);
    } else {
      console.warn(`[outlook] calendarView HTTP ${calRes.status}`);
    }
  } catch (err) {
    console.warn("[outlook] calendar fetch failed:", err?.message || err);
  }

  // Advance the cursor so the next run skips messages we've already
  // looked at (even when classification dropped them).
  if (latestReceived !== sinceIso) {
    await redis.set(`user:${userId}:outlookLastSync`, latestReceived);
  }
  return { imported, scanned: messages.length };
}

// Manual sync endpoint. Useful for the post-callback initial sync
// kick and for debugging — wraps runOutlookImport in a thin HTTP
// shell. Auth: the userId in the query must own outlookTokens; this
// is fine for v1 since runOutlookImport throws if no tokens exist.
export default async function handler(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    const result = await runOutlookImport(userId);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("[outlook-import] handler error:", err);
    return res.status(500).json({ error: err?.message || "outlook import failed" });
  }
}
