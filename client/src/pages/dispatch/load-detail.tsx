import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import {
  ArrowLeft,
  Building2,
  Clock,
  MapPin,
  Loader2,
  UserCircle2,
  UserX,
  ThumbsUp,
  TrendingDown,
  PhoneOff,
  ShieldAlert,
  Navigation,
  Truck,
  Phone,
  Hash,
  Package,
  Sparkles,
  Copy,
} from "lucide-react";
import type {
  CheckinKind,
  DispatchDriver,
  LoadCheckin,
  LoadFull,
} from "@shared/schema";
import { apiJson, ApiError } from "@/lib/queryClient";
import { TrustBadge } from "@/components/dispatch/TrustBadge";
import {
  formatMoney,
  formatDateFull,
  formatMiles,
  formatMc,
} from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/dispatch/StatusBadge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/i18n";

const DRIVER_STATUS_KEYS: Record<DispatchDriver["driverStatus"], string> = {
  available: "dispatch.load_detail.driver.status.available",
  on_route: "dispatch.load_detail.driver.status.on_route",
  off_duty: "dispatch.load_detail.driver.status.off_duty",
};

const DRIVER_STATUS_CLASS: Record<DispatchDriver["driverStatus"], string> = {
  available: "text-success",
  on_route: "text-primary",
  off_duty: "text-muted-foreground",
};

// Typed map of check-in kinds → i18n keys. Module-scoped so both the timeline
// and the driver-card last-checkin label resolve via the same compile-time-
// checked mapping (no string-interpolated keys).
const CHECKIN_LABELS_KEYS: Record<CheckinKind, string> = {
  pickup_arrived: "dispatch.load_detail.checkin.pickup_arrived",
  loaded: "dispatch.load_detail.checkin.loaded",
  in_transit: "dispatch.load_detail.checkin.in_transit",
  delivery_arrived: "dispatch.load_detail.checkin.delivery_arrived",
  delivered: "dispatch.load_detail.checkin.delivered",
  note: "dispatch.load_detail.checkin.note",
};

/**
 * /dispatch/loads/:id — load detail for the dispatcher. Route headline,
 * pickup/delivery stops, broker info + trust score, broker quick-feedback,
 * driver assignment (reassign), check-ins timeline.
 */
