import express from 'express';
import type { Express } from 'express';
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Legal pages — /terms and /privacy
//
// Self-contained server-rendered HTML (no SPA/JS/session) so Stripe review,
// crawlers, and logged-out users always get them. Content is a clearly-marked
// SKELETON: every [PLACEHOLDER] section is to be filled by the owner (a
// lawyer) before it can be relied on.
// ---------------------------------------------------------------------------

function legalPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
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
  .updated { font-size: 13px; color: #6b7390; margin: 0 0 24px; }
  .skeleton {
    border: 1px solid rgba(245, 158, 11, 0.4); border-radius: 8px;
    background: rgba(245, 158, 11, 0.08); color: #fbbf24;
    padding: 10px 14px; font-size: 13px; margin: 0 0 24px;
  }
  .ph { color: #fbbf24; font-style: italic; }
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
<p class="updated">Last updated: <span class="ph">[PLACEHOLDER — date]</span></p>
<div class="skeleton">DRAFT SKELETON — this document is a template. Sections marked [PLACEHOLDER] must be completed and reviewed by counsel before these terms are final.</div>

<h2>1. The Service</h2>
<p>DispatchOS ("the Service") is freight-dispatch software for carriers, dispatchers, and owner-operators: load discovery and scoring, broker vetting, compliance reminders, document handling, and related tooling. The Service is provided by <span class="ph">[PLACEHOLDER — legal entity name, jurisdiction of incorporation, registered address]</span>.</p>
<p>The Service is a software tool. It is not a licensed freight broker, carrier, or dispatch service, and does not itself arrange, tender, or transport freight. <span class="ph">[PLACEHOLDER — confirm regulatory characterization]</span></p>

<h2>2. Accounts</h2>
<p>You must provide accurate information when creating an account and keep your credentials (including two-factor devices) secure. You are responsible for activity under your account. <span class="ph">[PLACEHOLDER — eligibility, minimum age, authority to bind a company]</span></p>

<h2>3. Fees and Billing</h2>
<ul>
  <li>Subscription plans are billed in advance through Stripe at the prices shown at checkout.</li>
  <li>A success fee of 3% applies to loads booked through the Service. <span class="ph">[PLACEHOLDER — exact fee basis, collection timing, invoicing mechanics]</span></li>
  <li>Additional driver seats beyond a plan's included seats are billed per seat per month at the rate shown at purchase.</li>
  <li><span class="ph">[PLACEHOLDER — refunds, proration, price-change notice, taxes, late payment]</span></li>
</ul>

<h2>4. Acceptable Use</h2>
<p>You agree not to: misuse or overload the Service; access another tenant's data; scrape, resell, or redistribute the Service or its data without permission; upload unlawful content; use the Service to defraud brokers, shippers, or carriers; or violate applicable transportation regulations. <span class="ph">[PLACEHOLDER — complete acceptable-use list, enforcement remedies]</span></p>

<h2>5. Data and Content</h2>
<p>You retain ownership of the data and documents you upload. You grant us the limited rights needed to operate the Service (storage, processing, display to your authorized users). <span class="ph">[PLACEHOLDER — license scope, aggregated/anonymized usage]</span></p>

<h2>6. Third-Party Data</h2>
<p>Load, broker, market-rate, and FMCSA data surfaced in the Service comes from third-party sources and is provided for information only. We do not guarantee its accuracy or completeness; verify independently before making dispatch or financial decisions. <span class="ph">[PLACEHOLDER — disclaimers per data source]</span></p>

<h2>7. Disclaimer of Warranties; Limitation of Liability</h2>
<p>The Service is provided "as is" without warranties of any kind. To the maximum extent permitted by law, our aggregate liability is limited to <span class="ph">[PLACEHOLDER — cap, e.g. fees paid in the prior 12 months]</span>, and we are not liable for indirect, incidental, or consequential damages, including lost loads, lost revenue, detention, or claims arising from carrier–broker disputes. <span class="ph">[PLACEHOLDER — full warranty/liability language]</span></p>

<h2>8. Termination</h2>
<p>You may cancel at any time; access continues until the end of the paid period. We may suspend or terminate accounts for breach of these terms, non-payment, or unlawful use. On termination you may export your data for <span class="ph">[PLACEHOLDER — export window]</span>, after which it is deleted per the Privacy Policy. <span class="ph">[PLACEHOLDER — survival clauses]</span></p>

<h2>9. General</h2>
<p><span class="ph">[PLACEHOLDER — governing law, venue, arbitration/class-action terms, notices, assignment, entire agreement, changes to terms]</span></p>

<h2>10. Contact</h2>
<p>Questions about these terms: <a href="mailto:support@dispatchos.co">support@dispatchos.co</a>.</p>`,
);

const PRIVACY_HTML = legalPage(
  "Privacy Policy",
  `<h1>Privacy Policy</h1>
<p class="updated">Last updated: <span class="ph">[PLACEHOLDER — date]</span></p>
<div class="skeleton">DRAFT SKELETON — this document is a template. Sections marked [PLACEHOLDER] must be completed and reviewed by counsel before this policy is final.</div>

<h2>1. Who We Are</h2>
<p>DispatchOS is operated by <span class="ph">[PLACEHOLDER — legal entity name and address]</span> ("we"). This policy explains what personal data we collect through dispatchos.co and the DispatchOS application, and how we use it.</p>

<h2>2. Data We Collect</h2>
<ul>
  <li><strong>Account data</strong> — name, email, password hash, two-factor secrets, role, language preference.</li>
  <li><strong>Business data</strong> — carrier profiles (company name, MC/DOT numbers), loads, broker records, driver details, locations you enter or your devices report, and documents you upload (rate confirmations, BOL/POD, receipts).</li>
  <li><strong>Billing data</strong> — subscription plan and payment status. Card details are handled by Stripe and never touch our servers.</li>
  <li><strong>Technical data</strong> — IP address, session cookies, and application logs kept for security and debugging.</li>
  <li><span class="ph">[PLACEHOLDER — analytics/tracking, if any]</span></li>
</ul>

<h2>3. How We Use It</h2>
<p>To provide and secure the Service, process payments, send transactional email and Telegram notifications, provide AI-assisted features, comply with law, and improve the product. We do not sell personal data. <span class="ph">[PLACEHOLDER — legal bases if GDPR applies, marketing-communication terms]</span></p>

<h2>4. Processors and Subprocessors</h2>
<p>We share data with service providers only as needed to run the Service:</p>
<ul>
  <li><strong>Stripe</strong> — payment processing and billing.</li>
  <li><strong>Resend</strong> — outbound transactional email.</li>
  <li><strong>Fly.io</strong> — application hosting and data storage.</li>
  <li><strong>Telegram</strong> — optional bot notifications, if you connect it.</li>
  <li><strong>Anthropic</strong> — AI features (document parsing, drafting); relevant content is sent for processing when you use those features.</li>
  <li><span class="ph">[PLACEHOLDER — any other processors; data-processing agreements; international transfer mechanisms]</span></li>
</ul>

<h2>5. Retention</h2>
<p>Account and business data is kept while your account is active. After account closure, data is deleted within <span class="ph">[PLACEHOLDER — retention window]</span>, except records we must keep for legal, tax, or accounting purposes. Backups roll off on a <span class="ph">[PLACEHOLDER — backup cycle]</span> schedule. <span class="ph">[PLACEHOLDER — log retention]</span></p>

<h2>6. Your Rights</h2>
<p>You can access, correct, export, or delete your personal data by contacting us. <span class="ph">[PLACEHOLDER — rights per applicable law (CCPA/GDPR etc.), response timelines, complaint routes]</span></p>

<h2>7. Security</h2>
<p>We use industry-standard measures: TLS in transit, hashed passwords, two-factor authentication, role-based access, and encrypted secrets at rest. No system is perfectly secure; we notify affected users of breaches as required by law. <span class="ph">[PLACEHOLDER — breach-notification specifics]</span></p>

<h2>8. Cookies</h2>
<p>We use only essential cookies: a session cookie for sign-in and a language preference. No third-party advertising cookies. <span class="ph">[PLACEHOLDER — update if analytics are added]</span></p>

<h2>9. Changes</h2>
<p>We will post updates to this policy here and update the date above. <span class="ph">[PLACEHOLDER — material-change notification]</span></p>

<h2>10. Contact</h2>
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
