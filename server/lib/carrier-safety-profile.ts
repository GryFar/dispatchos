// ===========================================================================
// server/lib/carrier-safety-profile.ts
// ===========================================================================
//
// Carrier Safety Profile — paid add-on selling document.
//
// After SCOTUS *Montgomery v. Caribe Transport II* (May 14, 2026) brokers must
// document carrier vetting to defend against negligent-hiring claims. This
// module aggregates everything we know about a single carrier (our client)
// into a snapshot a broker can demand as part of due diligence:
//
//   • FMCSA SAFER record (live fetch via lib/ai/fmcsa)
//       — authority status, USDOT, MC, legal name + address
//       — power units, drivers, mileage, crash rate, OOS %
//       — safety rating (SATISFACTORY / CONDITIONAL / UNSATISFACTORY)
//   • Insurance status (cargo / liability / GL — from clients.*ExpiresAt)
//   • Operational record (loads completed, on-time %, recent activity)
//   • Compliance signals (recent audit events, IFTA reporting on/off)
//
// API surface:
//   buildCarrierSafetyProfile(clientId)  →  CarrierSafetyProfile (JSON)
//   renderCarrierSafetyProfileMarkdown(profile)  →  Markdown text
//
// Endpoints (registered in server/routes/admin.ts):
//   GET /api/admin/clients/:id/safety-profile        → JSON
//   GET /api/admin/clients/:id/safety-profile.md     → Markdown download
//
// Future: PDF render via Puppeteer or wkhtmltopdf — for now markdown is
// universal and lighter to host. Brokers paste it into their carrier file
// or convert to PDF themselves.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type { Client, Load } from "@shared/schema";
import { storage } from "../storage";
import { getIntegrationValue } from "./integration-config";
import {
  fetchByMc,
  normalizeMcNumber,
  type FmcsaCarrier,
} from "./ai/fmcsa";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InsuranceStatus =
  | "active"        // expires in > 30 days
  | "expiring"      // 0–30 days
  | "expired"       // already past expiry
  | "missing";      // not on file

export interface InsuranceLine {
  kind: "cargo" | "liability" | "general";
  expiresAt: string | null;
  status: InsuranceStatus;
  daysUntilExpiry: number | null;
}

export interface OperationalRecord {
  /** Total booked loads in our DB. */
  loadsTotal: number;
  /** Loads booked in the last 90 days. */
  loadsLast90d: number;
  /** Loads delivered (have deliveryAt). */
  loadsDelivered: number;
  /** Currently-booked active loads. */
  loadsActive: number;
  /** ISO of first activity on platform. */
  firstActivityAt: string | null;
  /** ISO of last activity (most recent audit/load/login). */
  lastActivityAt: string | null;
}

export interface SafetyVerdict {
  /** Aggregate verdict: green/yellow/red shown in the badge. */
  level: "green" | "yellow" | "red" | "unknown";
  /** Plain-language summary explaining the level. */
  summary: string;
  /** List of specific risk factors driving the verdict. */
  risks: string[];
  /** List of positive signals supporting the level. */
  strengths: string[];
}