export default function DispatchLoadDetailPage() {
  const { t } = useT();
  const [match, params] = useRoute("/loads/:id");
  const [, setLocation] = useLocation();
  const loadId = match ? params?.id : null;

  const { data, isLoading, error } = useQuery<LoadFull>({
    queryKey: ["dispatch", "load", loadId],
    queryFn: () => apiJson<LoadFull>("GET", `/api/dispatch/loads/${loadId}`),
    enabled: Boolean(loadId),
  });

  const { data: checkinsData, error: checkinsError } = useQuery<{
    items: LoadCheckin[];
  }>({
    queryKey: ["dispatch", "load", loadId, "checkins"],
    queryFn: () =>
      apiJson<{ items: LoadCheckin[] }>(
        "GET",
        `/api/dispatch/loads/${loadId}/checkins`,
      ),
    enabled: Boolean(loadId),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <BackBar onClick={() => setLocation("/loads")} label={t("dispatch.load_detail.back")} />
        <Card className="flex h-32 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </Card>
      </div>
    );
  }

  if (error) {
    const is404 = error instanceof ApiError && error.status === 404;
    // Don't render the raw backend message into the UI — it may carry internal
    // detail and isn't localized. Log it for debugging; show a localized title.
    if (!is404) {
      console.error("[dispatch/load-detail] load fetch failed:", error);
    }
    return (
      <div className="space-y-4">
        <BackBar onClick={() => setLocation("/loads")} label={t("dispatch.load_detail.back")} />
        <Card className="border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium">
            {is404 ? t("dispatch.load_detail.not_found") : t("dispatch.load_detail.load_error")}
          </p>
          {is404 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("dispatch.load_detail.not_found_hint")}
            </p>
          )}
        </Card>
      </div>
    );
  }

  if (!data) return null;

  const isBooked = Boolean(data.driverId && data.bookedAt);

  return (
    <div className="space-y-4">
      <BackBar onClick={() => setLocation("/loads")} label={t("dispatch.load_detail.back")} />

      <Card className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("dispatch.load_detail.route")}
            </p>
            <p className="mt-1 text-lg font-semibold tracking-tight">
              {data.originCity}, {data.originState}
              <span className="mx-2 text-muted-foreground">→</span>
              {data.destinationCity}, {data.destinationState}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {formatMiles(data.loadedMiles)} mi · {data.equipment.replace(/_/g, " ")}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="font-mono text-xl font-semibold">
              {formatMoney(data.rate)}
            </p>
            <div className="mt-2">
              <StatusBadge variant={isBooked ? "active" : "info"}>
                {isBooked ? t("dispatch.load_detail.status.booked") : t("dispatch.load_detail.status.available")}
              </StatusBadge>
            </div>
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <StopBlock
            label={t("dispatch.load_detail.pickup")}
            city={data.originCity}
            state={data.originState}
            iso={data.pickupAt}
          />
          <StopBlock
            label={t("dispatch.load_detail.delivery")}
            city={data.destinationCity}
            state={data.destinationState}
            iso={data.deliveryAt}
          />
        </div>
      </Card>

      <Card className="p-4">
        <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Building2 className="h-3.5 w-3.5" /> {t("dispatch.load_detail.broker")}
        </p>
        <p className="mt-2 text-sm font-medium">{data.brokerName}</p>
        <p className="mt-0.5 font-mono text-xs text-muted-foreground">
          {formatMc(data.brokerMc)}
        </p>
        {data.notes && (
          <p className="mt-3 rounded-md border border-border bg-muted/30 p-3 text-xs">
            {data.notes}
          </p>
        )}
        <div className="mt-3">
          <TrustBadge brokerMc={data.brokerMc} />
        </div>
      </Card>

      {/* Broker feedback — one-tap trust signals (Killer #1 stage 4) */}
      <BrokerFeedbackCard brokerMc={data.brokerMc} loadId={data.id} />

      {/* AI broker-reply draft (Task-3 UI): dispatcher generates a counter-offer
          email for this load's broker. POST /api/ai/draft-broker-reply. */}
      <BrokerReplyCard loadId={data.id} clientId={(data as { clientId?: string }).clientId} />

      {/* Driver assignment (always shown — load can have or not have a driver) */}
      <DriverAssignmentCard load={data} />

      {/* Checkins timeline — surface a load failure instead of silently
          showing nothing (which is indistinguishable from "no check-ins"). */}
      {checkinsError && !checkinsData && (
        <Card className="border-destructive/40 bg-destructive/5 p-4">
          <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Clock className="h-3.5 w-3.5" /> {t("dispatch.load_detail.timeline")}
          </p>
          <p className="mt-2 text-xs text-destructive">{t("common.error")}</p>
        </Card>
      )}
      {checkinsData && checkinsData.items.length > 0 && (
        <Card className="p-4">
          <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Clock className="h-3.5 w-3.5" /> {t("dispatch.load_detail.timeline")}
          </p>
          <ul className="mt-3 space-y-2">
            {checkinsData.items.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-xs">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                <div className="flex-1">
                  <p className="font-medium">{t(CHECKIN_LABELS_KEYS[c.kind])}</p>
                  <p className="text-muted-foreground">
                    {formatDateFull(c.createdAt)}
                    {typeof c.lat === "number" && typeof c.lng === "number" && (
                      <>
                        {" "}
                        · {c.lat.toFixed(4)}, {c.lng.toFixed(4)}
                      </>
                    )}
                  </p>
                  {c.notes && (
                    <p className="mt-0.5 text-muted-foreground">{c.notes}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <p className="px-1 pb-2 text-center text-[11px] text-muted-foreground">
        ID: <span className="font-mono">{data.id}</span>
      </p>
    </div>
  );
}

function BackBar({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" />
      {label}
    </button>
  );
}

function StopBlock({
  label,
  city,
  state,
  iso,
}: {
  label: string;
  city: string;
  state: string;
  iso: string;
}) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <MapPin className="h-3 w-3" /> {label}
      </p>
      <p className="mt-1 text-sm font-medium">
        {city}, {state}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{formatDateFull(iso)}</p>
    </div>
  );
}

// AI broker-reply draft. The dispatcher asks haiku for a short counter-offer
// email for this load's broker (POST /api/ai/draft-broker-reply { loadId }).
// Mirrors the cockpit CarrierAiPanel quota handling: a 429 with code
// ai_quota_exceeded offers a per-carrier top-up; a 503 (ai_unavailable — no key
// / model failure) shows an "unavailable" note instead of an error, since the
// endpoint degrades to 503 rather than 500 by design.
function BrokerReplyCard({ loadId, clientId }: { loadId: string; clientId?: string }) {
  const { t } = useT();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [state, setState] = useState<{
    loading: boolean;
    failed?: boolean;
    unavailable?: boolean;
    quotaExhausted?: boolean;
    quotaMsg?: string;
  }>({ loading: false });
  const [buying, setBuying] = useState(false);

  // Guard against setState after unmount while the slow LLM call is in flight.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function runDraft() {
    setState({ loading: true });
    try {
      const r = await apiJson<{ draft: string }>("POST", "/api/ai/draft-broker-reply", { loadId });
      if (!mountedRef.current) return;
      setDraft(r.draft);
      setState({ loading: false });
      setOpen(true);
    } catch (err) {
      if (!mountedRef.current) return;
      // Close the dialog on a regenerate failure so the card-level note shows.
      setOpen(false);
      const code =
        err instanceof ApiError && err.body && typeof err.body === "object" && "code" in err.body
          ? (err.body as { code?: unknown }).code
          : undefined;
      const quotaExhausted = err instanceof ApiError && err.status === 429 && code === "ai_quota_exceeded";
      const unavailable = err instanceof ApiError && err.status === 503;
      setState({
        loading: false,
        failed: !quotaExhausted && !unavailable,
        unavailable,
        quotaExhausted,
        quotaMsg: quotaExhausted && err instanceof ApiError ? err.message : undefined,
      });
    }
  }

  async function buyCredits() {
    if (!clientId) return;
    setBuying(true);
    try {
      const r = await apiJson<{ ok: boolean; pack: number }>(
        "POST",
        "/api/dispatch/ai-credits/purchase",
        { clientId },
      );
      toast({ title: t("aiQuota.bought"), description: t("aiQuota.boughtDesc", { pack: r.pack }) });
      if (mountedRef.current) setState((s) => ({ ...s, quotaExhausted: false, quotaMsg: undefined }));
    } catch {
      toast({ title: t("aiQuota.buyError"), variant: "destructive" });
    } finally {
      if (mountedRef.current) setBuying(false);
    }
  }

  async function copyDraft() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft);
      toast({ title: t("dispatch.load_detail.reply.copied") });
    } catch {
      /* clipboard blocked (permissions / insecure context) — leave the text visible to copy manually */
    }
  }

  return (
    <Card className="p-4">
      <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5" /> {t("dispatch.load_detail.reply.title")}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{t("dispatch.load_detail.reply.hint")}</p>

      <Button variant="outline" size="sm" className="mt-3" onClick={runDraft} disabled={state.loading}>
        {state.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        {t("dispatch.load_detail.reply.button")}
      </Button>

      {state.quotaExhausted && (
        <div className="mt-3 space-y-2 rounded-md bg-rose-500/10 p-3 text-xs">
          <p className="text-rose-600 dark:text-rose-400">
            {state.quotaMsg ?? t("dispatch.load_detail.reply.error")}
          </p>
          {clientId && (
            <Button variant="outline" size="sm" onClick={buyCredits} disabled={buying}>
              {buying ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("aiQuota.buy")}
            </Button>
          )}
        </div>
      )}
      {state.unavailable && (
        <p className="mt-3 text-xs text-muted-foreground">{t("dispatch.load_detail.reply.unavailable")}</p>
      )}
      {state.failed && (
        <p className="mt-3 text-xs text-muted-foreground">{t("dispatch.load_detail.reply.error")}</p>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("dispatch.load_detail.reply.dialog_title")}</DialogTitle>
            <DialogDescription>{t("dispatch.load_detail.reply.hint")}</DialogDescription>
          </DialogHeader>
          <textarea
            readOnly
            value={draft ?? ""}
            rows={10}
            className="w-full resize-none rounded-md border border-border bg-muted/30 p-3 text-sm"
          />
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={copyDraft} className="mr-auto">
              <Copy className="h-4 w-4" />
              {t("dispatch.load_detail.reply.copy")}
            </Button>
            <Button variant="outline" onClick={runDraft} disabled={state.loading}>
              {state.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("dispatch.load_detail.reply.regenerate")}
            </Button>
            <Button onClick={() => setOpen(false)}>{t("dispatch.load_detail.reply.close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// Quick-tap broker trust signals. Each button POSTs one signal and refreshes
// the TrustBadge (same query key). Killer #1 stage 4.
function BrokerFeedbackCard({ brokerMc, loadId }: { brokerMc: string; loadId: string }) {
  const { t } = useT();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);

  const FEEDBACK_BUTTONS: {
    signalType: string;
    positive: boolean;
    labelKey: string;
    icon: typeof ThumbsUp;
    variant: "good" | "bad";
  }[] = [
    { signalType: "paid_on_time", positive: true, labelKey: "dispatch.load_detail.feedback.paid_on_time", icon: ThumbsUp, variant: "good" },
    { signalType: "ratecon_reduced_post_bol", positive: false, labelKey: "dispatch.load_detail.feedback.rate_cut", icon: TrendingDown, variant: "bad" },
    { signalType: "no_response", positive: false, labelKey: "dispatch.load_detail.feedback.no_response", icon: PhoneOff, variant: "bad" },
    { signalType: "fraud_attempt", positive: false, labelKey: "dispatch.load_detail.feedback.fraud", icon: ShieldAlert, variant: "bad" },
  ];

  const mutation = useMutation({
    mutationFn: (input: { signalType: string; positive: boolean }) =>
      apiJson("POST", "/api/broker-trust/signal", {
        brokerMc,
        loadId,
        signalType: input.signalType,
        positive: input.positive,
      }),
    onMutate: (input) => setPending(input.signalType),
    onSuccess: () => {
      toast({ title: t("dispatch.load_detail.saved"), description: t("dispatch.load_detail.saved_desc") });
      qc.invalidateQueries({ queryKey: ["/api/broker-trust", brokerMc] });
    },
    onError: (err: Error) =>
      toast({ title: t("dispatch.load_detail.save_error"), description: err.message, variant: "destructive" }),
    onSettled: () => setPending(null),
  });

  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t("dispatch.load_detail.rate_broker")}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("dispatch.load_detail.rate_broker_hint")}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {FEEDBACK_BUTTONS.map((b) => {
          const Icon = b.icon;
          const isPending = pending === b.signalType;
          return (
            <Button
              key={b.signalType}
              variant="outline"
              size="sm"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate({ signalType: b.signalType, positive: b.positive })}
              className={
                b.variant === "good"
                  ? "justify-start border-success/30 text-success hover:bg-success/10"
                  : "justify-start border-destructive/30 text-destructive hover:bg-destructive/10"
              }
            >
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
              {t(b.labelKey)}
            </Button>
          );
        })}
      </div>
    </Card>
  );
}

