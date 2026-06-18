// =============================================================================
// /admin/billing — subscription management page
// =============================================================================
//
// Shows current plan + trial countdown + Upgrade and Manage Billing buttons.
// Upgrade → /api/billing/checkout → Stripe Checkout (hosted) → success URL.
// Manage Billing → /api/billing/portal → Stripe Customer Portal.
//
// Public pricing catalogue (/api/public/pricing) drives the upgrade cards.
// -----------------------------------------------------------------------------

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  AlertCircle,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Loader2,
  Sparkles,
} from "lucide-react";
import { apiJson } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface BillingStatus {
  configured: boolean;
  message?: string;
  clientId?: string;
  planTier?: string;
  planLabel?: string;
  monthlyCents?: number;
  billingStatus?: "trial" | "active" | "past_due" | "canceled";
  trialEndsAt?: string | null;
  hasStripeCustomer?: boolean;
  hasSubscription?: boolean;
  features?: {
    carrierSafetyProfile: boolean;
    counterpartyVettingPremium: boolean;
    priorityCron: boolean;
    apiAccess: boolean;
    ssoSaml: boolean;
  };
  seats?: {
    includedDriverSeats: number;
    additionalDriverCents: number;
    driverSeatCount: number;
    includedDispatcherSeats: number;
    dispatcherSeatCount: number;
  };
}

interface PlanDto {
  tier: string;
  label: string;
  persona: "owner_operator" | "fleet" | "enterprise";
  monthlyCents: number;
  includedDriverSeats: number;
  additionalDriverCents: number;
  includedDispatcherSeats: number;
  maxMcCount: number | null;
  auditRetentionDays: number;
  features: BillingStatus["features"];
}

