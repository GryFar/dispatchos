// Billing status banner — shows on every admin/dispatch page.
//
// States:
//   trial         — "Trial ends in N days" (only when N <= 7)
//   active        — nothing rendered
//   past_due      — red "Payment failed — update card" CTA → /admin/billing
//   canceled      — amber "Subscription canceled" CTA
//   expired       — red "Account read-only" CTA (blocks most actions server-side)
//
// Pulls /api/billing/status; doesn't render anything if Stripe isn't configured.

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AlertTriangle, Clock, CreditCard } from "lucide-react";
import { apiJson } from "@/lib/queryClient";
import { useT } from "@/lib/i18n";

interface BillingStatus {
  configured: boolean;
  planTier?: string;
  planLabel?: string;
  billingStatus?: "trial" | "active" | "past_due" | "canceled" | "expired";
  trialEndsAt?: string | null;
}

export function BillingBanner() {
  const { t } = useT();
  const [, setLocation] = useLocation();
  const q = useQuery<BillingStatus>({
    queryKey: ["/api/billing/status"],
    queryFn: () => apiJson("GET", "/api/billing/status"),
    // 5 min poll — status changes via webhook are reflected in UI without a full refresh.
    refetchInterval: 5 * 60 * 1000,
    // Don't hammer this endpoint while logged-out / non-staff.
    retry: false,
    // Keep the last-known status if a poll fails transiently (network blip / 500).
    // Otherwise a momentary failure would silently drop a critical past_due/expired
    // banner until the next 5-min refetch. With retry:false there's no auto recovery.
    placeholderData: keepPreviousData,
  });

  const s = q.data;
  if (!s?.configured) return null;
  const status = s.billingStatus;

  if (status === "active") return null;

  // Trial: only render when < 7 days left
  if (status === "trial") {
    if (!s.trialEndsAt) return null;
    const days = Math.ceil(
      (new Date(s.trialEndsAt).getTime() - Date.now()) / (24 * 3600 * 1000),
    );
    if (days > 7) return null;
    if (days <= 0) {
      return (
        <Banner
          tone="red"
          icon={<AlertTriangle className="h-4 w-4" />}
          text={t("BillingBanner.trialEnded", { plan: s.planLabel ?? t("BillingBanner.upgrade") })}
          cta={t("BillingBanner.upgrade")}
          onCta={() => setLocation("/admin/billing")}
        />
      );
    }
    return (
      <Banner
        tone="amber"
        icon={<Clock className="h-4 w-4" />}
        text={days === 1 ? t("BillingBanner.trialEndsInDay", { days }) : t("BillingBanner.trialEndsInDays", { days })}
        cta={t("BillingBanner.upgrade")}
        onCta={() => setLocation("/admin/billing")}
      />
    );
  }

  if (status === "past_due") {
    return (
      <Banner
        tone="red"
        icon={<CreditCard className="h-4 w-4" />}
        text={t("BillingBanner.pastDue")}
        cta={t("BillingBanner.manageBilling")}
        onCta={() => setLocation("/admin/billing")}
      />
    );
  }

  if (status === "expired") {
    return (
      <Banner
        tone="red"
        icon={<AlertTriangle className="h-4 w-4" />}
        text={t("BillingBanner.expired")}
        cta={t("BillingBanner.upgrade")}
        onCta={() => setLocation("/admin/billing")}
      />
    );
  }

  if (status === "canceled") {
    return (
      <Banner
        tone="amber"
        icon={<AlertTriangle className="h-4 w-4" />}
        text={t("BillingBanner.canceled")}
        cta={t("BillingBanner.reactivate")}
        onCta={() => setLocation("/admin/billing")}
      />
    );
  }

  return null;
}

function Banner({
  tone,
  icon,
  text,
  cta,
  onCta,
}: {
  tone: "amber" | "red";
  icon: React.ReactNode;
  text: string;
  cta: string;
  onCta: () => void;
}) {
  const cls =
    tone === "red"
      ? "border-rose-500/40 bg-rose-50/40 text-rose-900 dark:bg-rose-950/20 dark:text-rose-200"
      : "border-amber-500/40 bg-amber-50/40 text-amber-900 dark:bg-amber-950/20 dark:text-amber-200";
  return (
    <div className={`flex items-center justify-between gap-3 border-b ${cls} px-4 py-2 text-sm`}>
      <div className="flex items-center gap-2">
        {icon}
        <span>{text}</span>
      </div>
      <button
        type="button"
        onClick={onCta}
        className="rounded-md border border-current bg-transparent px-3 py-1 text-xs font-medium hover:bg-current/10"
      >
        {cta}
      </button>
    </div>
  );
}
