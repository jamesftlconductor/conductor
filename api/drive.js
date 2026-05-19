// Google Drive document discovery — searches a user's Drive for
// household-relevant PDFs (insurance, warranty, lease, registration,
// mortgage, etc.) and produces a candidate list for the reveal +
// future scan extraction.
//
// IMPORTANT scope note. The current Conductor OAuth flow asks for:
//   gmail.readonly  +  calendar.readonly  +  email  +  profile
// Drive search requires:
//   drive.readonly
// which is NOT in the scopes our consent screen advertises. Until
// that scope is added (which forces re-verification with Google),
// runDriveDocumentScan returns { skipped: 'no drive scope' } when
// the user's token lacks Drive access. The function is wired so the
// integration activates the moment the scope lands — no further
// code change needed.
//
// Per spec, this v1 stops at *discovery*: returns a candidate list
// of file ids + filenames + sizes. Actual content extraction (PDF
// → Claude Vision → vault item) lives behind a follow-on extension
// of api/scan.js to accept PDF payloads (currently image-only).

import { Redis } from "@upstash/redis";
import { getValidToken } from "./refresh.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const MAX_FILES_PER_QUERY = 10;
const MAX_TOTAL_FILES = 50;
// 10MB cap — household docs are usually a few hundred KB; larger
// files tend to be unrelated backups or scanned-book PDFs.
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const SEARCH_TERMS = [
  "insurance",
  "warranty",
  "lease",
  "registration",
  "mortgage",
  "deed",
  "title",
  "contract",
  "agreement",
  "prescription",
  "medical records",
  "tax",
];

async function probeDriveAccess(accessToken) {
  // A 1-result list against /files is the cheapest way to detect
  // whether the token carries drive.readonly. Drive returns 403 with
  // a scope-mismatch error if not. We swallow the error and return
  // false rather than letting it bubble.
  const res = await fetch(`${DRIVE_API}?pageSize=1&fields=files(id)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.ok;
}

async function searchDrive(accessToken, term) {
  // q clause uses fullText match against PDFs only. The trailing
  // mimeType filter keeps the result set tight — most household
  // docs are PDFs. Larger Drive surface (Docs, Sheets, etc.) is a
  // future expansion.
  const q = `fullText contains '${term.replace(/'/g, "\\'")}' and mimeType='application/pdf'`;
  const url =
    `${DRIVE_API}?` +
    `q=${encodeURIComponent(q)}` +
    `&fields=${encodeURIComponent("files(id,name,mimeType,createdTime,size)")}` +
    `&pageSize=${MAX_FILES_PER_QUERY}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const detail = await res.text();
    console.warn(`[drive] search '${term}' ${res.status}: ${detail.slice(0, 140)}`);
    return [];
  }
  const json = await res.json();
  return Array.isArray(json?.files) ? json.files : [];
}

export async function runDriveDocumentScan(userId) {
  if (!userId) throw new Error("No userId provided");

  // Opt-in gate. The mobile Settings → "What Conductor Sees" toggle
  // writes this flag so users who haven't actively opted in to Drive
  // scanning don't have their files probed. Defaults to disabled.
  const enabled = await redis.get(`user:${userId}:driveScanEnabled`);
  if (enabled !== "true" && enabled !== true) {
    return { skipped: "drive scanning not enabled", documentsScanned: 0, vaultItemsFound: 0 };
  }

  let accessToken;
  try {
    accessToken = await getValidToken(userId);
  } catch (err) {
    return { skipped: `no Google token: ${err?.message}`, documentsScanned: 0, vaultItemsFound: 0 };
  }

  const hasScope = await probeDriveAccess(accessToken);
  if (!hasScope) {
    // The OAuth scope set on this app's consent screen hasn't been
    // expanded to include drive.readonly yet. Surface as a skip so
    // the worker continues; the reveal shows 0 documents until the
    // scope is added + the user re-consents.
    return {
      skipped: "no drive.readonly scope — user must re-consent after OAuth scope expansion",
      documentsScanned: 0,
      vaultItemsFound: 0,
    };
  }

  const householdId = (await redis.get(`user:${userId}:household`)) || userId;

  // Dedup across searches: a file matching multiple terms only counts
  // once. Keyed by Drive's stable file id.
  const seen = new Map();
  const docTypes = new Map();
  for (const term of SEARCH_TERMS) {
    if (seen.size >= MAX_TOTAL_FILES) break;
    const files = await searchDrive(accessToken, term);
    for (const f of files) {
      if (seen.has(f.id)) continue;
      const sizeBytes = Number(f.size) || 0;
      if (sizeBytes > MAX_FILE_BYTES) continue;
      seen.set(f.id, { ...f, matchedTerms: [term] });
      docTypes.set(term, (docTypes.get(term) || 0) + 1);
      if (seen.size >= MAX_TOTAL_FILES) break;
    }
    // Throttle — Drive search is rate-limited at the per-user level,
    // and 12 sequential searches without a breather can trip a 429.
    await new Promise((r) => setTimeout(r, 200));
  }

  const candidates = [...seen.values()];

  // Stash the candidate list so the (eventual) content-scan worker
  // can pick up where this discovery pass left off. 14d TTL — same
  // window the contact candidates use.
  try {
    if (candidates.length > 0) {
      await redis.set(
        `household:${householdId}:driveDocCandidates`,
        JSON.stringify(candidates),
        { ex: 14 * 24 * 60 * 60 }
      );
    }
  } catch (err) {
    console.warn("[drive] candidates write failed:", err?.message || err);
  }

  console.log(
    `[drive] ${householdId}: ${candidates.length} candidate PDFs across ${docTypes.size} categories`
  );

  return {
    documentsScanned: candidates.length,
    // Vault items aren't created in this v1 — discovery only.
    // The follow-on PDF-aware scan step (api/scan.js extension)
    // will turn candidates into vault items with confirmed:false.
    vaultItemsFound: 0,
    documentTypes: Object.fromEntries(docTypes),
  };
}

export default async function handler(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    const result = await runDriveDocumentScan(userId);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("[drive] handler error:", err);
    return res.status(500).json({ error: err?.message || "drive document scan failed" });
  }
}
