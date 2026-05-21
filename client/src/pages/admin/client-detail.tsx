import { useEffect, useMemo, useState } from "react";
import { useRoute, useLocation, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Briefcase,
  ChevronRight,
  MapPin,
  Save,
  X,
} from "lucide-react";
import type { Client, Equipment } from "@shared/schema";
import { apiJson } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * Admin / Client detail
 *
 * Полная карточка клиента с табами:
 *  - Профиль (основные поля + smart-matching из PR #38)
 *  - Локация (current location, readonly)
 *  - Статистика (placeholder для будущих фич — load history, score breakdown)
 *
 * Маршрут: /admin/clients/:id
 *
 * Backend: GET/PATCH /api/admin/clients/:id (см. server/routes/admin.ts)
 */

const EQUIPMENT_OPTIONS: { value: Equipment; label: string }[] = [
  { value: "enclosed_car_hauler", label: "Enclosed Car Hauler" },
  { value: "open_car_hauler", label: "Open Car Hauler" },
  { value: "hotshot_flatbed", label: "Hotshot Flatbed" },
  { value: "sprinter_van", label: "Sprinter Van" },
];

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

type TabKey = "profile" | "location" | "stats";

export default function ClientDetailPage() {
  const [, params] = useRoute("/clients/:id");
  const [, setLocation] = useLocation();
  const [tab, setTab] = useState<TabKey>("profile");

  const id = params?.id;

  const { data: client, isLoading, isError } = useQuery<Client>({
    queryKey: ["/api/admin/clients", id],
    queryFn: () => apiJson<Client>("GET", `/api/admin/clients/${id}`),
    enabled: !!id,
  });

  if (!id) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-rose-500">
          <AlertTriangle className="mr-2 inline h-4 w-4" />
          Не указан ID клиента в URL.
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-64 animate-pulse rounded-md bg-muted" />
        <div className="h-40 animate-pulse rounded-xl border border-border bg-muted/40" />
      </div>
    );
  }

  if (isError || !client) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-rose-500">
          <AlertTriangle className="h-4 w-4" />
          Клиент не найден или ошибка загрузки.
          <Button variant="ghost" size="sm" onClick={() => setLocation("/clients")}>
            ← К списку
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb + back */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Link href="/clients" className="hover:text-foreground">
          ← Клиенты
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span>{client.name}</span>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">{client.mc}</span>
      </div>

      {/* Header */}
      <header className="flex items-start justify-between gap-4 border-b border-border pb-5">
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-primary/15 p-2">
            <Briefcase className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{client.name}</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              MC {client.mc} ·{" "}
              {EQUIPMENT_OPTIONS.find((e) => e.value === client.equipment)?.label ?? client.equipment}
            </p>
          </div>
        </div>
      </header>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        <TabButton active={tab === "profile"} onClick={() => setTab("profile")}>
          Профиль
        </TabButton>
        <TabButton active={tab === "location"} onClick={() => setTab("location")}>
          Локация
        </TabButton>
        <TabButton active={tab === "stats"} onClick={() => setTab("stats")}>
          Статистика
        </TabButton>
      </div>

      {tab === "profile" && <ProfileTab client={client} />}
      {tab === "location" && <LocationTab client={client} />}
      {tab === "stats" && <StatsTab client={client} />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "border-b-2 px-4 py-2 text-sm font-medium transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// ProfileTab — основная форма редактирования профиля.
// ---------------------------------------------------------------------------

function ProfileTab({ client }: { client: Client }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // local form state (uncontrolled через React state — react-hook-form для такой
  // мульти-секционной формы избыточен)
  const [form, setForm] = useState({
    name: client.name,
    mc: client.mc,
    equipment: client.equipment,
    targetPpm: client.targetPpm,
    minimumPpm: client.minimumPpm,
    mpg: client.mpg,
    fuelPrice: client.fuelPrice,
    fixedCostPerMile: client.fixedCostPerMile,
    preferredLanes: client.preferredLanes.join(", "),
    avoidStates: client.avoidStates,

    // Phase 5 smart-matching (optional)
    equipmentTypes: client.equipmentTypes ?? [],
    maxGvwLbs: client.maxGvwLbs ?? "",
    payMode: (client.payCentsPerMile != null
      ? "cpm"
      : client.payPctOfGross != null
        ? "pct"
        : "none") as "none" | "cpm" | "pct",
    payCentsPerMile: client.payCentsPerMile ?? "",
    payPctOfGross: client.payPctOfGross ?? "",
    blockedBrokers: (client.blockedBrokers ?? []).join(", "),
    tollsCostPerMile: client.tollsCostPerMile ?? "",
    wearCostPerMile: client.wearCostPerMile ?? "",
    hoursAvailable: (client as any).hoursAvailable ?? "",
    fuelTankGallons: (client as any).fuelTankGallons ?? "",
  });

  // Reset form when client refetches (e.g. after save)
  useEffect(() => {
    setForm({
      name: client.name,
      mc: client.mc,
      equipment: client.equipment,
      targetPpm: client.targetPpm,
      minimumPpm: client.minimumPpm,
      mpg: client.mpg,
      fuelPrice: client.fuelPrice,
      fixedCostPerMile: client.fixedCostPerMile,
      preferredLanes: client.preferredLanes.join(", "),
      avoidStates: client.avoidStates,
      equipmentTypes: client.equipmentTypes ?? [],
      maxGvwLbs: client.maxGvwLbs ?? "",
      payMode:
        client.payCentsPerMile != null
          ? "cpm"
          : client.payPctOfGross != null
            ? "pct"
            : "none",
      payCentsPerMile: client.payCentsPerMile ?? "",
      payPctOfGross: client.payPctOfGross ?? "",
      blockedBrokers: (client.blockedBrokers ?? []).join(", "),
      tollsCostPerMile: client.tollsCostPerMile ?? "",
      wearCostPerMile: client.wearCostPerMile ?? "",
      hoursAvailable: (client as any).hoursAvailable ?? "",
      fuelTankGallons: (client as any).fuelTankGallons ?? "",
    });
  }, [client]);

  const mutation = useMutation({
    mutationFn: (patch: Partial<Client>) =>
      apiJson<Client>("PATCH", `/api/admin/clients/${client.id}`, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/clients", client.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/clients"] });
      toast({ title: "Сохранено", description: "Профиль клиента обновлён." });
    },
    onError: (e: any) => {
      toast({
        title: "Ошибка",
        description: e?.message ?? "Не удалось сохранить",
        variant: "destructive",
      });
    },
  });

  function handleSave() {
    const patch: Partial<Client> = {
      name: form.name,
      mc: form.mc,
      equipment: form.equipment,
      targetPpm: Number(form.targetPpm),
      minimumPpm: Number(form.minimumPpm),
      mpg: Number(form.mpg),
      fuelPrice: Number(form.fuelPrice),
      fixedCostPerMile: Number(form.fixedCostPerMile),
      preferredLanes: form.preferredLanes
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      avoidStates: form.avoidStates,
    };

    // Smart-matching fields — отправляем ТОЛЬКО заполненные
    if (form.equipmentTypes.length > 0) patch.equipmentTypes = form.equipmentTypes;
    if (form.maxGvwLbs !== "") patch.maxGvwLbs = Number(form.maxGvwLbs);
    if (form.payMode === "cpm" && form.payCentsPerMile !== "") {
      patch.payCentsPerMile = Number(form.payCentsPerMile);
    }
    if (form.payMode === "pct" && form.payPctOfGross !== "") {
      patch.payPctOfGross = Number(form.payPctOfGross);
    }
    const blockedList = form.blockedBrokers
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (blockedList.length > 0) patch.blockedBrokers = blockedList;
    if (form.tollsCostPerMile !== "") patch.tollsCostPerMile = Number(form.tollsCostPerMile);
    if (form.wearCostPerMile !== "") patch.wearCostPerMile = Number(form.wearCostPerMile);
    if (form.hoursAvailable !== "") {
      (patch as any).hoursAvailable = Number(form.hoursAvailable);
    }
    if (form.fuelTankGallons !== "") {
      (patch as any).fuelTankGallons = Number(form.fuelTankGallons);
    }

    mutation.mutate(patch);
  }

  function toggleEquipmentType(eq: Equipment) {
    setForm((f) => ({
      ...f,
      equipmentTypes: f.equipmentTypes.includes(eq)
        ? f.equipmentTypes.filter((x) => x !== eq)
        : [...f.equipmentTypes, eq],
    }));
  }

  function toggleAvoidState(st: string) {
    setForm((f) => ({
      ...f,
      avoidStates: f.avoidStates.includes(st)
        ? f.avoidStates.filter((x) => x !== st)
        : [...f.avoidStates, st],
    }));
  }

  return (
    <div className="space-y-6">
      {/* Block 1 — Основное */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Основное</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Имя">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="MC#">
            <Input value={form.mc} onChange={(e) => setForm({ ...form, mc: e.target.value })} />
          </Field>
          <Field label="Основной equipment">
            <Select
              value={form.equipment}
              onValueChange={(v) => setForm({ ...form, equipment: v as Equipment })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EQUIPMENT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </CardContent>
      </Card>

      {/* Block 2 — Экономика */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Экономика рейса</CardTitle>
          <p className="text-xs text-muted-foreground">
            Используется в scoreLoadForClient для расчёта чистой прибыли.
          </p>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Target PPM ($/mile)">
            <Input
              type="number"
              step="0.01"
              value={form.targetPpm}
              onChange={(e) => setForm({ ...form, targetPpm: Number(e.target.value) })}
            />
          </Field>
          <Field label="Minimum PPM ($/mile)">
            <Input
              type="number"
              step="0.01"
              value={form.minimumPpm}
              onChange={(e) => setForm({ ...form, minimumPpm: Number(e.target.value) })}
            />
          </Field>
          <Field label="MPG (расход)">
            <Input
              type="number"
              step="0.1"
              value={form.mpg}
              onChange={(e) => setForm({ ...form, mpg: Number(e.target.value) })}
            />
          </Field>
          <Field label="Fuel price ($/gallon)">
            <Input
              type="number"
              step="0.01"
              value={form.fuelPrice}
              onChange={(e) => setForm({ ...form, fuelPrice: Number(e.target.value) })}
            />
          </Field>
          <Field label="Fixed cost / mile">
            <Input
              type="number"
              step="0.01"
              value={form.fixedCostPerMile}
              onChange={(e) => setForm({ ...form, fixedCostPerMile: Number(e.target.value) })}
            />
          </Field>
          <Field label="Tolls / mile (optional, default 0)">
            <Input
              type="number"
              step="0.01"
              placeholder="0.00"
              value={form.tollsCostPerMile}
              onChange={(e) => setForm({ ...form, tollsCostPerMile: e.target.value as any })}
            />
          </Field>
          <Field label="Wear / mile (optional, default 0)">
            <Input
              type="number"
              step="0.01"
              placeholder="0.15"
              value={form.wearCostPerMile}
              onChange={(e) => setForm({ ...form, wearCostPerMile: e.target.value as any })}
            />
          </Field>
          <Field label="Fuel tank (gallons, optional)">
            <Input
              type="number"
              placeholder="150"
              value={form.fuelTankGallons}
              onChange={(e) => setForm({ ...form, fuelTankGallons: e.target.value as any })}
            />
          </Field>
        </CardContent>
      </Card>

      {/* Block 3 — Driver pay */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Оплата водителю</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Select
            value={form.payMode}
            onValueChange={(v) => setForm({ ...form, payMode: v as any })}
          >
            <SelectTrigger className="w-full sm:w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Не указано</SelectItem>
              <SelectItem value="cpm">$/милю (cpm)</SelectItem>
              <SelectItem value="pct">% от gross</SelectItem>
            </SelectContent>
          </Select>

          {form.payMode === "cpm" && (
            <Field label="Cents per mile">
              <Input
                type="number"
                step="0.01"
                placeholder="0.65"
                value={form.payCentsPerMile}
                onChange={(e) => setForm({ ...form, payCentsPerMile: e.target.value as any })}
              />
            </Field>
          )}
          {form.payMode === "pct" && (
            <Field label="Percent of gross (0–100)">
              <Input
                type="number"
                step="1"
                placeholder="25"
                value={form.payPctOfGross}
                onChange={(e) => setForm({ ...form, payPctOfGross: e.target.value as any })}
              />
            </Field>
          )}
        </CardContent>
      </Card>

      {/* Block 4 — Smart-matching фильтры */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Жёсткие фильтры</CardTitle>
          <p className="text-xs text-muted-foreground">
            Грузы не подходящие под фильтры отсеиваются в scoreLoadForClient ДО скоринга.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <Label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Equipment types (multi-trailer)
            </Label>
            <div className="flex flex-wrap gap-2">
              {EQUIPMENT_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => toggleEquipmentType(o.value)}
                  className={cn(
                    "rounded-md border px-3 py-1 text-xs transition-colors",
                    form.equipmentTypes.includes(o.value)
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-border bg-background hover:bg-muted",
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Оставь пустым — будет использоваться только основной equipment.
            </p>
          </div>

          <Field label="Max GVW (lbs, optional)">
            <Input
              type="number"
              placeholder="80000"
              value={form.maxGvwLbs}
              onChange={(e) => setForm({ ...form, maxGvwLbs: e.target.value as any })}
              className="sm:max-w-xs"
            />
          </Field>

          <Field label="Hours available (HOS, optional)">
            <Input
              type="number"
              placeholder="11"
              value={form.hoursAvailable}
              onChange={(e) => setForm({ ...form, hoursAvailable: e.target.value as any })}
              className="sm:max-w-xs"
            />
          </Field>

          <Field label="Blocked brokers (MC#, через запятую)">
            <Input
              placeholder="123456, 789012"
              value={form.blockedBrokers}
              onChange={(e) => setForm({ ...form, blockedBrokers: e.target.value })}
            />
          </Field>

          <div>
            <Label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Avoid states ({form.avoidStates.length})
            </Label>
            <div className="grid grid-cols-5 gap-1 sm:grid-cols-10">
              {US_STATES.map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => toggleAvoidState(st)}
                  className={cn(
                    "rounded-md border px-2 py-1 text-xs font-mono transition-colors",
                    form.avoidStates.includes(st)
                      ? "border-rose-500/40 bg-rose-500/15 text-rose-700 dark:text-rose-300"
                      : "border-border bg-background hover:bg-muted",
                  )}
                >
                  {st}
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Block 5 — Lanes */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lanes</CardTitle>
        </CardHeader>
        <CardContent>
          <Field label="Preferred lanes (через запятую)">
            <Input
              placeholder="FL-CA, TX-GA"
              value={form.preferredLanes}
              onChange={(e) => setForm({ ...form, preferredLanes: e.target.value })}
            />
          </Field>
        </CardContent>
      </Card>

      {/* Footer — save */}
      <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-2 border-t border-border bg-background/90 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
        <Button onClick={handleSave} disabled={mutation.isPending}>
          <Save className="mr-2 h-4 w-4" />
          {mutation.isPending ? "Сохраняем…" : "Сохранить"}
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LocationTab — read-only текущая локация водителя.
// ---------------------------------------------------------------------------

function LocationTab({ client }: { client: Client }) {
  const loc = client.currentLocation;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Текущая локация</CardTitle>
        <p className="text-xs text-muted-foreground">
          Обновляется через PATCH /api/clients/:id/location (драйвер /loc или manual checkin).
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Latitude">
            <p className="font-mono text-sm">{loc.lat.toFixed(5)}</p>
          </Field>
          <Field label="Longitude">
            <p className="font-mono text-sm">{loc.lng.toFixed(5)}</p>
          </Field>
          <Field label="Обновлено">
            <p className="text-sm">
              {new Date(loc.updatedAt).toLocaleString("ru-RU")}
            </p>
          </Field>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// StatsTab — placeholder для будущих метрик.
// ---------------------------------------------------------------------------

function StatsTab({ client: _client }: { client: Client }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground">
        <MapPin className="h-8 w-8 opacity-50" />
        <p>Статистика рейсов появится здесь.</p>
        <p className="text-xs">
          Планируется: история score breakdown, top broker MCs, lane history.
        </p>
      </CardContent>
    </Card>
  );
}