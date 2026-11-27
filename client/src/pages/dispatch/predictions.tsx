import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  Plus,
  Trash2,
  TrendingUp,
  Target,
  MapPin,
} from "lucide-react";
import { apiJson } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { JurisdictionOptions } from "@/components/JurisdictionOptions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/dispatch/EmptyState";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/i18n";

// ---------------------------------------------------------------------------
// Killer #4 — Predictive Load Hunting UI (/dispatch/predictions).
// Pick a client, watch lanes (origin→dest state + optional min-ppm/equipment),
// see match counts and the day-of-week distribution accumulated so far.
// Honest about thin data early — the dataset is the moat, it grows over time.
// ---------------------------------------------------------------------------

interface AssignedClient {
  id: string;
  name: string;
  activeDriversCount: number;
  activeLoadsCount: number;
}

interface Watch {
  id: string;
  clientId: string;
  originState: string;
  originCity: string | null;
  destinationState: string;
  destinationCity: string | null;
  minPpm: number | null;
  equipment: string | null;
  active: boolean;
  matchCount: number;
  lastMatchedAt: string | null;
  createdAt: string;
}

interface Prediction {
  originState: string;
  destinationState: string;
  loadsSeen: number;
  avgPpm: number;
  dowDistribution: Record<string, number>;
}

export default function DispatchPredictionsPage() {
  const { t } = useT();
  const [clientId, setClientId] = useState<string>("");
  const [addOpen, setAddOpen] = useState(false);

  const DOW_KEYS = [
    "dispatch.predictions.dow.sun",
    "dispatch.predictions.dow.mon",
    "dispatch.predictions.dow.tue",
    "dispatch.predictions.dow.wed",
    "dispatch.predictions.dow.thu",
    "dispatch.predictions.dow.fri",
    "dispatch.predictions.dow.sat",
  ];

  const { data: clientsData, isLoading: clientsLoading } = useQuery<{
    items: AssignedClient[];
  }>({
    queryKey: ["/api/dispatch/clients"],
    queryFn: () => apiJson("GET", "/api/dispatch/clients"),
  });

  // Default to the first client once loaded.
  const clients = clientsData?.items ?? [];
  const activeClientId = clientId || clients[0]?.id || "";

  const { data: watchData, isLoading: watchLoading } = useQuery<{ items: Watch[] }>({
    queryKey: ["/api/dispatch/watchlist", activeClientId],
    queryFn: () =>
      apiJson("GET", `/api/dispatch/watchlist?clientId=${encodeURIComponent(activeClientId)}`),
    enabled: Boolean(activeClientId),
  });

  const { data: predData } = useQuery<{ predictions: Prediction[] }>({
    queryKey: ["/api/dispatch/predictions", activeClientId],
    queryFn: () =>
      apiJson("GET", `/api/dispatch/predictions?clientId=${encodeURIComponent(activeClientId)}`),
    enabled: Boolean(activeClientId),
  });

  const predByLane = new Map<string, Prediction>();
  for (const p of predData?.predictions ?? []) {
    predByLane.set(`${p.originState}->${p.destinationState}`, p);
  }

  if (clientsLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("dispatch.predictions.header_sub")}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("dispatch.predictions.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("dispatch.predictions.subtitle")}
          </p>
        </div>
        {activeClientId && (
          <Button onClick={() => setAddOpen(true)} className="shrink-0">
            <Plus className="h-4 w-4" />
            {t("dispatch.predictions.add_btn")}
          </Button>
        )}
      </header>

      {clients.length === 0 ? (
        <Card className="p-2">
          <EmptyState
            icon={<Target className="h-6 w-6" />}
            title={t("dispatch.predictions.no_clients")}
            description={t("dispatch.predictions.no_clients_desc")}
          />
        </Card>
      ) : (
        <>
          {/* Client selector */}
          <div className="max-w-xs">
            <Select value={activeClientId} onValueChange={setClientId}>
              <SelectTrigger>
                <SelectValue placeholder={t("dispatch.predictions.select_client")} />
              </SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {watchLoading ? (
            <Card className="flex h-32 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </Card>
          ) : !watchData || watchData.items.length === 0 ? (
            <Card className="p-2">
              <EmptyState
                icon={<Target className="h-6 w-6" />}
                title={t("dispatch.predictions.no_watches")}
                description={t("dispatch.predictions.no_watches_desc")}
              />
            </Card>
          ) : (
            <div className="space-y-3">
              {watchData.items.map((w) => (
                <WatchCard
                  key={w.id}
                  watch={w}
                  prediction={predByLane.get(`${w.originState}->${w.destinationState}`)}
                  clientId={activeClientId}
                  dowKeys={DOW_KEYS}
                />
              ))}
            </div>
          )}
        </>
      )}

      {addOpen && (
        <AddWatchDialog
          clientId={activeClientId}
          onClose={() => setAddOpen(false)}
        />
      )}
    </div>
  );
}

