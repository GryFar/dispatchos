// =============================================================================
// /billing — customer-facing billing page (carrier owners, role 'driver')
// =============================================================================
//
// Self-serve signups get role 'driver'; the carrier OWNER among them manages
// the subscription here. Mirrors /admin/billing but talks to the billing API
// without a clientId (the server resolves the owner's own carrier and rejects
// non-owners with 403).
//
// Upgrade → POST /api/billing/checkout → Stripe Checkout (hosted).
// Manage billing → POST /api/billing/portal → Stripe Customer Portal.
// Strings are local literals (translations.ts is owned by another change).
// -----------------------------------------------------------------------------

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Loader2,
  Sparkles,
} from "lucide-react";
import { apiJson, ApiError } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const S = {
  title: "Billing",
  back: "Back to dashboard",
  notOwnerTitle: "Owner access only",
  notOwnerBody:
    "Only the account owner can view and manage billing. Ask the person who created this carrier account.",
  notConfiguredTitle: "Billing is not set up yet",
  notConfiguredBody:
    "Payments aren't enabled on this deployment. Contact support if you believe this is an error.",
  loadFailed: "Couldn't load billing status.",
  checkoutSuccess: "Payment set up — thank you! Your subscription is being activated.",
  checkoutCanceled: "Checkout was canceled. You can pick a plan any time.",
  currentPlan: "Current plan",
  trial: "Trial",
  rate: "Rate",
  trialEnds: "Trial ends",
  daysLeft: (n: number) => `${n} day${n === 1 ? "" : "s"} left`,
  driverSeats: "Driver seats",
  manageBilling: "Manage billing",
  expiredTitle: "Your trial has ended",
  expiredBody:
    "Your account is read-only. Choose a plan below to reactivate dispatching.",
  availablePlans: "Available plans",
  current: "Current",
  upgrade: "Upgrade",
  switchPlan: "Switch plan",
  subscribe: "Subscribe",
  changeInPortal: "Change plan in billing portal",
  checkoutFailed: "Couldn't open checkout",
  portalFailed: "Couldn't open the billing portal",
  statusLabels: {
    trial: "Trial",
    active: "Active",
    past_due: "Past due",
    canceled: "Canceled",
    expired: "Expired",
  } as Record<string, string>,
  perSeat: (d: number) => `+$${d}/seat`,
  seatsIncluded: (n: number | string) => `${n} driver seats included`,
  featSafety: "Carrier safety profile",
  featVetting: "Premium broker vetting",
  featApi: "API access & webhooks",
};

interface BillingStatus {
  configured: boolean;
  message?: string;
  clientId?: string;
  isBillingOwner?: boolean;
  planTier?: string;
  planLabel?: string;
  monthlyCents?: number;
  billingStatus?: "trial" | "active" | "past_due" | "canceled" | "expired";
  trialEndsAt?: string | null;
  hasStripeCustomer?: boolean;
  hasSubscription?: boolean;
  seats?: {
    includedDriverSeats: number;
    additionalDriverCents: number;
    driverSeatCount: number;
  };
}

interface PlanDto {
  tier: string;
  label: string;
  persona: "owner_operator" | "fleet" | "enterprise";
  monthlyCents: number;
  includedDriverSeats: number;
  additionalDriverCents: number;
  features?: {
    carrierSafetyProfile?: boolean;
    counterpartyVettingPremium?: boolean;
    apiAccess?: boolean;
  };
}

const STATUS_BADGE_CLASS: Record<string, string> = {
  trial: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/20",
  active: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  past_due: "bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/20",
  canceled: "bg-muted text-muted-foreground border-border",
  expired: "bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/20",
};

