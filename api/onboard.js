import { Redis } from "@upstash/redis";
import { Client } from "@upstash/qstash";

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

async function resolveHouseholdId(userId) {
  const hid = await redis.get(`user:${userId}:household`);
  return hid || userId;
}

function safeJson(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
}

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  // Status poll
  if (req.method === "GET") {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: "Missing userId" });
    const householdId = await resolveHouseholdId(userId);
    const status = safeJson(await redis.get(`household:${householdId}:onboardStatus`));
    return res.status(200).json({ householdId, status });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  try {
    const householdId = await resolveHouseholdId(userId);

    const initialStatus = {
      state: "queued",
      startedAt: Date.now(),
      jobs: {
        emails: { state: "pending" },
        calendar: { state: "pending" },
        horizon: { state: "pending" },
      },
    };
    await redis.set(`household:${householdId}:onboardStatus`, JSON.stringify(initialStatus));

    let queueMode = "direct";
    if (qstash) {
      try {
        await qstash.publishJSON({
          url: WORKER_URL,
          body: { userId, householdId },
          retries: 1,
        });
        queueMode = "qstash";
      } catch (qErr) {
        console.error("QStash publish failed, falling back to direct fetch:", qErr.message);
        // fall through to direct fire-and-forget
      }
    }

    if (queueMode === "direct") {
      // Fallback: direct fire-and-forget. The worker is a fresh invocation, so
      // it gets its own 60s budget regardless of this function's response.
      fetch(WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, householdId }),
      }).catch(() => {});
    }

    return res.status(200).json({ status: "processing", householdId, queueMode });
  } catch (error) {
    console.error("Onboard enqueue error:", error);
    return res.status(500).json({ error: "Failed to start onboard" });
  }
}
