// Terms of Service — served at /api/terms. Linked from the OAuth
// consent screen and the mobile Settings → About surface.

const LAST_UPDATED = "May 17, 2026";
const CONTACT_EMAIL = "support@conductor.app";

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Conductor — Terms of Service</title>
  <style>
    :root {
      --bg: #0f0f0f;
      --off-white: #f0ede8;
      --muted: #a8a5a0;
      --faint: #5a5855;
      --brass: #b8960c;
      --border: rgba(255, 255, 255, 0.06);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--off-white);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.6;
      font-size: 16px;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      max-width: 720px;
      margin: 0 auto;
      padding: clamp(24px, 6vw, 64px) clamp(20px, 5vw, 40px);
    }
    .brand {
      color: var(--brass);
      font-size: 12px;
      letter-spacing: 4px;
      font-weight: 600;
      text-transform: uppercase;
      margin: 0 0 6px;
    }
    .brass-line {
      height: 1px;
      background: rgba(184, 150, 12, 0.4);
      margin: 14px 0 24px;
      border: 0;
    }
    h1 {
      font-size: clamp(24px, 5vw, 32px);
      font-weight: 300;
      letter-spacing: 0.2px;
      margin: 0 0 4px;
    }
    .meta {
      color: var(--faint);
      font-size: 12px;
      letter-spacing: 0.5px;
      margin: 0 0 28px;
    }
    h2 {
      color: var(--brass);
      font-size: 13px;
      letter-spacing: 2px;
      text-transform: uppercase;
      font-weight: 600;
      margin: 32px 0 10px;
    }
    p, li {
      color: var(--off-white);
      font-size: 14px;
      line-height: 1.7;
    }
    ul {
      padding-left: 20px;
      margin: 0 0 14px;
    }
    li { margin-bottom: 6px; }
    a {
      color: var(--brass);
      text-decoration: underline;
      text-decoration-color: rgba(184, 150, 12, 0.5);
    }
    .footer {
      margin-top: 48px;
      padding-top: 20px;
      border-top: 1px solid var(--border);
      color: var(--faint);
      font-size: 11px;
      letter-spacing: 0.5px;
    }
  </style>
</head>
<body>
  <div class="container">
    <p class="brand">CONDUCTOR</p>
    <hr class="brass-line" />
    <h1>Terms of Service</h1>
    <p class="meta">Last updated: ${LAST_UPDATED}</p>

    <p>These terms govern your use of Conductor. By using the service, you agree to them. If you don't, please don't use Conductor.</p>

    <h2>What Conductor is</h2>
    <p>Conductor is a household intelligence layer that reads signals from your connected accounts (Gmail, Calendar, optionally HealthKit or Oura) and presents them as morning briefs, vault items, and other surfaces that help you keep track of what matters at home. Conductor never autonomously takes actions on your behalf — it surfaces information so you can decide.</p>

    <h2>Your responsibilities</h2>
    <ul>
      <li>Connect only your own accounts. Don't grant Conductor access to accounts that aren't yours.</li>
      <li>Don't use Conductor to harass, surveil, or harm anyone. The Network feature is for collaborative households (co-parents, family caregivers, close friends) — not for unsolicited monitoring.</li>
      <li>Keep your authentication credentials secure. If you suspect a compromise, revoke Conductor's access through your provider and contact us.</li>
      <li>Don't attempt to reverse-engineer, scrape, or stress-test the service. The mobile app and API are for human household use, not as a data source for other tools.</li>
    </ul>

    <h2>Your data is yours</h2>
    <p>You own the data you bring to Conductor — emails, calendar entries, health metrics, crew records, vault items. We hold it on your behalf to provide the service. You can request a full export or deletion at any time by emailing <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>

    <h2>Service availability</h2>
    <p>Conductor is provided "as is." We aim for high availability but don't guarantee uninterrupted service. Briefs depend on external APIs (Google, Anthropic, carrier services) that may have their own outages. When something we depend on is down, Conductor degrades gracefully rather than failing loudly.</p>
    <p>We may make changes to the service over time — new features, refined briefs, retired features that didn't earn their place. Material reductions in functionality will be announced before they land.</p>

    <h2>How to cancel</h2>
    <p>Cancel at any time, two ways:</p>
    <ul>
      <li><strong>From your Google Account permissions:</strong> Revoke Conductor's access at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>. Conductor stops reading new data immediately.</li>
      <li><strong>By email:</strong> Send a deletion request to <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> from the address connected to your household. We confirm receipt and complete deletion within 30 days.</li>
    </ul>

    <h2>Limitations of liability</h2>
    <p>Conductor is a supplement, not a substitute, for your own attention. Don't rely on it as the sole record of legal deadlines, medical schedules, or other high-stakes obligations. We are not liable for any decision you make (or fail to make) based on a brief.</p>
    <p>To the maximum extent permitted by law, our total liability for any claim arising out of or related to the service is limited to the amount you paid us in the 12 months preceding the claim (or $50 if greater).</p>

    <h2>Changes to these terms</h2>
    <p>We will post any material changes to this page and update the "Last updated" date above. Continued use after changes constitutes acceptance.</p>

    <h2>Contact</h2>
    <p>Questions or concerns: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>

    <div class="footer">
      conductor — household intelligence
    </div>
  </div>
</body>
</html>`;

export default function handler(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.status(200).send(HTML);
}
