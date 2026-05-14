// Test the vault description overlap against the bug it fixes plus
// the cases it must NOT collapse. No network, no Redis.

const VAULT_OVERLAP_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "your", "this", "that",
  "you", "are", "was", "will", "has", "have", "been",
  "insurance", "policy", "renewal", "renews", "subscription",
  "membership", "registration", "warranty", "expiration", "expires",
  "service", "plan", "notice", "reminder",
]);

function vaultDescriptionOverlap(a, b) {
  if (!a || !b) return 0;
  const toWords = (s) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !VAULT_OVERLAP_STOPWORDS.has(w))
    );
  const wordsA = toWords(a);
  const wordsB = toWords(b);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let common = 0;
  for (const w of wordsA) if (wordsB.has(w)) common++;
  return common / Math.min(wordsA.size, wordsB.size);
}

let pass = 0, fail = 0;
function assertOver(label, a, b, threshold) {
  const o = vaultDescriptionOverlap(a, b);
  const ok = o > threshold;
  if (ok) { pass++; console.log(`  ok   ${label} → ${o.toFixed(2)} > ${threshold}`); }
  else    { fail++; console.log(`  FAIL ${label} → got ${o.toFixed(2)}, want > ${threshold}`); }
}
function assertUnder(label, a, b, threshold) {
  const o = vaultDescriptionOverlap(a, b);
  const ok = o <= threshold;
  if (ok) { pass++; console.log(`  ok   ${label} → ${o.toFixed(2)} <= ${threshold}`); }
  else    { fail++; console.log(`  FAIL ${label} → got ${o.toFixed(2)}, want <= ${threshold}`); }
}

console.log("\n--- vaultDescriptionOverlap ---\n");
console.log("Cases that MUST dedup (overlap > 0.5):");

assertOver(
  "Health Tech Nerds bug (the case that surfaced this fix)",
  "Health Tech Nerds subscription renewal",
  "Health Tech Nerds Membership - Monthly subscription renewal",
  0.5
);

assertOver(
  "Apple News+ phrasing variants",
  "Apple News+ digital news subscription",
  "Apple News Plus subscription renewal",
  0.5
);

assertOver(
  "Insurance policy variants — same provider, different phrasing",
  "Allstate auto policy renewal",
  "Allstate Auto Policy - Renewal Notice",
  0.5
);

console.log("\nCases that MUST NOT dedup (overlap <= 0.5):");

assertUnder(
  "Different subscriptions from same provider",
  "Apple Developer Program membership",
  "Apple News+ subscription",
  0.5
);

assertUnder(
  "Different insurance product lines",
  "HO3 Home insurance policy renewal",
  "Personal Flood insurance policy renewal",
  0.5
);

assertUnder(
  "Different categories sharing one common word",
  "Vehicle registration renewal",
  "Domain registration renewal",
  0.5
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