export default function BillingStripePage() {
  const { toast } = useToast();
  const [location] = useLocation();
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);

  // Billing is per-carrier (each client has its own plan/subscription). The
  // backend no longer guesses a carrier when several exist (V4-009), so the
  // admin must pick one — and we thread that clientId through every call.
  const clientsQ = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ["/api/clients"],
    queryFn: () => apiJson("GET", "/api/clients"),
  });
  const clients = clientsQ.data ?? [];
  // Effective carrier: explicit selection, or the sole client in a single-tenant env.
  const clientId = selectedClientId ?? (clients.length === 1 ? clients[0]!.id : null);
  const clientIdParam = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";

  const statusQ = useQuery<BillingStatus>({
    queryKey: ["/api/billing/status", clientId],
    queryFn: () => apiJson("GET", `/api/billing/status${clientIdParam}`),
    // Don't call status until a carrier is resolved (avoids the 404 when
    // multiple carriers exist and none is selected yet).
    enabled: !clientsQ.isLoading && (clients.length <= 1 || clientId != null),
  });

  const pricingQ = useQuery<{ plans: PlanDto[]; trialDays: number }>({
    queryKey: ["/api/public/pricing"],
  });

  // Read URL params for checkout return state
  const params = new URLSearchParams(location.split("?")[1] || "");
  const checkoutOutcome = params.get("checkout");

  async function startCheckout(tier: string) {
    setBusy(tier);
    try {
      const res = await apiJson<{ url: string }>("POST", `/api/billing/checkout${clientIdParam}`, {
        tier,
        successPath: "/admin/billing",
        cancelPath: "/admin/billing",
      });
      window.location.href = res.url;
    } catch (err) {
      toast({
        title: "Не удалось открыть оплату",
        description: (err as Error).message,
        variant: "destructive",
      });
      setBusy(null);
    }
  }

  async function openPortal() {
    setBusy("portal");
    try {
      const res = await apiJson<{ url: string }>("POST", `/api/billing/portal${clientIdParam}`, {});
      window.location.href = res.url;
    } catch (err) {
      toast({
        title: "Не удалось открыть Customer Portal",
        description: (err as Error).message,
        variant: "destructive",
      });
      setBusy(null);
    }
  }

  const carrierPicker =
    clients.length > 1 ? (
      <div className="flex items-center gap-2">
        <label htmlFor="billing-carrier" className="text-xs font-medium text-muted-foreground">
          Перевозчик
        </label>
        <select
          id="billing-carrier"
          value={clientId ?? ""}
          onChange={(e) => setSelectedClientId(e.target.value || null)}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="">— выберите —</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
    ) : null;

  if (clientsQ.isLoading || pricingQ.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Multiple carriers and none chosen yet — prompt for a selection.
  if (clients.length > 1 && !clientId) {
    return (
      <div className="max-w-2xl space-y-4">
        {carrierPicker}
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            Выберите перевозчика, чтобы посмотреть и изменить его подписку.
          </CardContent>
        </Card>
      </div>
    );
  }

  if (statusQ.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const status = statusQ.data;
  const plans = pricingQ.data?.plans ?? [];

  if (!status?.configured) {
    return (
      <div className="max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-amber-500" />
              Stripe не настроен
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              Чтобы принимать оплату через Stripe, добавьте API-ключи в{" "}
              <a href="#/admin/integrations" className="text-primary hover:underline">
                Settings → Integrations
              </a>{" "}
              (раздел "Stripe").
            </p>
            <p className="text-xs">
              Нужен Secret key (sk_test_... или sk_live_...) + Webhook signing
              secret (whsec_...). После настройки этой страницы тут появятся планы.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Trial countdown helper
  const trialDaysLeft = status.trialEndsAt
    ? Math.max(
        0,
        Math.ceil(
          (new Date(status.trialEndsAt).getTime() - Date.now()) / (24 * 3600 * 1000),
        ),
      )
    : null;

  const currentPlan = plans.find((p) => p.tier === status.planTier);
  const persona = currentPlan?.persona ?? "fleet";
  const availablePlans = plans.filter((p) => p.persona === persona);

  return (
    <div className="space-y-6">
      {carrierPicker}
      {/* Checkout return banner */}
      {checkoutOutcome === "success" && (
        <Card className="border-emerald-300/40 bg-emerald-50/30 dark:bg-emerald-950/10">
          <CardContent className="flex items-center gap-3 p-4">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            <p className="text-sm">
              Оплата прошла. Подписка активна; статус обновится через несколько секунд.
            </p>
          </CardContent>
        </Card>
      )}
      {checkoutOutcome === "canceled" && (
        <Card className="border-amber-300/40 bg-amber-50/30 dark:bg-amber-950/10">
          <CardContent className="flex items-center gap-3 p-4">
            <AlertCircle className="h-5 w-5 text-amber-600" />
            <p className="text-sm">Оплата отменена. Ничего не списано.</p>
          </CardContent>
        </Card>
      )}

      {/* Current plan card */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <CreditCard className="h-4 w-4" />
              Текущий план
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {status.planLabel ?? "Trial"}
            </p>
          </div>
          <BillingStatusBadge billingStatus={status.billingStatus} />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
            <Stat
              label="Ставка"
              value={`$${((status.monthlyCents ?? 0) / 100).toFixed(0)}/mo`}
            />
            {trialDaysLeft != null && status.billingStatus === "trial" && (
              <Stat
                label="Триал до"
                value={`${trialDaysLeft} дн.`}
                hint={status.trialEndsAt ? new Date(status.trialEndsAt).toLocaleDateString() : ""}
              />
            )}
            <Stat
              label="Driver seats"
              value={`${status.seats?.driverSeatCount ?? 0} / ${
                status.seats?.includedDriverSeats === 999
                  ? "∞"
                  : status.seats?.includedDriverSeats ?? 0
              }`}
              hint={
                (status.seats?.additionalDriverCents ?? 0) > 0
                  ? `+$${((status.seats?.additionalDriverCents ?? 0) / 100).toFixed(0)}/seat`
                  : ""
              }
            />
            <Stat
              label="Dispatcher seats"
              value={`${status.seats?.dispatcherSeatCount ?? 0} / ${
                status.seats?.includedDispatcherSeats === 999
                  ? "∞"
                  : status.seats?.includedDispatcherSeats ?? 0
              }`}
            />
          </div>

          {status.hasStripeCustomer && (
            <Button
              variant="outline"
              size="sm"
              onClick={openPortal}
              disabled={busy === "portal"}
              className="gap-2"
            >
              {busy === "portal" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ExternalLink className="h-3.5 w-3.5" />
              )}
              Manage in Stripe Portal
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Available upgrade plans */}
      <div>
        <h2 className="mb-3 text-base font-semibold">Доступные планы</h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
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
                  {isCurrent && <Badge variant="secondary" className="text-[10px]">Текущий</Badge>}
                </div>
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="text-2xl font-bold">${(p.monthlyCents / 100).toFixed(0)}</span>
                  <span className="text-xs text-muted-foreground">/mo</span>
                </div>
                <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                  <li className="flex items-start gap-1.5">
                    <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-emerald-500" />
                    <span>
                      {p.includedDriverSeats === 999 ? "∞" : p.includedDriverSeats} driver seats
                    </span>
                  </li>
                  {p.features?.carrierSafetyProfile && (
                    <li className="flex items-start gap-1.5">
                      <Sparkles className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-500" />
                      <span>Carrier Safety Profile</span>
                    </li>
                  )}
                  {p.features?.counterpartyVettingPremium && (
                    <li className="flex items-start gap-1.5">
                      <Sparkles className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-500" />
                      <span>Premium broker vetting</span>
                    </li>
                  )}
                  {p.features?.apiAccess && (
                    <li className="flex items-start gap-1.5">
                      <Sparkles className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-500" />
                      <span>API access + webhooks</span>
                    </li>
                  )}
                </ul>
                {!isCurrent && (
                  <Button
                    size="sm"
                    className="mt-3 w-full"
                    variant={isUpgrade ? "default" : "outline"}
                    onClick={() => startCheckout(p.tier)}
                    disabled={busy !== null}
                  >
                    {busy === p.tier ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : isUpgrade ? (
                      "Upgrade"
                    ) : (
                      "Downgrade"
                    )}
                  </Button>
                )}
              </Card>
            );
          })}
        </div>
      </div>
    </div>
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

function BillingStatusBadge({
  billingStatus,
}: {
  billingStatus?: "trial" | "active" | "past_due" | "canceled";
}) {
  if (!billingStatus) return null;
  const map = {
    trial: { label: "Trial", className: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/20" },
    active: { label: "Active", className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/20" },
    past_due: { label: "Past due", className: "bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/20" },
    canceled: { label: "Canceled", className: "bg-muted text-muted-foreground border-border" },
  };
  const c = map[billingStatus];
  return (
    <Badge variant="outline" className={`text-[10px] ${c.className}`}>
      {c.label}
    </Badge>
  );
}
