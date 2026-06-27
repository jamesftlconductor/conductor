// IMAP universal connector. Covers the providers Conductor can't
// reach through OAuth: iCloud (no consumer API), Yahoo (deprecating
// OAuth for third parties), generic IMAP-only hosts. The Outlook
// preset is a fallback path — preferred is OAuth via api/outlook.
//
// Connection config is encrypted with AES-256-CBC using
// ENCRYPTION_KEY (hex string, 64 chars = 32 bytes) and stored at
// user:{userId}:imapConfig.
//
// IMPORTANT: imap-simple is a CommonJS module with a runtime peer
// requirement on node-imap. It must be in package.json and installed
// at deploy time. The module is imported lazily inside runImapImport
// so the rest of the API surface doesn't blow up if the dep is
// missing during a partial deploy.

import crypto from "node:crypto";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ---------- AES-256-CBC password vault ----------
//
// CBC was chosen over GCM because the iv is fixed-length and the
// stored ciphertext shape is portable. Each call generates a fresh
// random 16-byte IV; the result is stored as "iv:ciphertext" (both
// hex-encoded). ENCRYPTION_KEY must be a 64-character hex string —
// generate with `openssl rand -hex 32`. Throws on missing/invalid key.

function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY not set");
  // Accept either hex (64 chars) or raw 32-byte UTF-8 (less common).
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  const buf = Buffer.from(raw, "utf-8");
  if (buf.length === 32) return buf;
  throw new Error("ENCRYPTION_KEY must be 64-char hex (or 32 raw bytes)");
}

