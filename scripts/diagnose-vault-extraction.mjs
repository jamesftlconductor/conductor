// Diagnostic for the 5-pass vault sweep zero-extraction problem.
// Runs ONE pass end-to-end for a user, prints Claude's raw response per
// email, and tallies why each was dropped:
//   - null Claude output
//   - missing renewalDate
//   - renewalDate too far in the past
//   - kept
//
// Usage: node scripts/diagnose-vault-extraction.mjs <userId> [passKey]
//   passKey defaults to "subscriptions" (most likely to have hits)

import { readFileSync } from "fs";

const envFile = readFileSync(".env.production.local", "utf-8");
for (const line of envFile.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
  if (m) process.env[m[1]] = m[2];
}

// Dynamic import AFTER env is loaded, otherwise the module-scope Redis
// client in refresh.js initializes with empty url/token.
const { getValidToken } = await import("../api/refresh.js");

const userId = process.argv[2];
const passKey = process.argv[3] || "subscriptions";
if (!userId) {
  console.error("usage: node scripts/diagnose-vault-extraction.mjs <userId> [passKey]");
  process.exit(1);
}

const DAY_MS = 24 * 60 * 60 * 1000;

const VAULT_PASSES = {
  subscriptions: {
    query:
      `subject:("subscription renewal" OR "your subscription" OR "annual plan" OR ` +
      `"monthly plan" OR "auto-renews" OR "billing date" OR "next charge" OR ` +
      `"membership renewal" OR "Amazon Prime" OR "Netflix" OR "Spotify" OR "Hulu" OR ` +
      `"Apple" OR "Disney" OR "membership fee" OR "annual fee")`,
    instructions: `Extract subscription or membership renewal. Return JSON or null:
{ "category": "subscription", "subtype": "streaming|software|membership|service|other", "description": "what this subscription is for", "provider": "company name", "renewalDate": "YYYY-MM-DD or null", "amount": "monthly or annual cost if known or null", "frequency": "monthly|annual|other", "consequence": "service stops or auto-charges", "confidence": "high|medium|low" }
Only return if this is a real subscription with a renewal date, not a promotional offer. Return null if promotional.`,
  },
  insurance: {
    query:
      `subject:(insurance OR "policy renewal" OR "policy number" OR premium OR ` +
      `"coverage" OR "State Farm" OR "Allstate" OR "Progressive" OR "Geico" OR ` +
      `"Aetna" OR "Blue Cross" OR "United Health" OR "Cigna" OR "Delta Dental" OR ` +
      `"MetLife" OR "coverage effective" OR "premium due" OR "policy anniversary")`,
    instructions: `Extract insurance policy information. Return JSON or null:
{ "category": "insurance", "subtype": "auto|home|health|dental|vision|life|renters|other", "description": "specific policy description", "provider": "company name", "renewalDate": "YYYY-MM-DD or null", "amount": "annual premium if known or null", "policyNumber": "if visible or null", "consequence": "what lapses if missed", "confidence": "high|medium|low" }
Only return if renewal date is in the future or within 60 days past. Return null if purely promotional.`,
  },
};

const pass = VAULT_PASSES[passKey];
if (!pass) {
  console.error(`unknown passKey "${passKey}". options: ${Object.keys(VAULT_PASSES).join(", ")}`);
  process.exit(1);
}

async function gmailSearch(accessToken, query, maxResults) {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  return (data.messages || []).map((m) => m.id);
}

async function fetchEmailMetadata(accessToken, messageId) {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  const headers = data.payload?.headers || [];
  const get = (name) => headers.find((h) => h.name === name)?.value || "";
  return {
    id: messageId,
    subject: get("Subject"),
    from: get("From"),
    date: get("Date"),
    snippet: data.snippet || "",
  };
}

async function callClaude(prompt, maxTokens = 300) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const j = await r.json();
  return j?.content?.[0]?.text || "";
}

function safeParseJsonText(text) {
  if (!text) return null;
  const cleaned = text.trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  if (cleaned.toLowerCase() === "null") return null;
  try { return JSON.parse(cleaned); } catch { return null; }
}

console.log(`\n=== Diagnosing vault pass "${passKey}" for ${userId} ===\n`);

const accessToken = await getValidToken(userId);
const twelveMonthsAgo = Math.floor((Date.now() - 365 * DAY_MS) / 1000);
const query = `after:${twelveMonthsAgo} ${pass.query}`;
const messageIds = await gmailSearch(accessToken, query, 8);
console.log(`Gmail returned ${messageIds.length} message IDs\n`);
if (messageIds.length === 0) process.exit(0);

const tally = { claudeNull: 0, noRenewalDate: 0, dateUnparseable: 0, dateTooOld: 0, kept: 0 };

for (const id of messageIds) {
  const email = await fetchEmailMetadata(accessToken, id);
  const prompt = `${pass.instructions}

Email:
Subject: ${email.subject}
From: ${email.from}
Date: ${email.date}
Snippet: ${(email.snippet || "").substring(0, 400)}`;

  const rawText = await callClaude(prompt, 300);
  const parsed = safeParseJsonText(rawText);

  console.log(`---`);
  console.log(`Subject: ${email.subject.substring(0, 80)}`);
  console.log(`From:    ${email.from.substring(0, 60)}`);
  console.log(`Claude raw: ${rawText.substring(0, 200).replace(/\n/g, " ")}`);

  if (!parsed || typeof parsed !== "object") {
    tally.claudeNull++;
    console.log(`Drop: claudeNull`);
    continue;
  }
  if (!parsed.renewalDate) {
    tally.noRenewalDate++;
    console.log(`Drop: noRenewalDate (parsed: ${JSON.stringify(parsed).substring(0, 150)})`);
    continue;
  }
  const ms = Date.parse(parsed.renewalDate);
  if (isNaN(ms)) {
    tally.dateUnparseable++;
    console.log(`Drop: dateUnparseable (renewalDate=${parsed.renewalDate})`);
    continue;
  }
  if (ms < Date.now() - 60 * DAY_MS) {
    tally.dateTooOld++;
    console.log(`Drop: dateTooOld (renewalDate=${parsed.renewalDate})`);
    continue;
  }
  tally.kept++;
  console.log(`KEEP: ${JSON.stringify(parsed).substring(0, 200)}`);
}

console.log(`\n=== Tally ===`);
for (const [k, v] of Object.entries(tally)) console.log(`  ${k}: ${v}`);