export default function CustomerBillingPage() {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const statusQ = useQuery<BillingStatus>({
    queryKey: ["/api/billing/status", "customer"],
    queryFn: () => apiJson("GET", "/api/billing/status"),
    retry: false,
  });
  const pricingQ = useQuery<{ plans: PlanDto[]; trialDays: number }>({
    queryKey: ["/api/public/pricing"],
  });

  // The stripped hash-location hook hides ?query from wouter, so read the
  // checkout return state straight from the raw hash (same as signup.tsx).
  const hashQuery = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const checkoutOutcome = hashQuery.get("checkout");

  async function startCheckout(tier: string) {
    setBusy(tier);
    try {
      const res = await apiJson<{ url: string }>("POST", "/api/billing/checkout", {
        tier,
        successPath: "/billing",
        cancelPath: "/billing",
      });
      window.location.href = res.url;
    } catch (err) {
      toast({
        title: S.checkoutFailed,
        description: (err as Error).message,
        variant: "destructive",
      });
      setBusy(null);
    }
  }

  async function openPortal() {
    setBusy("portal");
    try {
      const res = await apiJson<{ url: string }>("POST", "/api/billing/portal", {});
      window.location.href = res.url;
    } catch (err) {
      toast({
        title: S.portalFailed,
        description: (err as Error).message,
        variant: "destructive",
      });
      setBusy(null);
    }
  }

  const notOwner = statusQ.error instanceof ApiError && statusQ.error.status === 403;

  let body: JSX.Element;
  if (statusQ.isLoading || pricingQ.isLoading) {
    body = (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  } else if (notOwner) {
    body = <NoticeCard title={S.notOwnerTitle} text={S.notOwnerBody} />;
  } else if (statusQ.error) {
    body = <NoticeCard title={S.loadFailed} text={(statusQ.error as Error).message} />;
  } else if (!statusQ.data?.configured) {
    body = <NoticeCard title={S.notConfiguredTitle} text={S.notConfiguredBody} />;
  } else {
    body = (
      <BillingBody
        status={statusQ.data}
        plans={pricingQ.data?.plans ?? []}
        checkoutOutcome={checkoutOutcome}
        busy={busy}
        onCheckout={startCheckout}
        onPortal={openPortal}
      />
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-3 px-4">
          <a
            href="#/d/"
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            {S.back}
          </a>
          <h1 className="ml-auto flex items-center gap-2 text-base font-semibold">
            <CreditCard className="h-4 w-4" />
            {S.title}
          </h1>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 space-y-6 px-4 py-6">{body}</main>
    </div>
  );
}

function NoticeCard({ title, text }: { title: string; text: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertCircle className="h-4 w-4 text-amber-500" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">{text}</CardContent>
    </Card>
  );
}

function BillingBody({
  status,
  plans,
  checkoutOutcome,
  busy,
  onCheckout,
  onPortal,
}: {
  status: BillingStatus;
  plans: PlanDto[];
  checkoutOutcome: string | null;
  busy: string | null;
  onCheckout: (tier: string) => void;
  onPortal: () => void;
}) {
  const trialDaysLeft = status.trialEndsAt
    ? Math.max(
        0,
        Math.ceil(
          (new Date(status.trialEndsAt).getTime() - Date.now()) / (24 * 3600 * 1000),
        ),
      )
    : null;

  const currentPlan = plans.find((p) => p.tier === status.planTier);
  const persona = currentPlan?.persona ?? "owner_operator";
  const availablePlans = plans.filter((p) => p.persona === persona);
  const expired = status.billingStatus === "expired";
  // "Actually subscribed" — a live Stripe subscription exists. Trial (from
  // onboarding), expired and canceled carriers have a planTier stamped but no
  // live sub: their "Current" plan is exactly the one that needs a Subscribe
  // button. Live subscribers change plans via the Customer Portal instead of
  // Checkout (a second Checkout would create a second subscription).
  const subscribed =
    Boolean(status.hasSubscription) &&
    status.billingStatus !== "canceled" &&
    status.billingStatus !== "expired";

  return (
    <>
      {checkoutOutcome === "success" && (
        <Card className="border-emerald-300/40 bg-emerald-50/30 dark:bg-emerald-950/10">
          <CardContent className="flex items-center gap-3 p-4">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            <p className="text-sm">{S.checkoutSuccess}</p>
          </CardContent>
        </Card>
      )}
      {checkoutOutcome === "canceled" && (
        <Card className="border-amber-300/40 bg-amber-50/30 dark:bg-amber-950/10">
          <CardContent className="flex items-center gap-3 p-4">
            <AlertCircle className="h-5 w-5 text-amber-600" />
            <p className="text-sm">{S.checkoutCanceled}</p>
          </CardContent>
        </Card>
      )}

      {expired && (
        <Card className="border-rose-400/50 bg-rose-50/40 dark:bg-rose-950/20">
          <CardContent className="flex items-start gap-3 p-4">
            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-rose-600" />
            <div>
              <p className="text-sm font-semibold">{S.expiredTitle}</p>
              <p className="mt-0.5 text-sm text-muted-foreground">{S.expiredBody}</p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <CreditCard className="h-4 w-4" />
              {S.currentPlan}
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {status.planLabel ?? S.trial}
            </p>
          </div>
          {status.billingStatus && (
            <Badge
              variant="outline"
              className={`text-[10px] ${STATUS_BADGE_CLASS[status.billingStatus] ?? ""}`}
            >
              {S.statusLabels[status.billingStatus] ?? status.billingStatus}
            </Badge>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label={S.rate} value={`$${((status.monthlyCents ?? 0) / 100).toFixed(0)}/mo`} />
            {trialDaysLeft != null && status.billingStatus === "trial" && (
              <Stat
                label={S.trialEnds}
                value={S.daysLeft(trialDaysLeft)}
                hint={
                  status.trialEndsAt
                    ? new Date(status.trialEndsAt).toLocaleDateString()
                    : ""
                }
              />
            )}
            <Stat
              label={S.driverSeats}
              value={`${status.seats?.driverSeatCount ?? 0} / ${
                status.seats?.includedDriverSeats === 999
                  ? "∞"
                  : status.seats?.includedDriverSeats ?? 0
              }`}
              hint={
                (status.seats?.additionalDriverCents ?? 0) > 0
                  ? S.perSeat((status.seats?.additionalDriverCents ?? 0) / 100)
                  : ""
              }
            />
          </div>

          {status.hasStripeCustomer && (
            <Button
              variant="outline"
              size="sm"
              onClick={onPortal}
              disabled={busy === "portal"}
              className="gap-2"
            >
              {busy === "portal" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ExternalLink className="h-3.5 w-3.5" />
              )}
              {S.manageBilling}
            </Button>
          )}
        </CardContent>
      </Card>

      <div>
        <h2 className="mb-3 text-base font-semibold">{S.availablePlans}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {availablePlans.map((p) => {
            const isCurrent = p.tier === status.planTier;
            const isUpgrade = (p.monthlyCents ?? 0) > (status.monthlyCents ?? 0);
            return (
              <Card
                key={p.tier}
                className={`p-4 transition-all ${
                  isCurrent ? "border-primary bg-primary/5" : "hover:border-primary/40"
                }`}
              >
                <div className="flex items-baseline justify-between">
                  <h3 className="text-sm font-semibold">{p.label}</h3>
                  {isCurrent && (
                    <Badge variant="secondary" className="text-[10px]">
                      {S.current}
                    </Badge>
                  )}
                </div>
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="text-2xl font-bold">
                    ${(p.monthlyCents / 100).toFixed(0)}
                  </span>
                  <span className="text-xs text-muted-foreground">/mo</span>
                </div>
                <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                  <li className="flex items-start gap-1.5">
                    <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-emerald-500" />
                    <span>
                      {S.seatsIncluded(
                        p.includedDriverSeats === 999 ? "∞" : p.includedDriverSeats,
                      )}
                    </span>
                  </li>
                  {p.features?.carrierSafetyProfile && (
                    <PlanFeature text={S.featSafety} />
                  )}
                  {p.features?.counterpartyVettingPremium && (
                    <PlanFeature text={S.featVetting} />
                  )}
                  {p.features?.apiAccess && <PlanFeature text={S.featApi} />}
                </ul>
                {/* Not subscribed yet (trial/expired/canceled): every plan —
                    especially the already-chosen "Current" one — is buyable
                    via Checkout. Subscribed: plan changes go through the
                    Customer Portal (server 409s a second Checkout). */}
                {!subscribed ? (
                  <Button
                    size="sm"
                    className="mt-3 w-full"
                    variant={isCurrent || isUpgrade || expired ? "default" : "outline"}
                    onClick={() => onCheckout(p.tier)}
                    disabled={busy !== null}
                  >
                    {busy === p.tier ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : isCurrent ? (
                      S.subscribe
                    ) : isUpgrade || expired ? (
                      S.upgrade
                    ) : (
                      S.switchPlan
                    )}
                  </Button>
                ) : (
                  !isCurrent && (
                    <Button
                      size="sm"
                      className="mt-3 w-full"
                      variant="outline"
                      onClick={onPortal}
                      disabled={busy !== null}
                    >
                      {busy === "portal" ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        S.changeInPortal
                      )}
                    </Button>
                  )
                )}
              </Card>
            );
          })}
        </div>
      </div>
    </>
  );
}

function PlanFeature({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-1.5">
      <Sparkles className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-500" />
      <span>{text}</span>
    </li>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
