// One-shot verification for the new confidence gate + dedup rules in
// api/import.js. Helpers are mirrored here (no network, no Redis).

const OVERLAP_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "your", "this", "that",
  "you", "are", "was", "will", "has", "have", "been", "ord",
]);
const COMPANY_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "co", "company",
  "corp", "corporation", "ltd", "limited",
]);

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

let pass = 0, fail = 0;
function assertEq(label, actual, expected) {
  const ok = actual === expected;
  if (ok) { pass++; console.log(`  ok   ${label} → ${JSON.stringify(actual)}`); }
  else    { fail++; console.log(`  FAIL ${label} → got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); }
}

console.log("\n--- signalConfidenceScore ---");

assertEq(
  "rich signal (desc+sender+eta+status+type+tracking, desc>20)",
  signalConfidenceScore({
    description: "Package from Amazon arriving Friday",
    sender: "Amazon",
    eta: "2026-05-16",
    status: "In Transit",
    type: "package",
    trackingNumber: "1Z999",
  }),
  10
);

assertEq(
  "minimal viable (desc+sender, short)",
  signalConfidenceScore({
    description: "Box",
    sender: "UPS",
    type: "unknown",
    status: "Unknown",
  }),
  4
);

assertEq(
  "description only (short, below threshold)",
  signalConfidenceScore({ description: "Box" }),
  2
);

assertEq(
  "description only (long, still below threshold)",
  signalConfidenceScore({ description: "A package shipped from somewhere far away" }),
  3
);

assertEq(
  "all Unknown (below threshold)",
  signalConfidenceScore({
    description: "Unknown", sender: "Unknown",
    type: "unknown", status: "Unknown",
  }),
  0
);

assertEq("empty fields (below threshold)", signalConfidenceScore({}), 0);

assertEq(
  "ETA unparseable",
  signalConfidenceScore({ eta: "soon", type: "unknown", status: "Unknown" }),
  0
);

assertEq(
  "ETA parseable only",
  signalConfidenceScore({ eta: "2026-05-20", type: "unknown", status: "Unknown" }),
  2
);

console.log("\n--- normalizeSender (fuzzy match) ---");

assertEq("Amazon Inc",       normalizeSender("Amazon Inc"),         "amazon");
assertEq("Amazon, Inc.",     normalizeSender("Amazon, Inc."),       "amazon");
assertEq("Amazon",           normalizeSender("Amazon"),             "amazon");
assertEq("Conductor L.L.C.", normalizeSender("Conductor L.L.C."),   "conductor");
assertEq("Apple Inc.",       normalizeSender("Apple Inc."),         "apple");
assertEq("AT&T",             normalizeSender("AT&T"),               "at&t");
assertEq(
  "fuzzy match: Amazon Inc === Amazon, Inc.",
  normalizeSender("Amazon Inc") === normalizeSender("Amazon, Inc."),
  true
);

console.log("\n--- isSemanticDuplicate ---");

assertEq(
  "Rule A: same sender (suffix-stripped), eta within 5d",
  isSemanticDuplicate(
    { type: "package", sender: "Amazon Inc",   eta: "2026-05-15", description: "Headphones" },
    { type: "package", sender: "Amazon, Inc.", eta: "2026-05-18", description: "Earbuds" }
  ),
  true
);

assertEq(
  "Rule A: same sender, eta 7d apart (out of window)",
  isSemanticDuplicate(
    { type: "package", sender: "Amazon", eta: "2026-05-15", description: "X" },
    { type: "package", sender: "Amazon", eta: "2026-05-22", description: "Y" }
  ),
  false
);

assertEq(
  "Rule A: different types blocks",
  isSemanticDuplicate(
    { type: "package",     sender: "Amazon", eta: "2026-05-15" },
    { type: "reservation", sender: "Amazon", eta: "2026-05-15" }
  ),
  false
);

assertEq(
  "Rule B: high overlap, both incoming",
  isSemanticDuplicate(
    { type: "package", sender: "X", description: "Sony headphones shipment", state: "incoming" },
    { type: "package", sender: "Y", description: "Sony headphones arriving", state: "incoming" }
  ),
  true
);

assertEq(
  "Rule B: existing is rested → no dedup",
  isSemanticDuplicate(
    { type: "package", description: "Sony headphones shipment", state: "incoming" },
    { type: "package", description: "Sony headphones arriving", state: "rested" }
  ),
  false
);

assertEq(
  "Rule B: new is rested → no dedup",
  isSemanticDuplicate(
    { type: "package", description: "Sony headphones shipment", state: "rested" },
    { type: "package", description: "Sony headphones arriving", state: "incoming" }
  ),
  false
);

assertEq(
  "Rule B: no shared words → not duplicate",
  isSemanticDuplicate(
    { type: "package", description: "Diaper subscription monthly", state: "incoming" },
    { type: "package", description: "Garden hose replacement", state: "incoming" }
  ),
  false
);

assertEq(
  "Rule B: missing state on both → treated as in-motion",
  isSemanticDuplicate(
    { type: "package", description: "Sony headphones shipment" },
    { type: "package", description: "Sony headphones arriving" }
  ),
  true
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
