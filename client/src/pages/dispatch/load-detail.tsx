import { useState } from "react";
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

  // CHECKIN_LABELS_KEYS defined inside component so t() is available
  const CHECKIN_LABELS_KEYS: Record<CheckinKind, string> = {
    pickup_arrived: "dispatch.load_detail.checkin.pickup_arrived",
    loaded: "dispatch.load_detail.checkin.loaded",
    in_transit: "dispatch.load_detail.checkin.in_transit",
    delivery_arrived: "dispatch.load_detail.checkin.delivery_arrived",
    delivered: "dispatch.load_detail.checkin.delivered",
    note: "dispatch.load_detail.checkin.note",
  };

  const { data, isLoading, error } = useQuery<LoadFull>({
    queryKey: ["dispatch", "load", loadId],
    queryFn: () => apiJson<LoadFull>("GET", `/api/dispatch/loads/${loadId}`),
    enabled: Boolean(loadId),
  });

  const { data: checkinsData } = useQuery<{ items: LoadCheckin[] }>({
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
    return (
      <div className="space-y-4">
        <BackBar onClick={() => setLocation("/loads")} label={t("dispatch.load_detail.back")} />
        <Card className="border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium">
            {is404 ? t("dispatch.load_detail.not_found") : t("dispatch.load_detail.load_error")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {is404 ? t("dispatch.load_detail.not_found_hint") : (error as Error).message}
          </p>
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
            label="Pickup"
            city={data.originCity}
            state={data.originState}
            iso={data.pickupAt}
          />
          <StopBlock
            label="Delivery"
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

      {/* Driver assignment (always shown — load can have or not have a driver) */}
      <DriverAssignmentCard load={data} />

      {/* Checkins timeline */}
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
    mutationFn: (driverId: string | null) =>
      apiJson("PATCH", `/api/dispatch/loads/${load.id}`, { driverId }),
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
                    Booked: {formatDateFull(load.bookedAt)}
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
                    <a href={`tel:${selectedDriver.phone}`} className="hover:text-foreground">
                      {selectedDriver.phone}
                    </a>
                  </div>
                )}

                {selectedDriver.lastCheckin && (
                  <div className="flex items-start gap-2">
                    <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span>
                      {t(`dispatch.load_detail.checkin.${selectedDriver.lastCheckin.kind}`)}
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
                onClick={() => reassignMutation.mutate(null)}
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
                  reassignMutation.mutate(selectedDriverId);
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
