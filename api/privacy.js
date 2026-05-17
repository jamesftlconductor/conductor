// Privacy policy — served as a complete HTML page at /api/privacy.
// Linked from the Google OAuth consent screen and from the mobile
// Settings → About surface. Brand-aligned (dark + brass + off-white)
// and mobile-friendly via simple max-width container + clamp().

const LAST_UPDATED = "May 17, 2026";
const CONTACT_EMAIL = "support@conductor.app";

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Conductor — Privacy Policy</title>
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
    .muted { color: var(--muted); }
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
    <h1>Privacy Policy</h1>
    <p class="meta">Last updated: ${LAST_UPDATED}</p>

    <p>Conductor is a household intelligence layer. This policy explains what data we collect, how we use it, and the controls you have over it.</p>

    <h2>What we collect</h2>
    <p>Conductor reads only what you explicitly grant access to during onboarding:</p>
    <ul>
      <li><strong>Gmail (read-only):</strong> Subjects, senders, dates, and bodies of messages relevant to household signals — packages, reservations, deadlines, appointments, financial notifications. We do not read or store messages that don't match these patterns.</li>
      <li><strong>Google Calendar (read-only):</strong> Event titles, times, locations, and attendee counts from calendars you connect. Used to classify availability and detect conflicts.</li>
      <li><strong>Apple HealthKit (optional):</strong> Sleep duration and heart-rate variability summaries. Used only to inform brief tone (e.g. softer mornings after low sleep). Detailed activity logs are not stored.</li>
      <li><strong>Oura Ring (optional):</strong> Daily readiness, sleep, and activity scores. Same purpose as HealthKit; either source may be used.</li>
      <li><strong>What you tell us directly:</strong> Crew member names, prescriptions, doctors, notes, home inventory entries, vault items you add manually.</li>
    </ul>

    <h2>How we store it</h2>
    <p>Conductor uses two primary stores, both operated by Vercel and Upstash on US-based infrastructure:</p>
    <ul>
      <li><strong>Upstash Redis:</strong> Signals, vault items, crew records, memory log, household configuration. Encrypted at rest and in transit.</li>
      <li><strong>Vercel Blob:</strong> Crew photos. Stored privately; accessible only via signed URLs that expire after one hour.</li>
    </ul>
    <p>OAuth tokens (Gmail, Calendar, Oura) are stored in Redis and used solely to refresh access on your behalf. Tokens are never shared with third parties.</p>

    <h2>What we share</h2>
    <p>We do not sell or rent your data. Period.</p>
    <p>Conductor uses a small number of service providers to operate:</p>
    <ul>
      <li><strong>Anthropic (Claude API):</strong> Brief generation, signal classification, and pattern analysis. Each request includes only the minimum data needed for that task. Anthropic does not retain prompts for model training under our API usage.</li>
      <li><strong>QStash:</strong> Background job queue for onboarding and sync. Carries job identifiers only, not raw data.</li>
      <li><strong>Carrier APIs (UPS, FedEx, USPS, DHL):</strong> Receive your tracking numbers to look up package status. Used per shipment, not as a profile.</li>
      <li><strong>AviationStack:</strong> Receives flight numbers to retrieve status. Same per-flight basis.</li>
    </ul>
    <p><strong>The Network (opt-in only):</strong> If you choose to connect with another household through The Network, you control exactly what they see — load only, active signals, or emergency status. You can disconnect at any time.</p>

    <h2>How long we keep it</h2>
    <p>Household data persists for as long as your account is active. Memory log entries are capped at the most recent 200 events. Year in Review summaries persist permanently as part of your household record. Crew photos persist until you replace or delete them.</p>

    <h2>How to delete your data</h2>
    <p>To delete your account and all associated data, email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> from the address connected to your household. We will confirm and complete deletion within 30 days. You may also revoke Conductor's access at any time through your <a href="https://myaccount.google.com/permissions">Google Account permissions page</a>; once revoked, no further data is ingested.</p>

    <h2>Children</h2>
    <p>Conductor is not intended for use by anyone under 13. Crew records may include children's names and schedules — these are stored under the parent's household and are not used to create separate user accounts for those children.</p>

    <h2>Changes to this policy</h2>
    <p>We will post any material changes to this page and update the "Last updated" date above. Continued use of Conductor after changes constitutes acceptance.</p>

    <h2>Contact</h2>
    <p>Questions, requests, or concerns: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>

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