export function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf-8"), cipher.final()]);
  return `${iv.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decrypt(payload) {
  if (typeof payload !== "string" || !payload.includes(":")) {
    throw new Error("decrypt: malformed payload");
  }
  const key = getKey();
  const [ivHex, ctHex] = payload.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const ct = Buffer.from(ctHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plain.toString("utf-8");
}

// ---------- Provider presets ----------
//
// Connection details for the common app-specific-password providers.
// Users on iCloud / Yahoo can't OAuth — they generate an app password
// in their account security settings and paste it into the mobile
// form. The 'custom' branch in handleImapConnect accepts user-
// supplied host/port for self-hosted or niche providers.

export const IMAP_PRESETS = {
  icloud:  { host: "imap.mail.me.com",         port: 993, tls: true, label: "iCloud" },
  yahoo:   { host: "imap.mail.yahoo.com",      port: 993, tls: true, label: "Yahoo Mail" },
  outlook: { host: "outlook.office365.com",    port: 993, tls: true, label: "Outlook (IMAP fallback)" },
  gmail:   { host: "imap.gmail.com",           port: 993, tls: true, label: "Gmail (IMAP fallback)" },
};

// ---------- Connection validation ----------
//
// Used by /api/signals?type=imap-connect to verify credentials BEFORE
// persisting the encrypted password. Connects, opens INBOX, closes,
// returns true on success. Bubbles up the underlying error message
// (sanitized) on failure so the mobile form can surface "wrong
// password" vs. "host unreachable".

export async function validateImapConnection({ host, port, user, password, tls = true }) {
  const { default: imaps } = await import("imap-simple");
  const config = {
    imap: {
      user,
      password,
      host,
      port: port || 993,
      tls,
      authTimeout: 10000,
      tlsOptions: { rejectUnauthorized: true },
    },
  };
  let connection = null;
  try {
    connection = await imaps.connect(config);
    await connection.openBox("INBOX");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err?.message || String(err)).slice(0, 240) };
  } finally {
    try { connection?.end(); } catch { /* ignore */ }
  }
}

// ---------- Importer ----------
//
// runImapImport(userId): connects, fetches messages SINCE the last
// sync, runs each through the same minimal pipeline as Outlook
// (classify via Haiku → confidence gate → same-sender merge →
// LPUSH). Same dedup sets as Gmail/Outlook so cross-driver dups
// collapse.
//
// Per-message HEADER+TEXT fetch keeps payload size manageable. INBOX
// only (no subfolder traversal in v1).

const GRAPH_FREE_HAIKU_FALLBACK = null;

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

function contentFingerprint(signal) {
  const parts = [
    signal.type || "",
    normalizeSender(signal.sender),
    (signal.description || "").toLowerCase().trim().slice(0, 60),
    signal.eta || "",
  ];
  return parts.join("|");
}

async function classifyMessage(subject, from, emailText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return GRAPH_FREE_HAIKU_FALLBACK;
  const parseResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
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
  try { signal = JSON.parse(clean); } catch { return null; }
  signal.confidence = signalConfidenceScore(signal);
  return signal;
}

export async function runImapImport(userId) {
  if (!userId) throw new Error("No userId provided");

  const rawConfig = await redis.get(`user:${userId}:imapConfig`);
  if (!rawConfig) return { imported: 0, skipped: "no imap config" };
  const config = typeof rawConfig === "string" ? JSON.parse(rawConfig) : rawConfig;

  let password;
  try {
    password = decrypt(config.encryptedPassword);
  } catch (err) {
    return { imported: 0, error: `decrypt failed: ${err.message}` };
  }

  const { default: imaps } = await import("imap-simple");
  const householdId = (await redis.get(`user:${userId}:household`)) || userId;
  const importedSetKey = `household:${householdId}:importedMessages`;
  const fingerprintSetKey = `household:${householdId}:contentFingerprints`;
  const signalsKey = `household:${householdId}:signals`;

  const lastSyncRaw = await redis.get(`user:${userId}:imapLastSync`);
  const sinceDate = lastSyncRaw
    ? new Date(lastSyncRaw)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const imapConfig = {
    imap: {
      user: config.email,
      password,
      host: config.host,
      port: config.port || 993,
      tls: config.tls !== false,
      authTimeout: 10000,
      tlsOptions: { rejectUnauthorized: true },
    },
  };

  let connection;
  try {
    connection = await imaps.connect(imapConfig);
  } catch (err) {
    return { imported: 0, error: `connect failed: ${err.message}` };
  }

  let imported = 0;
  let latestReceived = sinceDate.toISOString();
  try {
    await connection.openBox("INBOX");
    const sinceImap = sinceDate.toUTCString();
    const messages = await connection.search(
      [["SINCE", sinceImap]],
      { bodies: ["HEADER", "TEXT"], struct: true }
    );

    for (const message of messages.slice(0, 50)) {
      try {
        // Header parts come back as separate body items; merge them
        // into a simple lookup.
        const headerPart = message.parts.find((p) => p.which === "HEADER");
        const textPart = message.parts.find((p) => p.which === "TEXT");
        const headers = headerPart?.body || {};
        const subject = (headers.subject?.[0] || "").trim();
        const from = (headers.from?.[0] || "").trim();
        const messageId = (headers["message-id"]?.[0] || message.attributes?.uid || "").trim();
        const receivedIso = message.attributes?.date
          ? new Date(message.attributes.date).toISOString()
          : null;
        if (receivedIso && receivedIso > latestReceived) latestReceived = receivedIso;

        if (!messageId) continue;
        if (await redis.sismember(importedSetKey, messageId)) continue;

        const emailText = (textPart?.body || "").toString().slice(0, 8000);
        const signal = await classifyMessage(subject, from, emailText);
        if (!signal) {
          await redis.sadd(importedSetKey, messageId);
          continue;
        }

        if (typeof signal.confidence !== "number" || signal.confidence < 5) {
          await redis.sadd(importedSetKey, messageId);
          continue;
        }
        if (signal.type === "unknown" && !signal.eta && !signal.trackingNumber) {
          await redis.sadd(importedSetKey, messageId);
          continue;
        }
        const etaMs = signal.eta ? Date.parse(signal.eta) : NaN;
        if (!isNaN(etaMs) && etaMs < Date.now() - 7 * 24 * 60 * 60 * 1000) {
          await redis.sadd(importedSetKey, messageId);
          continue;
        }

        signal.id = Date.now() + imported;
        signal.messageId = messageId;
        signal.lastUpdate = new Date().toLocaleString();
        signal.userId = userId;
        signal.source = `imap:${config.provider || "custom"}`;
        signal.receivedAt = receivedIso;
        signal.createdAt = Date.now();

        const fp = contentFingerprint(signal);
        if (await redis.sismember(fingerprintSetKey, fp)) {
          await redis.sadd(importedSetKey, messageId);
          continue;
        }

        // Same-sender merge (compact form, matches Outlook).
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
                ? [...ex.mergedFromMessageIds, messageId]
                : (ex.messageId ? [ex.messageId, messageId] : [messageId]),
            };
            await redis.lset(signalsKey, i, JSON.stringify(mergedRecord));
            await redis.sadd(fingerprintSetKey, fp);
            await redis.sadd(importedSetKey, messageId);
            imported++;
            merged = true;
            console.log(`[imap] merged signal from ${signal.sender} into ${ex.id}`);
            break;
          }
        }
        if (merged) continue;

        await redis.lpush(signalsKey, JSON.stringify(signal));
        await redis.sadd(fingerprintSetKey, fp);
        await redis.sadd(importedSetKey, messageId);
        imported++;
        console.log(`[imap] imported "${signal.description?.slice(0, 60)}"`);
        await new Promise((r) => setTimeout(r, 250));
      } catch (err) {
        console.error("[imap] message error:", err?.message || err);
      }
    }
  } finally {
    try { connection.end(); } catch { /* ignore */ }
  }

  if (latestReceived !== sinceDate.toISOString()) {
    await redis.set(`user:${userId}:imapLastSync`, latestReceived);
  }
  return { imported };
}