function WatchCard({
  watch,
  prediction,
  clientId,
  dowKeys,
}: {
  watch: Watch;
  prediction: Prediction | undefined;
  clientId: string;
  dowKeys: string[];
}) {
  const { t } = useT();
  const { toast } = useToast();
  const qc = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: () => apiJson("DELETE", `/api/dispatch/watchlist/${watch.id}`),
    onSuccess: () => {
      toast({ title: t("dispatch.predictions.lane_deleted") });
      qc.invalidateQueries({ queryKey: ["/api/dispatch/watchlist", clientId] });
    },
    onError: (err: Error) =>
      toast({ title: t("dispatch.predictions.delete_error"), description: err.message, variant: "destructive" }),
  });

  const dow = prediction?.dowDistribution ?? {};
  const maxDow = Math.max(1, ...Object.values(dow));

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
            {watch.originState}
            <span className="text-muted-foreground">→</span>
            {watch.destinationState}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {typeof watch.minPpm === "number" && (
              <span>{t("dispatch.predictions.min_rate", { rate: watch.minPpm.toFixed(2) })}</span>
            )}
            {watch.equipment && <span>{watch.equipment.replace(/_/g, " ")}</span>}
            <span>
              {t("dispatch.predictions.matches")}{" "}
              <span className="font-medium text-foreground">{watch.matchCount}</span>
            </span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => deleteMutation.mutate()}
          disabled={deleteMutation.isPending}
          className="shrink-0 text-muted-foreground hover:text-destructive"
        >
          {deleteMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Trash2 className="h-4 w-4" />
          )}
        </Button>
      </div>

      {/* dow distribution */}
      <div className="mt-3">
        <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <TrendingUp className="h-3 w-3" />
          {t("dispatch.predictions.by_dow")}
          {prediction && prediction.loadsSeen > 0 ? (
            <span className="font-normal normal-case">
              · {t("dispatch.predictions.obs", { n: prediction.loadsSeen })} · {t("dispatch.predictions.avg", { avg: (prediction.avgPpm ?? 0).toFixed(2) })}
            </span>
          ) : (
            <span className="font-normal normal-case">· {t("dispatch.predictions.accumulating")}</span>
          )}
        </p>
        <div className="mt-2 flex items-end gap-1.5">
          {dowKeys.map((key, i) => {
            const count = dow[String(i)] ?? 0;
            const heightPct = Math.round((count / maxDow) * 100);
            return (
              <div key={i} className="flex flex-1 flex-col items-center gap-1">
                <div className="flex h-12 w-full items-end">
                  <div
                    className="w-full rounded-sm bg-primary/70"
                    style={{ height: `${count > 0 ? Math.max(8, heightPct) : 2}%` }}
                    title={t("dispatch.predictions.loads_count", { n: count })}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground">{t(key)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

const EQUIPMENT_OPTIONS = [
  "enclosed_car_hauler",
  "open_car_hauler",
  "hotshot_flatbed",
  "sprinter_van",
];

function AddWatchDialog({
  clientId,
  onClose,
}: {
  clientId: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [originState, setOriginState] = useState("");
  const [destinationState, setDestinationState] = useState("");
  const [minPpm, setMinPpm] = useState("");
  const [equipment, setEquipment] = useState("");

  // Parse min-PPM safely: empty → null, otherwise only a finite, non-negative
  // number is valid. A non-empty value that is not valid disables submit below.
  const trimmedPpm = minPpm.trim();
  const parsedPpm = trimmedPpm === "" ? null : Number(trimmedPpm);
  const ppmValid =
    parsedPpm === null || (Number.isFinite(parsedPpm) && parsedPpm >= 0);

  const createMutation = useMutation({
    mutationFn: () =>
      apiJson("POST", "/api/dispatch/watchlist", {
        clientId,
        originState,
        destinationState,
        minPpm: parsedPpm,
        equipment: equipment || null,
      }),
    onSuccess: () => {
      toast({ title: t("dispatch.predictions.lane_added"), description: t("dispatch.predictions.lane_added_desc") });
      qc.invalidateQueries({ queryKey: ["/api/dispatch/watchlist", clientId] });
      onClose();
    },
    onError: (err: Error) =>
      toast({ title: t("dispatch.predictions.add_error"), description: err.message, variant: "destructive" }),
  });

  const canSubmit =
    originState.length === 2 &&
    destinationState.length === 2 &&
    originState !== destinationState &&
    ppmValid;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("dispatch.predictions.add_dialog.title")}</DialogTitle>
          <DialogDescription>
            {t("dispatch.predictions.add_dialog.desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("dispatch.predictions.add_dialog.origin_state")}</Label>
              <Select value={originState} onValueChange={setOriginState}>
                <SelectTrigger>
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent className="max-h-60">
                  <JurisdictionOptions />
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("dispatch.predictions.add_dialog.dest_state")}</Label>
              <Select value={destinationState} onValueChange={setDestinationState}>
                <SelectTrigger>
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent className="max-h-60">
                  <JurisdictionOptions />
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("dispatch.predictions.add_dialog.min_rate")}</Label>
              <Input
                type="number"
                step="0.01"
                placeholder={t("dispatch.predictions.add_dialog.min_rate_placeholder")}
                value={minPpm}
                onChange={(e) => setMinPpm(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("dispatch.predictions.add_dialog.equipment")}</Label>
              <Select value={equipment} onValueChange={setEquipment}>
                <SelectTrigger>
                  <SelectValue placeholder={t("dispatch.predictions.add_dialog.equipment_any")} />
                </SelectTrigger>
                <SelectContent>
                  {EQUIPMENT_OPTIONS.map((e) => (
                    <SelectItem key={e} value={e}>
                      {e.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={createMutation.isPending}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!canSubmit || createMutation.isPending}
          >
            {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t("dispatch.predictions.add_dialog.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