export interface CarrierSafetyProfile {
  clientId: string;
  clientName: string;
  mc: string;
  generatedAt: string;
  fmcsa: {
    fetched: boolean;
    error?: string;
    raw: FmcsaCarrier | null;
  };
  insurance: InsuranceLine[];
  operational: OperationalRecord;
  verdict: SafetyVerdict;
  /** Important Montgomery-defense disclaimer text the buyer should keep. */
  disclaimer: string;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Audit V2-16 — module-level cache for FMCSA SAFER responses.
// Keyed by normalized MC number AND a hash of the web key, so a key rotation
// (or a different tenant's key) never serves a result fetched under another
// credential, and the entry is naturally invalidated when the key changes.
const FMCSA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Negative ("no record found") results expire much sooner: a carrier that
// just registered with FMCSA shouldn't be pinned as "not found" for a full
// day, and a transient empty response shouldn't stick.
const FMCSA_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
// Bound the Map so a flood of distinct MC lookups can't grow it without limit.
const FMCSA_CACHE_MAX_ENTRIES = 5000;
const fmcsaCache: Map<string, { value: FmcsaCarrier | null; expiresAt: number }> = new Map();

// Exported for tests (cache-isolation/TTL/bound invariants). Not part of the
// module's intended public API — prefer buildCarrierSafetyProfile.
export function fmcsaCacheKey(normalizedMc: string, webKey: string): string {
  const webKeyHash = createHash("sha256").update(webKey).digest("hex").slice(0, 16);
  return `${normalizedMc}|${webKeyHash}`;
}

function setFmcsaCache(key: string, value: FmcsaCarrier | null): void {
  // Evict the oldest entry (insertion order) when at capacity. Deleting an
  // existing key first keeps re-inserts from counting twice and refreshes
  // recency ordering.
  fmcsaCache.delete(key);
  if (fmcsaCache.size >= FMCSA_CACHE_MAX_ENTRIES) {
    const oldest = fmcsaCache.keys().next().value;
    if (oldest !== undefined) fmcsaCache.delete(oldest);
  }
  const ttl = value === null ? FMCSA_NEGATIVE_CACHE_TTL_MS : FMCSA_CACHE_TTL_MS;
  fmcsaCache.set(key, { value, expiresAt: Date.now() + ttl });
}

function classifyExpiry(iso: string | null | undefined): InsuranceLine {
  if (!iso) {
    return { kind: "cargo", expiresAt: null, status: "missing", daysUntilExpiry: null };
  }
  const expiryMs = new Date(iso).getTime();
  if (!Number.isFinite(expiryMs)) {
    return { kind: "cargo", expiresAt: iso, status: "missing", daysUntilExpiry: null };
  }
  const days = Math.floor((expiryMs - Date.now()) / MS_PER_DAY);
  let status: InsuranceStatus;
  if (days < 0) status = "expired";
  else if (days <= 30) status = "expiring";
  else status = "active";
  return { kind: "cargo", expiresAt: iso, status, daysUntilExpiry: days };
}

function readInsuranceFromClient(client: Client): InsuranceLine[] {
  // Phase 7.2 — three optional ISO date strings on the client payload.
  const c = client as unknown as Record<string, string | undefined>;
  const lines: Array<{ kind: InsuranceLine["kind"]; iso: string | undefined }> = [
    { kind: "cargo", iso: c.cargoInsuranceExpiresAt },
    { kind: "liability", iso: c.autoLiabilityExpiresAt },
    { kind: "general", iso: c.generalLiabilityExpiresAt },
  ];
  return lines.map(({ kind, iso }) => {
    const line = classifyExpiry(iso ?? null);
    line.kind = kind;
    return line;
  });
}

function buildOperationalRecord(clientId: string): OperationalRecord {
  const loads = storage.listLoads().filter((l: Load) => {
    const anyLoad = l as unknown as { clientId?: string };
    return anyLoad.clientId === clientId;
  }) as Array<Load & { bookedAt?: string; deliveryAt?: string }>;

  const now = Date.now();
  const ninetyDaysAgo = now - 90 * MS_PER_DAY;

  const bookings = loads
    .map((l) => (l.bookedAt ? new Date(l.bookedAt).getTime() : null))
    .filter((t): t is number => t !== null && Number.isFinite(t));
  const last90 = bookings.filter((t) => t >= ninetyDaysAgo).length;

  const delivered = loads.filter((l) => !!l.deliveryAt).length;
  const active = loads.filter((l) => !!l.bookedAt && !l.deliveryAt).length;

  const firstMs = bookings.length > 0 ? Math.min(...bookings) : null;
  const lastMs = bookings.length > 0 ? Math.max(...bookings) : null;

  return {
    loadsTotal: loads.length,
    loadsLast90d: last90,
    loadsDelivered: delivered,
    loadsActive: active,
    firstActivityAt: firstMs ? new Date(firstMs).toISOString() : null,
    lastActivityAt: lastMs ? new Date(lastMs).toISOString() : null,
  };
}

function buildVerdict(
  fmcsa: FmcsaCarrier | null,
  insurance: InsuranceLine[],
  operational: OperationalRecord,
): SafetyVerdict {
  const risks: string[] = [];
  const strengths: string[] = [];

  // -- FMCSA signals --------------------------------------------------------
  if (!fmcsa) {
    risks.push("FMCSA record could not be fetched — verify authority manually.");
  } else {
    const status = fmcsa.operatingStatus ?? "UNKNOWN";
    if (status === "OUT_OF_SERVICE") {
      risks.push("FMCSA operating status: OUT OF SERVICE.");
    } else if (status === "NOT_AUTHORIZED" || status === "PENDING") {
      risks.push(`FMCSA operating status: ${status.replace("_", " ")}.`);
    } else if (status === "AUTHORIZED") {
      strengths.push("FMCSA authority is AUTHORIZED and active.");
    }

    if (fmcsa.safetyRating === "UNSATISFACTORY") {
      risks.push("FMCSA safety rating: UNSATISFACTORY.");
    } else if (fmcsa.safetyRating === "CONDITIONAL") {
      risks.push("FMCSA safety rating: CONDITIONAL — review CSA scores.");
    } else if (fmcsa.safetyRating === "SATISFACTORY") {
      strengths.push("FMCSA safety rating: SATISFACTORY.");
    } else if (fmcsa.safetyRating === "NONE" || !fmcsa.safetyRating) {
      // No rating yet — not a risk per se, common for newer carriers.
      // Surface only if combined with other concerns.
    }

    if (fmcsa.insurance) {
      if (!fmcsa.insurance.bmc91OnFile && fmcsa.authority.carrier) {
        risks.push("BMC-91 (carrier liability insurance) NOT on file with FMCSA.");
      }
      if (!fmcsa.insurance.cargoInsuranceFiled && fmcsa.authority.carrier) {
        risks.push("Cargo insurance NOT filed with FMCSA.");
      }
      if (fmcsa.insurance.bmc91OnFile && fmcsa.authority.carrier) {
        strengths.push("BMC-91 liability insurance on file with FMCSA.");
      }
    }

    if (typeof fmcsa.authorityAgeYears === "number" && fmcsa.authorityAgeYears < 1) {
      risks.push(
        `Operating authority is new (${fmcsa.authorityAgeYears.toFixed(1)} years) — short track record.`,
      );
    } else if (typeof fmcsa.authorityAgeYears === "number" && fmcsa.authorityAgeYears >= 3) {
      strengths.push(`Authority age: ${fmcsa.authorityAgeYears.toFixed(1)} years — established carrier.`);
    }
  }

  // -- Insurance ------------------------------------------------------------
  const missing = insurance.filter((i) => i.status === "missing");
  const expired = insurance.filter((i) => i.status === "expired");
  const expiring = insurance.filter((i) => i.status === "expiring");
  if (expired.length > 0) {
    risks.push(
      `Insurance EXPIRED: ${expired.map((i) => i.kind).join(", ")} — block bookings until renewed.`,
    );
  }
  if (missing.length > 0 && expired.length === 0) {
    risks.push(`Insurance dates missing on file: ${missing.map((i) => i.kind).join(", ")}.`);
  }
  if (expiring.length > 0) {
    risks.push(
      `Insurance expiring within 30 days: ${expiring.map((i) => `${i.kind} (${i.daysUntilExpiry}d)`).join(", ")}.`,
    );
  }
  if (expired.length === 0 && missing.length === 0 && expiring.length === 0) {
    strengths.push("All insurance lines on file and current (>30d to expiry).");
  }

  // -- Operational history --------------------------------------------------
  if (operational.loadsTotal >= 10) {
    strengths.push(`Operational history: ${operational.loadsTotal} loads booked through DispatchOS.`);
  }
  if (operational.loadsLast90d >= 5) {
    strengths.push(`Recent activity: ${operational.loadsLast90d} loads booked in last 90 days.`);
  }
  if (operational.loadsTotal === 0) {
    risks.push("No loads booked through DispatchOS yet — limited operational history.");
  }

  // -- Aggregate verdict ---------------------------------------------------
  // Red overrides everything else; if no FMCSA + zero ops we say unknown.
  let level: SafetyVerdict["level"];
  const fatalSignals = risks.filter((r) =>
    /OUT OF SERVICE|NOT AUTHORIZED|UNSATISFACTORY|EXPIRED|NOT on file/.test(r),
  );
  if (fatalSignals.length > 0) {
    level = "red";
  } else if (risks.length === 0 && fmcsa && strengths.length >= 2) {
    level = "green";
  } else if (!fmcsa && operational.loadsTotal === 0) {
    level = "unknown";
  } else {
    level = "yellow";
  }

  let summary: string;
  if (level === "green") {
    summary = "Carrier meets standard due-care criteria for broker negligent-hiring documentation.";
  } else if (level === "yellow") {
    summary = "Carrier acceptable with caveats — review risk factors before tendering high-value freight.";
  } else if (level === "red") {
    summary = "Carrier has disqualifying signals — do not tender until issues resolved.";
  } else {
    summary = "Insufficient data to render a verdict — fetch FMCSA manually and revisit.";
  }

  return { level, summary, risks, strengths };
}

/**
 * Build the full safety profile for a carrier (our client). The FMCSA fetch is
 * best-effort: if the credentials are missing or the API call fails, we still
 * return a usable profile with `fmcsa.fetched=false` so the UI can flag it.
 */
export async function buildCarrierSafetyProfile(
  clientId: string,
): Promise<CarrierSafetyProfile | null> {
  const client = storage.getClient(clientId);
  if (!client) return null;

  let fmcsa: FmcsaCarrier | null = null;
  let fmcsaError: string | undefined;
  let fmcsaFetched = false;

  const normalizedMc = normalizeMcNumber(client.mc);
  const webKey = getIntegrationValue("fmcsa", "FMCSA_WEB_KEY");
  if (!normalizedMc) {
    fmcsaError = `Cannot normalize MC number: "${client.mc}"`;
  } else if (!webKey) {
    fmcsaError = "FMCSA_WEB_KEY not configured — set it in Integrations.";
  } else {
    // Audit V2-16 — cache per (MC, webKey). SAFER snapshot doesn't change
    // daily, and FMCSA's mobile API has a shared 10K/day quota. Without cache,
    // a dispatcher refreshing a profile page 10x burns 10 quota units. The key
    // includes a hash of the web key so a rotated/different credential can't be
    // served a stale result; negative results get a short TTL (see setter).
    const cacheKey = fmcsaCacheKey(normalizedMc, webKey);
    const cached = fmcsaCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      fmcsa = cached.value;
      fmcsaFetched = true;
    } else {
      try {
        fmcsa = await fetchByMc(normalizedMc, { webKey });
        fmcsaFetched = true;
        setFmcsaCache(cacheKey, fmcsa);
      } catch (err) {
        fmcsaError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const insurance = readInsuranceFromClient(client);
  const operational = buildOperationalRecord(clientId);
  const verdict = buildVerdict(fmcsa, insurance, operational);

  return {
    clientId: client.id,
    clientName: client.name,
    mc: client.mc,
    generatedAt: new Date().toISOString(),
    fmcsa: { fetched: fmcsaFetched, error: fmcsaError, raw: fmcsa },
    insurance,
    operational,
    verdict,
    disclaimer:
      "This snapshot is generated for the carrier's own operational and broker-defense " +
      "documentation. It reflects information as of the timestamp above. FMCSA data is " +
      "fetched live from official sources but DispatchOS does not provide legal advice " +
      "or guarantee compliance. Brokers should perform their own due diligence under " +
      "Montgomery v. Caribe Transport II (SCOTUS 2026).",
  };
}

// ---------------------------------------------------------------------------
// Markdown renderer (lighter than PDF; brokers can paste into their file)
// ---------------------------------------------------------------------------

function statusBadge(level: SafetyVerdict["level"]): string {
  if (level === "green") return "🟢 GREEN";
  if (level === "yellow") return "🟡 YELLOW";
  if (level === "red") return "🔴 RED";
  return "⚪ UNKNOWN";
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  // A non-empty but unparseable date (e.g. a malformed client-supplied
  // insurance ISO that classifyExpiry passes through verbatim) would make
  // new Date(iso).toISOString() throw "RangeError: Invalid time value".
  // Fall back to a placeholder instead of crashing the whole render.
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toISOString().slice(0, 10);
}

// Escape characters that are structural in Markdown (and strip control
// characters / newlines) before embedding externally-sourced strings —
// FMCSA legal name / address / phone and the client name/MC are untrusted
// and could otherwise inject links, images, or break list/heading layout
// when the document is pasted into a viewer or converted to PDF. Benign
// values (plain names, MC numbers, addresses) are unaffected.
function escapeMarkdown(value: string | null | undefined): string {
  if (value == null) return "";
  return String(value)
    // Collapse control characters / newlines to a single space so the value
    // cannot break out of its Markdown list item, heading, or table cell.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    // Backslash-escape the Markdown metacharacters that are dangerous INLINE
    // (links, images, code, emphasis, strikethrough, table cells, raw HTML) so
    // external text renders literally rather than as active markup. Chars that
    // are only structural at line-start (- . + # { }) are intentionally NOT
    // escaped: these values are embedded mid-line, and escaping them would
    // mangle legitimate content like "MC-123456" or "5.5" into "MC\-123456".
    .replace(/([\\`*_[\]()!|<>~])/g, "\\$1")
    .trim();
}

export function renderCarrierSafetyProfileMarkdown(profile: CarrierSafetyProfile): string {
  const lines: string[] = [];
  lines.push(`# Carrier Safety Profile — ${escapeMarkdown(profile.clientName)}`);
  lines.push("");
  lines.push(`**MC:** ${escapeMarkdown(profile.mc)}`);
  if (profile.fmcsa.raw?.dotNumber) {
    lines.push(`**USDOT:** ${escapeMarkdown(profile.fmcsa.raw.dotNumber)}`);
  }
  lines.push(`**Generated:** ${formatDate(profile.generatedAt)}`);
  lines.push("");
  lines.push(`## Verdict: ${statusBadge(profile.verdict.level)}`);
  lines.push("");
  lines.push(`> ${profile.verdict.summary}`);
  lines.push("");

  if (profile.verdict.strengths.length > 0) {
    lines.push("### Strengths");
    for (const s of profile.verdict.strengths) lines.push(`- ${s}`);
    lines.push("");
  }
  if (profile.verdict.risks.length > 0) {
    lines.push("### Risk factors");
    for (const r of profile.verdict.risks) lines.push(`- ${r}`);
    lines.push("");
  }

  lines.push("## FMCSA SAFER record");
  if (!profile.fmcsa.fetched) {
    // The error string can embed client-supplied MC text (see buildCarrierSafetyProfile)
    // or an upstream fetch error message — both untrusted, so escape like other external fields.
    lines.push(`_FMCSA fetch unavailable: ${escapeMarkdown(profile.fmcsa.error ?? "unknown error")}._`);
  } else if (!profile.fmcsa.raw) {
    lines.push("_No FMCSA record found for this MC number._");
  } else {
    const f = profile.fmcsa.raw;
    lines.push(`- **Legal name:** ${escapeMarkdown(f.legalName)}`);
    if (f.dbaName) lines.push(`- **DBA:** ${escapeMarkdown(f.dbaName)}`);
    if (f.address) {
      const a = f.address;
      const parts = [a.street, a.city, a.state, a.zip]
        .filter(Boolean)
        .map((part) => escapeMarkdown(part))
        .join(", ");
      if (parts) lines.push(`- **Address:** ${parts}`);
    }
    if (f.phone) lines.push(`- **Phone:** ${escapeMarkdown(f.phone)}`);
    if (f.operatingStatus) lines.push(`- **Operating status:** ${f.operatingStatus.replace("_", " ")}`);
    if (f.safetyRating) lines.push(`- **Safety rating:** ${f.safetyRating}`);
    if (typeof f.authorityAgeYears === "number") {
      lines.push(`- **Authority age:** ${f.authorityAgeYears.toFixed(1)} years`);
    }
    if (f.powerUnits != null) lines.push(`- **Power units:** ${f.powerUnits}`);
    if (f.drivers != null) lines.push(`- **Drivers:** ${f.drivers}`);
    if (f.authority) {
      const types = [
        f.authority.carrier ? "carrier" : null,
        f.authority.broker ? "broker" : null,
        f.authority.freightForwarder ? "freight-forwarder" : null,
      ].filter(Boolean).join(", ");
      if (types) lines.push(`- **Authority type:** ${types}`);
    }
    if (f.insurance) {
      const ins = [
        f.insurance.bmc91OnFile ? "BMC-91 ✓" : "BMC-91 ✗",
        f.insurance.bmc84OnFile ? "BMC-84 ✓" : "BMC-84 ✗",
        f.insurance.cargoInsuranceFiled ? "Cargo ✓" : "Cargo ✗",
      ].join(", ");
      lines.push(`- **FMCSA insurance filings:** ${ins}`);
    }
  }
  lines.push("");

  lines.push("## Insurance");
  for (const ins of profile.insurance) {
    const label = ins.kind === "cargo" ? "Cargo" : ins.kind === "liability" ? "Auto liability" : "General liability";
    if (ins.status === "missing") {
      lines.push(`- **${label}:** _not on file_`);
    } else {
      const days = ins.daysUntilExpiry !== null ? ` (${ins.daysUntilExpiry}d)` : "";
      lines.push(`- **${label}:** expires ${formatDate(ins.expiresAt)} — ${ins.status.toUpperCase()}${days}`);
    }
  }
  lines.push("");

  lines.push("## Operational history (DispatchOS)");
  lines.push(`- **Loads total:** ${profile.operational.loadsTotal}`);
  lines.push(`- **Loads last 90 days:** ${profile.operational.loadsLast90d}`);
  lines.push(`- **Loads delivered:** ${profile.operational.loadsDelivered}`);
  lines.push(`- **Currently active:** ${profile.operational.loadsActive}`);
  if (profile.operational.firstActivityAt) {
    lines.push(`- **First activity:** ${formatDate(profile.operational.firstActivityAt)}`);
  }
  if (profile.operational.lastActivityAt) {
    lines.push(`- **Most recent activity:** ${formatDate(profile.operational.lastActivityAt)}`);
  }
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("### Legal notice");
  lines.push(profile.disclaimer);
  lines.push("");
  lines.push(
    "_Generated by DispatchOS · Created for use in broker due-diligence under " +
      "Montgomery v. Caribe Transport II (SCOTUS 2026)._",
  );

  return lines.join("\n");
}
