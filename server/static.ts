import express from 'express';
import type { Express } from 'express';
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Legal pages — /terms and /privacy
//
// Self-contained server-rendered HTML (no SPA/JS/session) so Stripe review,
// crawlers, and logged-out users always get them. Full text as of 2026-07-02;
// the operator legal-entity name (Terms §1, Privacy §1) and the governing-law
// state (Terms §13, drafted as Delaware) are the two owner-review points.
// ---------------------------------------------------------------------------

function legalPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — DispatchOS</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 48px 20px 80px;
    background: #0B1220; color: #d5dae6;
    font: 15px/1.65 Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 720px; margin: 0 auto; }
  h1 { color: #ffffff; font-size: 28px; letter-spacing: -0.5px; margin: 0 0 4px; }
  h2 { color: #ffffff; font-size: 18px; margin: 32px 0 8px; }
  p, li { color: #9aa3ba; }
  a { color: #f59e0b; }
  strong { color: #c7cede; }
  .updated { font-size: 13px; color: #6b7390; margin: 0 0 24px; }
  footer { max-width: 720px; margin: 48px auto 0; padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.08); font-size: 13px; color: #6b7390; }
  footer a { color: #9aa3ba; }
</style>
</head>
<body>
<main>
${body}
</main>
<footer>
  <a href="/">DispatchOS</a> · <a href="/terms">Terms of Service</a> · <a href="/privacy">Privacy Policy</a> · <a href="mailto:support@dispatchos.co">support@dispatchos.co</a>
</footer>
</body>
</html>`;
}

const TERMS_HTML = legalPage(
  "Terms of Service",
  `<h1>Terms of Service</h1>
<p class="updated">Last updated: July 2, 2026</p>

<h2>1. Agreement</h2>
<p>These Terms of Service (the "Terms") are a binding agreement between you and the operator of the DispatchOS service ("DispatchOS," "we," "us," "our"). By creating an account, checking the sign-up agreement box, or using dispatchos.co or the DispatchOS application (together, the "Service"), you accept these Terms and our <a href="/privacy">Privacy Policy</a>. If you use the Service on behalf of a company, you represent that you are authorized to bind that company, and "you" means that company.</p>

<h2>2. What the Service Is (and Is Not)</h2>
<p>DispatchOS is freight-dispatch software for carriers, owner-operators, and dispatchers: load intake and scoring, broker vetting signals, dispatch boards, driver check-ins, document handling, compliance reminders, invoicing, and related tooling.</p>
<p><strong>DispatchOS is a software tool only.</strong> We are not a freight broker, motor carrier, freight forwarder, or dispatch service; we hold no FMCSA operating authority and we do not arrange, tender, negotiate, or transport freight, and are not a party to any agreement between you and any broker, shipper, factoring company, or other counterparty. You remain solely responsible for your own operating authority, insurance, safety compliance, and the decision to accept or decline any load.</p>

<h2>3. Accounts and Eligibility</h2>
<ul>
  <li>You must be at least 18 years old and able to form a binding contract.</li>
  <li>You must provide accurate registration information and keep it current.</li>
  <li>You are responsible for safeguarding your credentials (including two-factor devices) and for all activity under your account. Notify us promptly at <a href="mailto:support@dispatchos.co">support@dispatchos.co</a> of any suspected unauthorized use.</li>
  <li>We may refuse, suspend, or revoke accounts that provide false information (including misappropriated MC/DOT numbers) or that we reasonably believe are used for fraud.</li>
</ul>

<h2>4. Fees and Billing</h2>
<ul>
  <li><strong>Subscription.</strong> Paid plans are billed monthly in advance through Stripe at the price shown at checkout. Card details are handled by Stripe and never touch our servers.</li>
  <li><strong>Free trial.</strong> New accounts receive a 14-day free trial (one per carrier). When the trial ends, write access is suspended until a plan is purchased; your data remains readable and exportable.</li>
  <li><strong>Success fee.</strong> A success fee of 3% of the gross rate applies to loads sourced through the platform's load feeds. It is billed weekly after a load is delivered, and is capped each calendar month at 2&times; your plan price. Loads you enter yourself (manual, imported, or self-dispatched) carry no success fee. Success fees are charged to the payment method on file after the billing week closes.</li>
  <li><strong>Seats.</strong> Driver seats beyond a plan's included count are billed per seat per month at the rate shown at purchase.</li>
  <li><strong>AI credits.</strong> Optional AI feature credits are one-time purchases and are non-refundable once consumed.</li>
  <li><strong>Changes.</strong> We may change prices with at least 30 days' notice; changes apply from your next billing cycle. Fees are exclusive of taxes, which are your responsibility where applicable.</li>
  <li><strong>Cancellation and refunds.</strong> You may cancel any time from the billing portal; the subscription remains active until the end of the paid period. Except where required by law, payments already made (including success fees on delivered platform-sourced loads) are non-refundable.</li>
  <li><strong>Non-payment.</strong> We may suspend the Service for accounts with overdue balances after notice.</li>
</ul>

<h2>5. Acceptable Use</h2>
<p>You agree not to:</p>
<ul>
  <li>access or attempt to access another tenant's data;</li>
  <li>use the Service to defraud or deceive brokers, shippers, carriers, or drivers, including double-brokering schemes or identity misrepresentation;</li>
  <li>upload unlawful, infringing, or malicious content;</li>
  <li>probe, overload, disrupt, or circumvent security or rate limits;</li>
  <li>scrape, harvest, resell, or redistribute the Service or data obtained from it, or use it to build a competing dataset;</li>
  <li>share one seat among multiple people to avoid seat fees;</li>
  <li>use the Service in violation of applicable law, including transportation and safety regulations.</li>
</ul>
<p>We may suspend or terminate accounts engaged in the above and, where appropriate, notify affected counterparties or authorities.</p>

<h2>6. Your Data</h2>
<p>You retain all ownership of the data and documents you upload. You grant us a limited, non-exclusive license to host, process, transmit, and display that data solely to operate, secure, and support the Service. We may create and use <strong>aggregated, de-identified data</strong> (for example, lane-rate benchmarks and broker-reliability signals that cannot reasonably identify you or your counterparties) to operate and improve the Service for all customers.</p>

<h2>7. Third-Party Data and Integrations</h2>
<p>The Service surfaces data from third-party sources — broker emails, FMCSA/SAFER records, market-rate estimates, fuel-price data, mapping services — and can connect to third-party services (Stripe, Telegram, and others). Third-party data is provided for information only; we do not guarantee its accuracy, completeness, or timeliness. <strong>Verify rates, brokers, and load details independently before committing equipment or money.</strong> Your use of third-party services is governed by their own terms.</p>

<h2>8. AI Features</h2>
<p>Some features use artificial-intelligence models to score, summarize, extract, or draft content. AI output can be wrong, incomplete, or outdated, and is provided as a decision aid only — it is not professional, legal, or financial advice. You are responsible for reviewing AI output before acting on it.</p>

<h2>9. Availability and Support</h2>
<p>We aim for high availability but the Service is provided without an uptime guarantee at this stage. We may perform maintenance, and we may modify or discontinue features with reasonable notice where practical. Support is provided by email at <a href="mailto:support@dispatchos.co">support@dispatchos.co</a>.</p>

<h2>10. Intellectual Property</h2>
<p>The Service, including its software, design, and branding, is our property or that of our licensors and is protected by law. We grant you a limited, non-exclusive, non-transferable right to use the Service for your internal business purposes during your subscription. No rights are granted except as expressly stated.</p>

<h2>11. Disclaimer of Warranties; Limitation of Liability</h2>
<p>THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.</p>
<p>TO THE MAXIMUM EXTENT PERMITTED BY LAW: (a) OUR TOTAL AGGREGATE LIABILITY ARISING OUT OF OR RELATING TO THE SERVICE IS LIMITED TO THE FEES YOU PAID US IN THE 12 MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM; AND (b) WE ARE NOT LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, LOST LOADS, LOST REVENUE, DETENTION, CARGO CLAIMS, OR DISPUTES BETWEEN YOU AND BROKERS, SHIPPERS, FACTORS, DRIVERS, OR OTHER THIRD PARTIES, EVEN IF ADVISED OF THE POSSIBILITY. Some jurisdictions do not allow certain limitations; in those jurisdictions these limits apply to the fullest extent permitted.</p>

<h2>12. Indemnification</h2>
<p>You will defend and indemnify us against claims arising from your transportation operations, your content, your violation of these Terms, or your violation of law or third-party rights.</p>

<h2>13. Termination</h2>
<p>You may close your account at any time. We may suspend or terminate your access for material breach, non-payment, or unlawful use, with notice where practicable. For 30 days after termination you may request an export of your data, after which we delete it as described in the <a href="/privacy">Privacy Policy</a>. Sections 6, 10, 11, 12, and 14 survive termination.</p>

<h2>14. Governing Law and Disputes</h2>
<p>These Terms are governed by the laws of the State of Delaware, USA, without regard to conflict-of-law rules. Before filing a claim, you agree to contact us and attempt in good faith to resolve the dispute informally within 30 days. Disputes not resolved informally shall be brought exclusively in the state or federal courts located in Delaware, and each party consents to their jurisdiction. <strong>Each party waives any right to participate in a class action</strong> to the extent permitted by law.</p>

<h2>15. Changes to These Terms</h2>
<p>We may update these Terms from time to time. Material changes will be announced by email or in-app notice at least 14 days before they take effect; the "Last updated" date above always reflects the current version. Continued use of the Service after the effective date constitutes acceptance.</p>

<h2>16. General</h2>
<p>These Terms and the Privacy Policy are the entire agreement between us regarding the Service. You may not assign them without our consent; we may assign them in connection with a merger, acquisition, or sale of assets. If any provision is held unenforceable, the remainder stays in effect. Our failure to enforce a provision is not a waiver. Notices to you may be sent to your account email; notices to us go to <a href="mailto:support@dispatchos.co">support@dispatchos.co</a>.</p>

<h2>17. Contact</h2>
<p>Questions about these Terms: <a href="mailto:support@dispatchos.co">support@dispatchos.co</a>.</p>`,
);

const PRIVACY_HTML = legalPage(
  "Privacy Policy",
  `<h1>Privacy Policy</h1>
<p class="updated">Last updated: July 2, 2026</p>

<h2>1. Who We Are</h2>
<p>This policy explains what personal data the operator of DispatchOS ("we," "us") collects through dispatchos.co and the DispatchOS application (the "Service"), how we use it, and the choices you have. Privacy questions and requests: <a href="mailto:support@dispatchos.co">support@dispatchos.co</a>.</p>

<h2>2. Data We Collect</h2>
<ul>
  <li><strong>Account data</strong> — name, email address, hashed password, two-factor authentication secrets, role, and language preference.</li>
  <li><strong>Business data</strong> — carrier profiles (company name, MC/DOT numbers, contact details), loads and rates, broker records, invoices, and documents you upload (rate confirmations, BOL/POD, receipts).</li>
  <li><strong>Driver data</strong> — names and contact details of drivers you add, and <strong>location check-ins</strong> that drivers submit or their devices report while using driver features (pickup/delivery confirmation, GPS pings for load tracking). Location is collected only in connection with dispatch activity, not continuously in the background.</li>
  <li><strong>Messaging identifiers</strong> — your Telegram ID and phone number if you connect Telegram or SMS notifications.</li>
  <li><strong>Billing data</strong> — plan, subscription status, and invoice history. Card numbers are collected and stored by Stripe only and never touch our servers.</li>
  <li><strong>Technical data</strong> — IP address, session cookie, device/browser type, and application logs kept for security and debugging.</li>
</ul>

<h2>3. How We Use Data</h2>
<p>We use data to provide and secure the Service, process payments, send transactional email, SMS, and Telegram notifications, provide AI-assisted features when you invoke them, prevent fraud and abuse, comply with law, and improve the product. <strong>We do not sell personal data, and we do not use it for third-party advertising.</strong></p>

<h2>4. Service Providers (Subprocessors)</h2>
<p>We share data with service providers only as needed to run the Service:</p>
<ul>
  <li><strong>Fly.io</strong> — application hosting and primary data storage (USA).</li>
  <li><strong>Cloudflare</strong> — DNS, traffic routing, and inbound email processing.</li>
  <li><strong>Stripe</strong> — payment processing and billing.</li>
  <li><strong>Resend</strong> — outbound transactional email.</li>
  <li><strong>Twilio</strong> — SMS delivery and phone verification, if you use SMS features.</li>
  <li><strong>Telegram</strong> — bot notifications, if you connect Telegram.</li>
  <li><strong>Anthropic</strong> — AI features; the relevant content (for example, a broker email or receipt image) is sent for processing when you use an AI feature.</li>
  <li><strong>Google Maps</strong> — geocoding and distance calculation for addresses and routes.</li>
  <li><strong>Sentry</strong> — error monitoring (configured to exclude personal data from reports).</li>
  <li><strong>GitHub</strong> — off-site encrypted infrastructure backups (see Retention).</li>
</ul>
<p>Public-record lookups (FMCSA/SAFER carrier data, EIA fuel prices) involve sending only the public identifiers being looked up (such as an MC number).</p>

<h2>5. Retention</h2>
<p>Account and business data is kept while your account is active. After account closure or termination we delete personal data within 90 days, except records we must keep longer for legal, tax, or accounting purposes. Audit logs are retained for the window defined by your plan (30 days to 2 years). Off-site backups roll off automatically within 90 days. Application logs are kept up to 30 days.</p>

<h2>6. Your Rights</h2>
<p>You can access, correct, export, or delete your personal data — most of it directly in the application, or by emailing <a href="mailto:support@dispatchos.co">support@dispatchos.co</a>. We respond within 30 days. Depending on where you live (for example, California under the CCPA/CPRA, or the EEA/UK under the GDPR), you may have additional rights, including the right to know what data we hold, the right to deletion, the right to portability, and the right to lodge a complaint with your local supervisory authority. We do not discriminate against you for exercising these rights.</p>
<p>If you are a driver whose employer or dispatcher added you to DispatchOS, your dispatch and location data is controlled by that carrier; direct requests about it to them first, and we will assist.</p>

<h2>7. Security</h2>
<p>We use industry-standard measures: TLS for data in transit, hashed passwords, optional two-factor authentication, role-based access control, tenant isolation, rate limiting, and encrypted secrets. No system is perfectly secure; if a breach affects your personal data we will notify you and the relevant authorities as required by law.</p>

<h2>8. Cookies</h2>
<p>We use only essential first-party cookies: a session cookie for sign-in and a language preference. We do not use third-party advertising or cross-site tracking cookies.</p>

<h2>9. International Transfers</h2>
<p>The Service is operated from and hosted in the United States. If you use it from outside the USA, your data is transferred to and processed in the USA and in the countries where the providers in Section 4 operate.</p>

<h2>10. Children</h2>
<p>The Service is a business tool, is not directed at children, and may not be used by anyone under 18. We do not knowingly collect data from children.</p>

<h2>11. Changes</h2>
<p>We will post updates to this policy here and update the date above. Material changes will be announced by email or in-app notice before they take effect.</p>

<h2>12. Contact</h2>
<p>Privacy questions and requests: <a href="mailto:support@dispatchos.co">support@dispatchos.co</a>.</p>`,
);

// Registered from registerRoutes (dev + prod) so the pages exist in both
// modes; serveStatic also registers them so prod does not depend on that
// call-site (Express keeps the first match — the duplicate is inert).
export function registerLegalRoutes(app: Express) {
  app.get("/terms", (_req, res) => {
    res.type("html").send(TERMS_HTML);
  });
  app.get("/privacy", (_req, res) => {
    res.type("html").send(PRIVACY_HTML);
  });
}

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  registerLegalRoutes(app);

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist — BUT never for /api/*.
  // An unmounted/typo'd API route must fail loud as a JSON 404, not silently
  // return the SPA HTML shell (which masks routing bugs and breaks API clients).
  app.use("/{*path}", (req, res) => {
    if (req.path.toLowerCase().startsWith("/api/")) {
      return res.status(404).json({ message: "Not found" });
    }
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
