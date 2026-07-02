/**
 * DispatchOS — formatting helpers.
 *
 * Centralize all number/date formatting here. Components MUST NOT call
 * `toLocaleString` or `Intl.*` directly — they call these. Reason: ensures
 * consistent output across admin, dispatcher, and driver portals.
 */

import { tr } from "@/lib/i18n";

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const moneyFormatterCents = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const milesFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const dateFullFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

const dateOnlyFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

/** "$1,234" — for rates, totals. Use formatMoneyCents for invoices. */
export function formatMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return moneyFormatter.format(value);
}

/** "$1,234.56" — for invoice generation, billing totals. */
export function formatMoneyCents(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return moneyFormatterCents.format(value);
}

/** "$2.40/mi" — always 2 decimals. */
export function formatPpm(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}/mi`;
}

/** "MC-123456" — strips any non-digit and prefixes. */
export function formatMc(mc: string | null | undefined): string {
  if (!mc) return "—";
  const digits = mc.replace(/\D/g, "");
  if (!digits) return mc;
  return `MC-${digits}`;
}

/** "1,234 mi" */
export function formatMiles(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${milesFormatter.format(value)} mi`;
}

/** "3.0%" — accepts ratio 0.03 OR percent 3, decided by magnitude. */
export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const pct = Math.abs(value) <= 1 ? value * 100 : value;
  return `${pct.toFixed(1)}%`;
}

/** "Mar 15, 2:30 PM" */
export function formatDate(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = typeof iso === "string" ? new Date(iso) : iso;
    if (Number.isNaN(d.getTime())) return "—";
    return dateFormatter.format(d);
  } catch {
    return "—";
  }
}

/** "Mar 15, 2026 2:30 PM EST" — tooltip, audit log details. */
export function formatDateFull(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = typeof iso === "string" ? new Date(iso) : iso;
    if (Number.isNaN(d.getTime())) return "—";
    return dateFullFormatter.format(d);
  } catch {
    return "—";
  }
}

/** "Mar 15, 2026" — invoices, week ranges. */
export function formatDateOnly(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = typeof iso === "string" ? new Date(iso) : iso;
    if (Number.isNaN(d.getTime())) return "—";
    return dateOnlyFormatter.format(d);
  } catch {
    return "—";
  }
}

/** "5m ago", "2h ago", "3d ago" — relative time for stale indicators. */
export function formatRelativeAgo(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = typeof iso === "string" ? new Date(iso) : iso;
    const diffMs = Date.now() - d.getTime();
    const min = Math.floor(diffMs / 60_000);
    if (min < 1) return tr("format.justNow");
    if (min < 60) return tr("format.minAgo", { n: min });
    const hours = Math.floor(min / 60);
    if (hours < 24) return tr("format.hourAgo", { n: hours });
    const days = Math.floor(hours / 24);
    if (days < 30) return tr("format.dayAgo", { n: days });
    const months = Math.floor(days / 30);
    return tr("format.monthAgo", { n: months });
  } catch {
    return String(iso);
  }
}

/** Short role label for badges, role columns. */
export function formatRole(role: string | null | undefined): string {
  if (role === "admin") return tr("format.role.admin");
  if (role === "dispatcher") return tr("format.role.dispatcher");
  if (role === "driver") return tr("format.role.driver");
  return role ?? "—";
}
