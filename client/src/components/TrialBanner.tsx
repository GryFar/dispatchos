// =============================================================================
// TrialBanner — slim trial countdown / expired warning for carrier OWNERS.
// =============================================================================
//
// Mounted in the driver-portal shell. Only the carrier owner sees it: the
// server's GET /api/billing/status returns 403 for non-owner drivers and sets
// isBillingOwner for owners, so the banner (and the header billing link)
// simply renders nothing for everyone else. Strings are local literals
// (translations.ts is owned by another change).
// -----------------------------------------------------------------------------

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CreditCard } from "lucide-react";
import { apiJson, ApiError } from "@/lib/queryClient";
import { useAuth } from "@/lib/use-auth";

const S = {
  expiredTitle: "Your trial has ended — account is read-only.",
  expiredCta: "Choose a plan",
  endingSoon: (n: number) =>
    n <= 0 ? "Your free trial ends today." : `Your free trial ends in ${n} day${n === 1 ? "" : "s"}.`,
  upgradeCta: "Upgrade now",
  billingLinkTitle: "Billing",
};

interface BillingStatusLite {
  configured: boolean;
  isBillingOwner?: boolean;
  billingStatus?: "trial" | "active" | "past_due" | "canceled" | "expired";
  trialEndsAt?: string | null;
}

/**
 * Shared billing-status query (react-query dedupes across the banner and the
 * header link). 403 = hired driver, not the owner — expected, don't retry.
 */
function useBillingStatusLite(): BillingStatusLite | null {
  const { user } = useAuth();
  const q = useQuery<BillingStatusLite>({
    queryKey: ["/api/billing/status", "lite"],
    queryFn: () => apiJson("GET", "/api/billing/status"),
    enabled: user?.role === "driver",
    retry: (failureCount, error) =>
      !(error instanceof ApiError && (error.status === 403 || error.status === 404)) &&
      failureCount < 2,
    staleTime: 5 * 60 * 1000,
  });
  return q.data ?? null;
}

/** Small persistent "Billing" icon link for the driver top bar (owners only). */
export function BillingLink() {
  const status = useBillingStatusLite();
  if (!status?.configured || !status.isBillingOwner) return null;
  return (
    <a
      href="#/billing"
      title={S.billingLinkTitle}
      aria-label={S.billingLinkTitle}
      className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
    >
      <CreditCard className="h-4 w-4" />
    </a>
  );
}

export function TrialBanner() {
  const status = useBillingStatusLite();
  if (!status?.configured || !status.isBillingOwner) return null;

  const expired = status.billingStatus === "expired";
  const daysLeft = status.trialEndsAt
    ? Math.max(
        0,
        Math.ceil(
          (new Date(status.trialEndsAt).getTime() - Date.now()) / (24 * 3600 * 1000),
        ),
      )
    : null;
  const endingSoon =
    status.billingStatus === "trial" && daysLeft != null && daysLeft <= 7;

  if (!expired && !endingSoon) return null;

  const cls = expired
    ? "border-rose-400/50 bg-rose-500/10 text-rose-700 dark:text-rose-300"
    : "border-amber-400/50 bg-amber-500/10 text-amber-800 dark:text-amber-300";

  return (
    <div
      className={`mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5 text-sm ${cls}`}
      role="alert"
    >
      <AlertTriangle className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
      <span className="flex-1 font-medium">
        {expired ? S.expiredTitle : S.endingSoon(daysLeft ?? 0)}
      </span>
      <a
        href="#/billing"
        className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-semibold text-white ${
          expired ? "bg-rose-600 hover:bg-rose-700" : "bg-amber-600 hover:bg-amber-700"
        }`}
      >
        {expired ? S.expiredCta : S.upgradeCta}
      </a>
    </div>
  );
}
