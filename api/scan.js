// Vision-powered scanner. Accepts a base64 image and a scanType,
// routes to a per-type prompt against Claude Sonnet (vision), and
// returns the extracted structured data. Used by the mobile
// CameraScanner component to pre-fill various add-forms.
//
// scanType values:
//   document        — insurance / warranty / Rx / registration etc.
//                    The prompt sniffs the type from the image.
//   signal_photo    — store as a photo attachment for an existing
//                    signal; returns { photoUrl } (no extraction)
//   receipt         — extract merchant / amount / date / items
//   business_card   — extract provider contact info
//   medication_label — extract Rx fields for the crew prescription form
//   barcode         — extract tracking number / detected text
//
// All scan types except signal_photo return structured JSON in
// { extractedFields, confidence } shape. signal_photo persists the
// image to private Vercel Blob and returns a signed proxy URL.

import crypto from "node:crypto";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const VALID_TYPES = new Set([
  "document",
  "signal_photo",
  "receipt",
  "business_card",
  "medication_label",
  "barcode",
]);

// Per-type extraction prompts. Each returns either a JSON object
// matching the documented shape OR `null` when the image is
// unreadable / not the expected document. The model is instructed
// to use the structured-output tool below so we never have to
// parse free-form JSON.
const PROMPTS = {
  document: `Identify the document type in this image and extract relevant fields. Possible types:
- insurance_card: provider, policyNumber, type (auto/home/health), expiryDate, memberId, groupNumber
- warranty: productName, brand, modelNumber, serialNumber, purchaseDate, expiryDate
- prescription_label: medicationName, dosage, pharmacy, pharmacyPhone, patientName, refillDate, quantity, prescriber
- vehicle_registration: make, model, year, plateNumber, expiryDate, vin
- business_card: name, company, title, phone, email, website
- receipt: merchant, date, total, items

Set documentType to one of the strings above. Put extracted values in extractedFields with the property names listed. Set confidence to "high" / "medium" / "low" based on image clarity. If the image is unreadable or not a recognizable document, set documentType to null.`,
  receipt: `Extract receipt fields. Required: merchant, date (YYYY-MM-DD), total (number). Optional: itemized list, category. Set confidence based on image clarity. documentType is always "receipt".`,
  business_card: `Extract contact info from this business card. Required: name. Optional: company, title, phone, email, website, address. documentType is always "business_card".`,
  medication_label: `Extract prescription label fields. Required: medicationName. Optional: dosage, pharmacy, pharmacyPhone, patientName, refillDate, quantity, prescriber. documentType is always "prescription_label".`,
  barcode: `Read any tracking number, barcode, or QR-encoded text in this image. Put the raw decoded value in extractedFields.trackingNumber. documentType is "barcode".`,
};

async function resolveHouseholdId(userId) {
  if (!userId) return null;
  const hid = await redis.get(`user:${userId}:household`);
  return hid || userId;
}

function signPhotoToken(householdId, pathname, expiresAt) {
  const secret = process.env.BLOB_READ_WRITE_TOKEN || process.env.ANTHROPIC_API_KEY || "conductor-photo-secret";
  return crypto
    .createHmac("sha256", secret)
    .update(`${householdId}|${pathname}|${expiresAt}`)
    .digest("hex")
    .slice(0, 32);
}

function signedSignalPhotoUrl(householdId, pathname) {
  const expiresAt = Date.now() + 60 * 60 * 1000;
  const sig = signPhotoToken(householdId, pathname, expiresAt);
  const params = new URLSearchParams({
    type: "crew-photo-fetch", // reuses the existing proxy endpoint
    hid: householdId,
    p: pathname,
    e: String(expiresAt),
    s: sig,
  });
  return `https://conductor-ivory.vercel.app/api/signals?${params.toString()}`;
}

