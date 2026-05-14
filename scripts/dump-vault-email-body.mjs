// Dump the full body of vault-matched emails so we can see WHY Claude
// returns empty. Hypothesis: these are portal-redirect stubs that
// don't carry the renewal date inline.
//
// Usage: node scripts/dump-vault-email-body.mjs <userId> <passKey>

import { readFileSync } from "fs";
const envFile = readFileSync(".env.production.local", "utf-8");
for (const line of envFile.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
  if (m) process.env[m[1]] = m[2];
}
const { getValidToken } = await import("../api/refresh.js");

const userId = process.argv[2];
const passKey = process.argv[3] || "insurance";
if (!userId) {
  console.error("usage: node scripts/dump-vault-email-body.mjs <userId> <passKey>");
  process.exit(1);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const QUERIES = {
  insurance:
    `subject:(insurance OR policy OR coverage OR premium OR deductible) ` +
    `subject:(renewal OR renews OR renewed OR expires OR expiring OR "due" OR ` +
    `"anniversary" OR "effective date")`,
  registrations:
    `subject:(registration OR license OR passport OR lease OR domain OR permit OR ` +
    `tag OR "drivers license" OR "vehicle registration" OR "business license") ` +
    `subject:(renewal OR renews OR expires OR expiring OR ends OR "expiration notice" OR ` +
    `"renewal reminder" OR "renewal notice")`,
};

const accessToken = await getValidToken(userId);
const after = Math.floor((Date.now() - 365 * DAY_MS) / 1000);
const query = `after:${after} ${QUERIES[passKey]}`;

const searchRes = await fetch(
  `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=3`,
  { headers: { Authorization: `Bearer ${accessToken}` } }
);
const searchData = await searchRes.json();
const ids = (searchData.messages || []).map((m) => m.id);
console.log(`Found ${ids.length} message(s)\n`);

for (const id of ids) {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  const headers = data.payload?.headers || [];
  const get = (n) => headers.find((h) => h.name === n)?.value || "";

  let body = "";
  const parts = data.payload?.parts || [];
  for (const p of parts) {
    if (p.mimeType === "text/plain" && p.body?.data) {
      body = Buffer.from(p.body.data, "base64").toString("utf-8");
      break;
    }
  }
  if (!body) {
    for (const p of parts) {
      for (const n of (p.parts || [])) {
        if (n.mimeType === "text/plain" && n.body?.data) {
          body = Buffer.from(n.body.data, "base64").toString("utf-8");
          break;
        }
      }
      if (body) break;
    }
  }
  if (!body && data.payload?.body?.data) {
    body = Buffer.from(data.payload.body.data, "base64").toString("utf-8");
  }

  console.log(`=== Subject: ${get("Subject")}`);
  console.log(`    From:    ${get("From")}`);
  console.log(`    Snippet: ${(data.snippet || "").substring(0, 200)}`);
  console.log(`    Body length: ${body.length} chars`);
  console.log(`    Body (first 1500 chars):`);
  console.log(body.substring(0, 1500).replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n"));
  console.log(`\n---\n`);
}
