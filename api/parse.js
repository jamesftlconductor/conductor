import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const emailText =
    req.body.plain ||
    req.body.body ||
    req.body.emailText ||
    req.body.email_body ||
    (req.body.envelope ? req.body.plain : null);

  if (!emailText) {
    return res.status(200).json({ skipped: true, reason: "No email text provided" });
  }

  try {
    // Step 1 — Ask Claude if this is a signal worth parsing
    const filterResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        messages: [{
          role: "user",
          content: `Is this email a shipping notification, delivery update, food order, grocery delivery, service appointment, reservation confirmation, or travel booking? Answer only YES or NO. If the email is older than 30 days or is a promotional/marketing email with no actionable delivery or service information, answer NO.

Email:
${emailText.substring(0, 500)}`,
        }],
      }),
    });

    const filterData = await filterResponse.json();
    const decision = filterData?.content?.[0]?.text?.trim()?.toUpperCase() || "NO";

    if (!decision.includes("YES")) {
      return res.status(200).json({ skipped: true, reason: "Not a relevant signal" });
    }

    // Step 2 — Parse the email
    const parseResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: `Extract information from this email and return ONLY a JSON object with these fields:
- description (what the item or service is)
- carrier (UPS, FedEx, USPS, DHL, Uber Eats, DoorDash, Instacart, or Unknown)
- trackingNumber (or null)
- status (In Transit, Delivered, Out for Delivery, Delayed, Preparing, On the Way, Confirmed, Scheduled, or Unknown)
- eta (estimated delivery or arrival date/time or null)
- sender (who sent it)
- type (package, food, grocery, service, reservation, travel, or unknown)

Email:
${emailText}

Return only the JSON object, nothing else.`,
        }],
      }),
    });

    const parseData = await parseResponse.json();
    const text = parseData?.content?.[0]?.text || "{}";
    const clean = text.replace(/```json|```/g, "").trim();
    const shipment = JSON.parse(clean);

    // Step 3 — Store in Redis
    const id = Date.now();
    shipment.id = id;
    shipment.lastUpdate = new Date().toLocaleString();
    await redis.lpush("shipments", JSON.stringify(shipment));

    return res.status(200).json(shipment);
  } catch (error) {
    console.error("Parse error:", error);
    return res.status(200).json({ skipped: true, error: "Failed to parse email" });
  }
}