function DriverAssignmentCard({ load }: { load: LoadFull }) {
  const { t } = useT();
  const [reassignOpen, setReassignOpen] = useState(false);
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);
  const { toast } = useToast();
  const qc = useQueryClient();
  const clientId = (load as { clientId?: string }).clientId;

  // Load list of drivers for this client (only when dialog opens, to save bandwidth)
  const driversQuery = useQuery<{ items: DispatchDriver[] }>({
    queryKey: ["dispatch", "clients", clientId, "drivers"],
    queryFn: () =>
      apiJson<{ items: DispatchDriver[] }>(
        "GET",
        `/api/dispatch/clients/${clientId}/drivers`,
      ),
    enabled: reassignOpen && Boolean(clientId),
  });

  // Find current driver in the list (after it loads) to display name
  const currentDriver = driversQuery.data?.items.find(
    (d) => d.id === load.driverId,
  );

  // Driver whose detail card we show: the pending selection, else the
  // already-assigned one. Drives the rich card under the Select.
  const selectedDriver = driversQuery.data?.items.find(
    (d) => d.id === (selectedDriverId ?? load.driverId),
  );

  const reassignMutation = useMutation({
    mutationFn: (input: { driverId: string | null; expectedDriverId: string | null }) =>
      apiJson("PATCH", `/api/dispatch/loads/${load.id}`, {
        driverId: input.driverId,
        // Optimistic concurrency: the driverId we saw when the dialog opened.
        // The server's atomic guard rejects the write (409) if the load moved
        // since then, preventing a silent double-book (Корень #1).
        expectedDriverId: input.expectedDriverId,
      }),
    onSuccess: () => {
      toast({
        title: t("dispatch.load_detail.updated"),
        description: selectedDriverId
          ? t("dispatch.load_detail.assigned_desc")
          : t("dispatch.load_detail.unassigned_desc"),
      });
      // Refetch the load to pull fresh driverId
      qc.invalidateQueries({ queryKey: ["dispatch", "load", load.id] });
      qc.invalidateQueries({ queryKey: ["dispatch", "loads"] });
      setReassignOpen(false);
      setSelectedDriverId(null);
    },
    onError: (err: Error) => {
      // 409 = someone reassigned this load first. Don't show a generic error —
      // tell the user and refetch so they see the current driver before retrying.
      if (err instanceof ApiError && err.status === 409) {
        toast({
          title: t("dispatch.load_detail.reassign_conflict_title"),
          description: t("dispatch.load_detail.reassign_conflict_desc"),
          variant: "destructive",
        });
        qc.invalidateQueries({ queryKey: ["dispatch", "load", load.id] });
        qc.invalidateQueries({ queryKey: ["dispatch", "loads"] });
        setReassignOpen(false);
        setSelectedDriverId(null);
        return;
      }
      toast({
        title: t("dispatch.load_detail.update_error"),
        description: err.message,
        variant: "destructive",
      });
    },
  });

  return (
    <>
      <Card className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("dispatch.load_detail.assignment.label")}
            </p>
            {load.driverId ? (
              <>
                <p className="mt-2 text-sm font-medium">
                  {currentDriver?.fullName || t("dispatch.load_detail.assignment.driver_fallback")}
                </p>
                <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                  {load.driverId}
                </p>
                {load.bookedAt && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("dispatch.load_detail.booked_at", { date: formatDateFull(load.bookedAt) })}
                  </p>
                )}
              </>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                {t("dispatch.load_detail.assignment.no_driver")}
              </p>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReassignOpen(true)}
            disabled={!clientId}
          >
            <UserCircle2 className="h-4 w-4" />
            {load.driverId
              ? t("dispatch.load_detail.assignment.reassign")
              : t("dispatch.load_detail.assignment.assign")}
          </Button>
        </div>
      </Card>

      <Dialog open={reassignOpen} onOpenChange={setReassignOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {load.driverId
                ? t("dispatch.load_detail.dialog.title_reassign")
                : t("dispatch.load_detail.dialog.title_assign")}
            </DialogTitle>
            <DialogDescription>
              {t("dispatch.load_detail.dialog.desc")}
            </DialogDescription>
          </DialogHeader>

          <div className="py-2">
            {driversQuery.isLoading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : driversQuery.data?.items.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                {t("dispatch.load_detail.dialog.no_drivers")}
              </p>
            ) : (
              <Select
                value={selectedDriverId ?? load.driverId ?? ""}
                onValueChange={setSelectedDriverId}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("dispatch.load_detail.dialog.select_driver")} />
                </SelectTrigger>
                <SelectContent>
                  {driversQuery.data?.items.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      <span className="flex items-center gap-2">
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            d.online ? "bg-success" : "bg-muted-foreground/40"
                          }`}
                        />
                        <span className="font-medium">{d.fullName || d.email}</span>
                        <span className={`text-xs ${DRIVER_STATUS_CLASS[d.driverStatus]}`}>
                          {t(DRIVER_STATUS_KEYS[d.driverStatus])}
                        </span>
                        {d.currentLoad && (
                          <span className="text-xs text-muted-foreground">
                            · {d.currentLoad.originState} → {d.currentLoad.destinationState}
                          </span>
                        )}
                        {d.capacity && (
                          <span className="text-xs text-muted-foreground">
                            · {d.capacity.free}/{d.capacity.total}
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {selectedDriver && (
            <div className="rounded-md border border-border bg-muted/20 p-3 text-xs">
              <div className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    selectedDriver.online ? "bg-success" : "bg-muted-foreground/40"
                  }`}
                />
                <span className="font-medium text-foreground">
                  {selectedDriver.fullName || selectedDriver.email}
                </span>
                <span className={DRIVER_STATUS_CLASS[selectedDriver.driverStatus]}>
                  {t(DRIVER_STATUS_KEYS[selectedDriver.driverStatus])}
                </span>
                {selectedDriver.unitNumber && (
                  <span className="ml-auto inline-flex items-center gap-1 font-mono text-muted-foreground">
                    <Hash className="h-3 w-3" />
                    {selectedDriver.unitNumber}
                  </span>
                )}
              </div>

              <dl className="mt-3 space-y-1.5">
                <div className="flex items-start gap-2">
                  <Truck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span>
                    {selectedDriver.currentLoad ? (
                      <>
                        {selectedDriver.currentLoad.originCity},{" "}
                        {selectedDriver.currentLoad.originState}
                        <span className="mx-1 text-muted-foreground">→</span>
                        {selectedDriver.currentLoad.destinationCity},{" "}
                        {selectedDriver.currentLoad.destinationState}
                      </>
                    ) : (
                      <span className="text-muted-foreground">
                        {t("dispatch.load_detail.driver.no_load")}
                      </span>
                    )}
                  </span>
                </div>

                {selectedDriver.capacity && (
                  <div className="flex items-center gap-2">
                    <Package className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span>
                      {t("dispatch.load_detail.driver.capacity")}:{" "}
                      <span className="font-medium">
                        {selectedDriver.capacity.free}/{selectedDriver.capacity.total}
                      </span>{" "}
                      <span className="text-muted-foreground">
                        ({selectedDriver.activeLoadsCount}{" "}
                        {t("dispatch.load_detail.driver.in_work")})
                      </span>
                    </span>
                  </div>
                )}

                <div className="flex items-start gap-2">
                  <Navigation className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  {selectedDriver.location ? (
                    <span>
                      {selectedDriver.location.lat.toFixed(4)},{" "}
                      {selectedDriver.location.lng.toFixed(4)}
                      {selectedDriver.location.source && (
                        <span className="ml-1 text-muted-foreground">
                          · {selectedDriver.location.source}
                        </span>
                      )}
                      <span className="block text-muted-foreground">
                        {formatDateFull(selectedDriver.location.updatedAt)}
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      {t("dispatch.load_detail.driver.gps_none")}
                    </span>
                  )}
                </div>

                {selectedDriver.phone && (
                  <div className="flex items-center gap-2">
                    <Phone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <a
                      href={`tel:${selectedDriver.phone.replace(/[^+\d]/g, "")}`}
                      className="hover:text-foreground"
                    >
                      {selectedDriver.phone}
                    </a>
                  </div>
                )}

                {selectedDriver.lastCheckin && (
                  <div className="flex items-start gap-2">
                    <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span>
                      {t(CHECKIN_LABELS_KEYS[selectedDriver.lastCheckin.kind])}
                      <span className="block text-muted-foreground">
                        {formatDateFull(selectedDriver.lastCheckin.createdAt)}
                      </span>
                    </span>
                  </div>
                )}
              </dl>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            {load.driverId && (
              <Button
                variant="outline"
                onClick={() =>
                  reassignMutation.mutate({
                    driverId: null,
                    expectedDriverId: load.driverId ?? null,
                  })
                }
                disabled={reassignMutation.isPending}
                className="mr-auto"
              >
                <UserX className="h-4 w-4" />
                {t("dispatch.load_detail.assignment.unassign")}
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => setReassignOpen(false)}
              disabled={reassignMutation.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => {
                if (selectedDriverId && selectedDriverId !== load.driverId) {
                  reassignMutation.mutate({
                    driverId: selectedDriverId,
                    expectedDriverId: load.driverId ?? null,
                  });
                }
              }}
              disabled={
                reassignMutation.isPending ||
                !selectedDriverId ||
                selectedDriverId === load.driverId
              }
            >
              {reassignMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              {t("dispatch.load_detail.assignment.assign")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