export const config = {
  api: {
    bodyParser: { sizeLimit: "10mb" },
  },
  maxDuration: 30,
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { userId, scanType, imageBase64, context, signalId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  if (!VALID_TYPES.has(scanType)) {
    return res.status(400).json({ error: `scanType must be one of: ${[...VALID_TYPES].join(", ")}` });
  }
  if (!imageBase64 || typeof imageBase64 !== "string") {
    return res.status(400).json({ error: "imageBase64 required" });
  }
  const b64 = imageBase64.replace(/^data:image\/[a-z]+;base64,/i, "");

  const householdId = await resolveHouseholdId(userId);
  if (!householdId) return res.status(400).json({ error: "no household" });

  // ---- signal_photo: persist to Blob and PATCH the signal ----
  if (scanType === "signal_photo") {
    if (!signalId) return res.status(400).json({ error: "signalId required for signal_photo" });
    let blobMod;
    try {
      blobMod = await import("@vercel/blob");
    } catch (err) {
      return res.status(500).json({ error: "Blob unavailable", message: err?.message });
    }
    let buffer;
    try { buffer = Buffer.from(b64, "base64"); }
    catch { return res.status(400).json({ error: "Invalid base64" }); }
    const blobKey = `signals/${householdId}/${signalId}/${Date.now()}.jpg`;
    let putResult;
    try {
      putResult = await blobMod.put(blobKey, buffer, { access: "private", contentType: "image/jpeg" });
    } catch (err) {
      console.error("[scan signal_photo] blob put failed:", err);
      return res.status(500).json({ error: "Photo upload failed", message: err?.message });
    }
    const photoUrl = signedSignalPhotoUrl(householdId, putResult?.pathname || blobKey);

    // Append to signal.photos[]
    try {
      const sigKey = `household:${householdId}:signals`;
      const raw = await redis.lrange(sigKey, 0, -1);
      for (let i = 0; i < raw.length; i++) {
        let s = null;
        try { s = typeof raw[i] === "string" ? JSON.parse(raw[i]) : raw[i]; } catch { continue; }
        if (!s) continue;
        if (s.id === signalId || String(s.id) === String(signalId)) {
          s.photos = Array.isArray(s.photos) ? s.photos : [];
          s.photos.push({ pathname: putResult?.pathname || blobKey, addedAt: new Date().toISOString() });
          await redis.lset(sigKey, i, JSON.stringify(s));
          break;
        }
      }
    } catch (err) {
      console.warn("[scan signal_photo] signal patch failed:", err?.message);
    }
    return res.status(200).json({ ok: true, photoUrl });
  }

  // ---- All other types: Claude Vision extraction ----
  const prompt = PROMPTS[scanType] || PROMPTS.document;

  let apiRes;
  try {
    apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1200,
        tools: [
          {
            name: "record_scan_result",
            description: "Record the structured extraction from this image.",
            input_schema: {
              type: "object",
              properties: {
                documentType: { type: ["string", "null"] },
                extractedFields: { type: "object" },
                confidence: { type: "string", enum: ["high", "medium", "low"] },
              },
              required: ["documentType", "extractedFields", "confidence"],
            },
          },
        ],
        tool_choice: { type: "tool", name: "record_scan_result" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: b64 },
              },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });
  } catch (err) {
    return res.status(502).json({ error: "Vision call failed", message: err?.message });
  }
  if (!apiRes.ok) {
    const errText = await apiRes.text().catch(() => "");
    console.error("[scan] Anthropic error", apiRes.status, errText.slice(0, 200));
    return res.status(502).json({ error: "Vision API error", status: apiRes.status });
  }
  const data = await apiRes.json();
  const toolBlock = (data?.content || []).find((b) => b?.type === "tool_use");
  if (!toolBlock) {
    return res.status(200).json({
      documentType: null,
      extractedFields: {},
      confidence: "low",
      note: "no tool_use block in response",
    });
  }
  const out = toolBlock.input || {};
  return res.status(200).json({
    documentType: out.documentType ?? null,
    extractedFields: out.extractedFields || {},
    confidence: out.confidence || "low",
    context: context || null,
  });
}
