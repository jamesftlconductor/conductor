import { Redis } from "@upstash/redis";
import { Client } from "@upstash/qstash";
import { buildOnboardReveal } from "./onboard-worker.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const qstash = process.env.QSTASH_TOKEN
  ? new Client({
      token: process.env.QSTASH_TOKEN,
      // Allow region-specific endpoint override so the SDK doesn't default
      // to the wrong region's API and 404 with "user not found in region".
      ...(process.env.QSTASH_URL ? { baseUrl: process.env.QSTASH_URL } : {}),
    })
  : null;

const WORKER_URL = "https://conductor-ivory.vercel.app/api/onboard-worker";

// emails, calendar, vault, crew run in parallel as independent QStash
// messages. horizon depends on vault's output (it reads :vault) and is
// chained by the worker on vault completion — see onboard-worker.js.
const PARALLEL_JOBS = ["emails", "calendar", "vault", "crew", "inventory"];
const ALL_JOBS = [...PARALLEL_JOBS, "horizon"];

async function resolveHouseholdId(userId) {
  const hid = await redis.get(`user:${userId}:household`);
  return hid || userId;
}

function safeJson(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
}

// Reassembles the JSON shape the mobile app expects from the
// hash-backed storage. Field keys are flat ("state", "startedAt",
// "job:emails", ...) so each per-job HSET is atomic without racing
// other jobs' writes.
async function readStatus(householdId) {
  let hash;
  try {
    hash = await redis.hgetall(`household:${householdId}:onboardStatus`);
  } catch (err) {
    // Pre-deploy keys were stored as JSON strings. HGETALL on a string
    // surfaces as WRONGTYPE — fall back to GET + parse so the status
    // poll keeps working until the next onboard rewrites the key as a
    // hash (POST below DELs before HSET).
    if (String(err?.message || "").includes("WRONGTYPE")) {
      const raw = await redis.get(`household:${householdId}:onboardStatus`);
      return safeJson(raw);
    }
    throw err;
  }
  if (!hash || Object.keys(hash).length === 0) return null;
  const out = {
    state: hash.state || "unknown",
    jobs: {},
  };
  if (hash.startedAt) out.startedAt = parseInt(hash.startedAt, 10);
  if (hash.finishedAt) out.finishedAt = parseInt(hash.finishedAt, 10);
  if (hash.summary) out.summary = safeJson(hash.summary);
  for (const name of ALL_JOBS) {
    const raw = hash[`job:${name}`];
    if (raw) out.jobs[name] = safeJson(raw);
  }
  return out;
}

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  // Status poll OR reveal fetch
  if (req.method === "GET") {
    const { userId, action } = req.query;
    if (!userId) return res.status(400).json({ error: "Missing userId" });
    const householdId = await resolveHouseholdId(userId);

    if (action === "reveal") {
      const raw = await redis.get(`household:${householdId}:onboardReveal`);
      const reveal = safeJson(raw);
      return res.status(200).json({ householdId, reveal });
    }

    const status = await readStatus(householdId);
    return res.status(200).json({ householdId, status });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { userId, action } = req.body || {};
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  // Recompile the reveal payload from the current data state without
  // re-running the onboard jobs. Used to refresh the reveal after a
  // reader-shape fix lands.
  if (action === "compileReveal") {
    const householdId = await resolveHouseholdId(userId);
    try {
      const reveal = await buildOnboardReveal(householdId);
      const TTL = 48 * 60 * 60;
      await redis.set(`household:${householdId}:onboardReveal`, JSON.stringify(reveal), { ex: TTL });
      return res.status(200).json({ ok: true, householdId, reveal });
    } catch (err) {
      console.error("compileReveal failed:", err);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  }

  try {
    const householdId = await resolveHouseholdId(userId);

    // Wipe any prior status (which may be in the old JSON-string shape)
    // and write fresh hash fields. All five jobs start as "pending"; the
    // four parallel jobs flip to "running" when QStash delivers their
    // message, horizon stays "pending" until vault enqueues it.
    const statusKey = `household:${householdId}:onboardStatus`;
    await redis.del(statusKey);
    const initialFields = {
      state: "queued",
      startedAt: String(Date.now()),
    };
    for (const job of ALL_JOBS) {
      initialFields[`job:${job}`] = JSON.stringify({ state: "pending" });
    }
    await redis.hset(statusKey, initialFields);

    let queueMode = "direct";
    if (qstash) {
      try {
        await Promise.all(
          PARALLEL_JOBS.map((job) =>
            qstash.publishJSON({
              url: WORKER_URL,
              body: { userId, householdId, job },
              retries: 1,
            })
          )
        );
        queueMode = "qstash";
      } catch (qErr) {
        console.error("QStash publish failed, falling back to direct fetch:", qErr.message);
        // fall through to direct fire-and-forget
      }
    }

    if (queueMode === "direct") {
      // Fallback: 4 parallel fire-and-forget invocations. Each worker
      // invocation is a fresh function with its own 60s budget.
      for (const job of PARALLEL_JOBS) {
        fetch(WORKER_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, householdId, job }),
        }).catch(() => {});
      }
    }

    return res.status(200).json({ status: "processing", householdId, queueMode });
  } catch (error) {
    console.error("Onboard enqueue error:", error);
    return res.status(500).json({ error: "Failed to start onboard" });
  }
}
