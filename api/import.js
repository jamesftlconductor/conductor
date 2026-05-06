import { Redis } from "@upstash/redis";
import { getValidToken } from "./refresh.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: "No userId provided" });
  }

  try {
    const accessToken = await getValidToken(userId);

    const thirtyDaysAgo = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
    const query = `after:${thirtyDaysAgo} subject:(tracking OR shipped OR "your order" OR "order confirmed" OR "order shipped" OR delivery OR arriving OR "out for delivery" OR "return confirmed" OR reservation OR flight OR hotel OR appointment OR instacart OR doordash)`;

    const searchResponse = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=5`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const searchData = await searchResponse.json();

    if (!searchData.messages || searchData.messages.length === 0) {
      return res.status(200).json({ imported: 0, debug: "No messages found" });
    }

    let imported = 0;

    for (const message of searchData.messages) {
      try {
        const msgResponse = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=full`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const msgData = await msgResponse.json();

        const headers = msgData.payload?.headers || [];
        const subject = headers.find(h => h.name === "Subject")?.value || "";
        const from = headers.find(h => h.name === "From")?.value || "";

        let emailText = "";
        const parts = msgData.payload?.parts || [];

        for (const part of parts) {
          if (part.mimeType === "text/plain" && part.body?.data) {
            emailText = Buffer.from(part.body.data, "base64").toString("utf-8");
            break;
          }
        }

        if (!emailText) {
          for (const part of parts) {
            const nestedParts = part.parts || [];
            for (const nested of nestedParts) {
              if (nested.mimeType === "text/plain" && nested.body?.data) {
                emailText = Buffer.from(nested.body.data, "base64").toString("utf-8");
                break;
              }
            }
            if (emailText) break;
          }
        }

        if (!emailText && msgData.payload?.body?.data) {
          emailText = Buffer.from(msgData.payload.body.data, "base64").toString("utf-8");
        }

        if (!emailText) {
          emailText = `Subject: ${subject}\nFrom: ${from}`;
        }

        console.log("Parsing:", subject);

        const parseResponse = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 500,
            messages: [{
              role: "user",
              content: `Extract shipping/order info from this email. Return ONLY a JSON object:
{
  "description": "what the item or service is",
  "carrier": "UPS, FedEx, USPS, DHL, or Unknown",
  "trackingNumber": null,
  "status": "In Transit, Delivered, Out for Delivery, Delayed, or Unknown",
  "eta": "date or null",
  "sender": "who sent it",
  "type": "package, food, grocery, service, reservation, travel, or unknown"
}

Subject: ${subject}
From: ${from}

Email body:
${emailText.substring(0, 1000)}`,
            }],
          }),
        });

        const parseData = await parseResponse.json();
        console.log("Claude response:", JSON.stringify(parseData).substring(0, 200));

        const text = parseData?.content?.[0]?.text || "{}";
        const clean = text.replace(/```json|```/g, "").trim();
        const signal = JSON.parse(clean);

        const etaParsed = signal.eta ? Date.parse(signal.eta) : NaN;
        if (!isNaN(etaParsed) && etaParsed < Date.now() - 7 * 24 * 60 * 60 * 1000) {
          continue;
        }

        signal.id = Date.now() + imported;
        signal.lastUpdate = new Date().toLocaleString();
        signal.userId = userId;
        signal.source = "import";

        const householdId = (await redis.get(`user:${userId}:household`)) || userId;
        await redis.lpush(`household:${householdId}:signals`, JSON.stringify(signal));
        imported++;

        await new Promise(r => setTimeout(r, 1000));

      } catch (err) {
        console.error("Error:", err.message);
        continue;
      }
    }

    return res.status(200).json({ imported });

  } catch (error) {
    console.error("Import error:", error);
    return res.status(500).json({ error: "Import failed" });
  }
}