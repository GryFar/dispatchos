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

const DOW_LABELS = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

export default function DispatchPredictionsPage() {
  const [clientId, setClientId] = useState<string>("");
  const [addOpen, setAddOpen] = useState(false);

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
            dispatcher / прогнозы
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Поиск грузов</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Следите за лейнами — система уведомит о подходящих грузах и копит статистику.
          </p>
        </div>
        {activeClientId && (
          <Button onClick={() => setAddOpen(true)} className="shrink-0">
            <Plus className="h-4 w-4" />
            Добавить
          </Button>
        )}
      </header>

      {clients.length === 0 ? (
        <Card className="p-2">
          <EmptyState
            icon={<Target className="h-6 w-6" />}
            title="Нет клиентов"
            description="К вам пока не привязан ни один клиент."
          />
        </Card>
      ) : (
        <>
          {/* Client selector */}
          <div className="max-w-xs">
            <Select value={activeClientId} onValueChange={setClientId}>
              <SelectTrigger>
                <SelectValue placeholder="Выберите клиента" />
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
                title="Нет отслеживаемых лейнов"
                description="Добавьте лейн — и система начнёт ловить подходящие грузы."
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
}: {
  watch: Watch;
  prediction: Prediction | undefined;
  clientId: string;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: () => apiJson("DELETE", `/api/dispatch/watchlist/${watch.id}`),
    onSuccess: () => {
      toast({ title: "Лейн удалён" });
      qc.invalidateQueries({ queryKey: ["/api/dispatch/watchlist", clientId] });
    },
    onError: (err: Error) =>
      toast({ title: "Не удалось удалить", description: err.message, variant: "destructive" }),
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
            {typeof watch.minPpm === "number" && <span>мин. ${watch.minPpm.toFixed(2)}/mi</span>}
            {watch.equipment && <span>{watch.equipment.replace(/_/g, " ")}</span>}
            <span>
              Совпадений: <span className="font-medium text-foreground">{watch.matchCount}</span>
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
          По дням недели
          {prediction && prediction.loadsSeen > 0 ? (
            <span className="font-normal normal-case">
              · {prediction.loadsSeen} набл. · ${prediction.avgPpm.toFixed(2)}/mi сред.
            </span>
          ) : (
            <span className="font-normal normal-case">· данные копятся</span>
          )}
        </p>
        <div className="mt-2 flex items-end gap-1.5">
          {DOW_LABELS.map((label, i) => {
            const count = dow[String(i)] ?? 0;
            const heightPct = Math.round((count / maxDow) * 100);
            return (
              <div key={i} className="flex flex-1 flex-col items-center gap-1">
                <div className="flex h-12 w-full items-end">
                  <div
                    className="w-full rounded-sm bg-primary/70"
                    style={{ height: `${count > 0 ? Math.max(8, heightPct) : 2}%` }}
                    title={`${count} грузов`}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground">{label}</span>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY",
];

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
  const { toast } = useToast();
  const qc = useQueryClient();
  const [originState, setOriginState] = useState("");
  const [destinationState, setDestinationState] = useState("");
  const [minPpm, setMinPpm] = useState("");
  const [equipment, setEquipment] = useState("");

  const createMutation = useMutation({
    mutationFn: () =>
      apiJson("POST", "/api/dispatch/watchlist", {
        clientId,
        originState,
        destinationState,
        minPpm: minPpm ? Number(minPpm) : null,
        equipment: equipment || null,
      }),
    onSuccess: () => {
      toast({ title: "Лейн добавлен", description: "Будем ловить подходящие грузы." });
      qc.invalidateQueries({ queryKey: ["/api/dispatch/watchlist", clientId] });
      onClose();
    },
    onError: (err: Error) =>
      toast({ title: "Не удалось добавить", description: err.message, variant: "destructive" }),
  });

  const canSubmit = originState.length === 2 && destinationState.length === 2;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Отслеживать лейн</DialogTitle>
          <DialogDescription>
            Укажите штаты отправления и назначения. Минимальная ставка и тип — опционально.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Откуда (штат)</Label>
              <Select value={originState} onValueChange={setOriginState}>
                <SelectTrigger>
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent className="max-h-60">
                  {US_STATES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Куда (штат)</Label>
              <Select value={destinationState} onValueChange={setDestinationState}>
                <SelectTrigger>
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent className="max-h-60">
                  {US_STATES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Мин. $/миля</Label>
              <Input
                type="number"
                step="0.01"
                placeholder="напр. 2.00"
                value={minPpm}
                onChange={(e) => setMinPpm(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Тип (опц.)</Label>
              <Select value={equipment} onValueChange={setEquipment}>
                <SelectTrigger>
                  <SelectValue placeholder="любой" />
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
            Отмена
          </Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!canSubmit || createMutation.isPending}
          >
            {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Добавить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
