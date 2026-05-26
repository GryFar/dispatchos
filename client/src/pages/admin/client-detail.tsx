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

// Placeholder MPG hints by equipment (US car-hauling averages).
const MPG_DEFAULTS: Record<Equipment, number> = {
  enclosed_car_hauler: 7.5,
  open_car_hauler: 8.5,
  hotshot_flatbed: 12.0,
  sprinter_van: 14.0,
};

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

type TabKey = "profile" | "location" | "stats" | "fuel" | "ifta" | "safety";

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
        <TabButton active={tab === "fuel"} onClick={() => setTab("fuel")}>
          Топливо
        </TabButton>
        <TabButton active={tab === "ifta"} onClick={() => setTab("ifta")}>
          IFTA
        </TabButton>
        <TabButton active={tab === "safety"} onClick={() => setTab("safety")}>
          Safety
        </TabButton>
        <TabButton active={tab === "stats"} onClick={() => setTab("stats")}>
          Статистика
        </TabButton>
      </div>

      {tab === "profile" && <ProfileTab client={client} />}
      {tab === "location" && <LocationTab client={client} />}
      {tab === "fuel" && <FuelTab client={client} />}
      {tab === "ifta" && <IftaTab client={client} />}
      {tab === "safety" && <SafetyTab client={client} />}
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
    avgMpg: client.avgMpg ?? "",
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

    // Phase 7.2 — insurance expiries. yyyy-MM-dd или пусто.
    cargoInsuranceExpiresAt: (client as any).cargoInsuranceExpiresAt ?? "",
    autoLiabilityExpiresAt: (client as any).autoLiabilityExpiresAt ?? "",
    generalLiabilityExpiresAt: (client as any).generalLiabilityExpiresAt ?? "",
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
      avgMpg: client.avgMpg ?? "",
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
      cargoInsuranceExpiresAt: (client as any).cargoInsuranceExpiresAt ?? "",
      autoLiabilityExpiresAt: (client as any).autoLiabilityExpiresAt ?? "",
      generalLiabilityExpiresAt: (client as any).generalLiabilityExpiresAt ?? "",
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
    if (form.avgMpg !== "") patch.avgMpg = Number(form.avgMpg);
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
    // Insurance expiries — отправляем всегда (пустая строка = снять).
    (patch as any).cargoInsuranceExpiresAt = form.cargoInsuranceExpiresAt || undefined;
    (patch as any).autoLiabilityExpiresAt = form.autoLiabilityExpiresAt || undefined;
    (patch as any).generalLiabilityExpiresAt = form.generalLiabilityExpiresAt || undefined;

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
          <Field label="Ср. MPG (для топл. аналитики)">
            <Input
              type="number"
              step="0.1"
              placeholder={`по умолч. ${MPG_DEFAULTS[form.equipment as Equipment] ?? 8}`}
              value={form.avgMpg}
              onChange={(e) => setForm({ ...form, avgMpg: e.target.value })}
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

      {/* Block 6 — Insurance expiries (Phase 7.2) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Страховые сертификаты</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Мы автоматом алертим в Telegram + email за 14, 7, 3, 1 день до истечения, в день истечения и по факту просрочки.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <InsuranceDateField
              label="Cargo insurance"
              value={form.cargoInsuranceExpiresAt}
              onChange={(v) => setForm({ ...form, cargoInsuranceExpiresAt: v })}
            />
            <InsuranceDateField
              label="Auto liability"
              value={form.autoLiabilityExpiresAt}
              onChange={(v) => setForm({ ...form, autoLiabilityExpiresAt: v })}
            />
            <InsuranceDateField
              label="General liability"
              value={form.generalLiabilityExpiresAt}
              onChange={(v) => setForm({ ...form, generalLiabilityExpiresAt: v })}
            />
          </div>
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
// InsuranceDateField — yyyy-MM-dd input + live status badge.
// ---------------------------------------------------------------------------
//
// Status tiers:
//   empty       → (no badge)
//   > 30d away  → ✅ ОК
//   8—30d away  → 🟡 Скоро истекает
//   1–7d away   → ⚠️ На неделе
//   today/past  → 🔴 Просрочена
function InsuranceDateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  let badge: { text: string; cls: string } | null = null;
  if (value) {
    const expiry = new Date(`${value}T00:00:00`).getTime();
    const daysUntil = Math.round((expiry - Date.now()) / (24 * 3600 * 1000));
    if (daysUntil < 0) {
      badge = { text: `🔴 Просрочена на ${Math.abs(daysUntil)} дн.`, cls: "text-destructive border-destructive/40 bg-destructive/5" };
    } else if (daysUntil === 0) {
      badge = { text: "🔴 Истекает сегодня", cls: "text-destructive border-destructive/40 bg-destructive/5" };
    } else if (daysUntil <= 7) {
      badge = { text: `⚠️ Через ${daysUntil} дн.`, cls: "text-warning border-warning/40 bg-warning/5" };
    } else if (daysUntil <= 30) {
      badge = { text: `🟡 Через ${daysUntil} дн.`, cls: "text-amber-600 border-amber-500/30 bg-amber-500/5" };
    } else {
      badge = { text: `✅ Через ${daysUntil} дн.`, cls: "text-success border-success/30 bg-success/5" };
    }
  }

  return (
    <div>
      <Label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      <Input type="date" value={value} onChange={(e) => onChange(e.target.value)} />
      {badge && (
        <div className={`mt-1.5 inline-flex rounded-md border px-2 py-0.5 text-[11px] ${badge.cls}`}>
          {badge.text}
        </div>
      )}
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

// ---------------------------------------------------------------------------
// FuelTab — Phase 7 fuel performance + overpay alerts.
// ---------------------------------------------------------------------------
//
// Pulls GET /api/admin/clients/:id/fuel-summary?days=N which aggregates:
//   - totalMiles (haversine over driver_location_pings, all linked drivers)
//   - gallons + spendCents (sum fuel_transactions in window)
//   - actualMpg (totalMiles / gallons) vs expectedMpg (clients.avg_mpg)
//   - overpayAlerts: per-fillup «diesel was cheaper by $X at <station>, Y mi away»
//
// Empty-state: when there are no fuel_transactions yet, we show a helpful
// placeholder telling the user to set up tracking + the receipt OCR flow.

type FuelSummary = {
  clientId: string;
  windowDays: number;
  sinceIso: string;
  totalMiles: number;
  gallons: number;
  spendCents: number;
  actualMpg: number | null;
  expectedMpg: number | null;
  transactionCount: number;
  overpayTotalDollars: number;
  overpayAlerts: Array<{
    transactionId: string;
    occurredAt: string;
    stationName: string | null;
    paidCentsPerGallon: number;
    cheaperAtName: string | null;
    cheaperCentsPerGallon: number;
    cheaperDistanceKm: number;
    savedDollars: number;
  }>;
};

function FuelTab({ client }: { client: Client }) {
  const [days, setDays] = useState<1 | 7 | 15>(7);
  const q = useQuery<FuelSummary>({
    queryKey: ["/api/admin/clients", client.id, "fuel-summary", days],
    queryFn: () => apiJson<FuelSummary>("GET", `/api/admin/clients/${client.id}/fuel-summary?days=${days}`),
  });

  if (q.isLoading) {
    return (
      <Card>
        <CardContent className="flex h-32 items-center justify-center">
          …
        </CardContent>
      </Card>
    );
  }
  if (!q.data) return null;

  const s = q.data;
  const hasData = s.transactionCount > 0 || s.totalMiles > 0;

  const actualMpgFmt = s.actualMpg != null ? s.actualMpg.toFixed(2) : "—";
  const expectedMpgFmt = s.expectedMpg != null ? s.expectedMpg.toFixed(1) : "—";
  const mpgDelta = s.actualMpg != null && s.expectedMpg != null ? s.actualMpg - s.expectedMpg : null;
  const mpgDeltaPct = mpgDelta != null && s.expectedMpg ? (mpgDelta / s.expectedMpg) * 100 : null;

  return (
    <div className="space-y-4">
      {/* Period switcher */}
      <div className="inline-flex rounded-md border border-border bg-muted/30 p-1">
        {([1, 7, 15] as const).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDays(d)}
            className={`rounded px-3 py-1 text-xs font-medium transition ${
              days === d ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {d === 1 ? "Сутки" : `${d} дней`}
          </button>
        ))}
      </div>

      {!hasData && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            <p className="font-medium">Пока нет данных</p>
            <p className="mt-1 text-xs">
              Чтобы эта вкладка заработала, нужны две вещи:
            </p>
            <ul className="mt-2 inline-block text-left text-xs">
              <li>1. Включите GPS трекинг водителям этого клиента (Пользователи → :id → Геолокация)</li>
              <li>2. Попросите водителей фоткать чеки в TG-бота — OCR распарсит и запишет</li>
            </ul>
          </CardContent>
        </Card>
      )}

      {hasData && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Пройдено" value={`${s.totalMiles.toFixed(0)} mi`} />
            <Stat label="Расход" value={`${s.gallons.toFixed(1)} gal`} />
            <Stat label="Сумма" value={`$${(s.spendCents / 100).toFixed(2)}`} />
            <Stat
              label="Реальный MPG"
              value={actualMpgFmt}
              hint={s.expectedMpg != null ? `target ${expectedMpgFmt}` : undefined}
              tone={mpgDeltaPct == null ? "neutral" : mpgDeltaPct < -5 ? "bad" : mpgDeltaPct > 5 ? "good" : "neutral"}
            />
          </div>

          {/* Overpay alerts */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>Переплаты по заправкам</span>
                {s.overpayAlerts.length > 0 && (
                  <span className="text-sm font-normal text-warning">
                    Можно было сэкономить ${s.overpayTotalDollars.toFixed(2)}
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {s.overpayAlerts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Переплат не обнаружен. Водители заправляются по рыночным ценам.
                </p>
              ) : (
                <div className="space-y-2">
                  {s.overpayAlerts.map((a) => (
                    <div key={a.transactionId} className="flex items-start justify-between gap-3 rounded-md border border-warning/30 bg-warning/5 p-3 text-sm">
                      <div className="min-w-0">
                        <p className="font-medium">
                          {a.stationName ?? "Станция"} — водитель заплатил ${(a.paidCentsPerGallon / 100).toFixed(2)}/gal
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Рядом ({a.cheaperDistanceKm.toFixed(1)} km) было {a.cheaperAtName ?? "другое место"} по $
                          {(a.cheaperCentsPerGallon / 100).toFixed(2)}/gal — {new Date(a.occurredAt).toLocaleString()}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-sm font-semibold text-warning">+${a.savedDollars.toFixed(2)}</p>
                        <p className="text-[10px] text-muted-foreground">переплатил</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// IftaTab — quarterly mileage + fuel by state report (paid feature)
// Backend: GET /api/admin/clients/:id/ifta?year=YYYY&quarter=N
//          GET /api/admin/clients/:id/ifta.csv?… (download)
// ---------------------------------------------------------------------------

interface IftaStateRow {
  state: string;
  miles: number;
  gallons: number;
  fuelCostUsd: number;
}

interface IftaQuarterReport {
  clientId: string;
  year: number;
  quarter: 1 | 2 | 3 | 4;
  periodStart: string;
  periodEnd: string;
  rows: IftaStateRow[];
  totals: {
    miles: number;
    gallons: number;
    fuelCostUsd: number;
    avgMpg: number | null;
  };
  unknownStateMiles: number;
  unknownStateGallons: number;
  generatedAt: string;
}

function IftaTab({ client }: { client: Client }) {
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const currentQuarter = (Math.floor(now.getUTCMonth() / 3) + 1) as 1 | 2 | 3 | 4;
  const [year, setYear] = useState<number>(currentYear);
  const [quarter, setQuarter] = useState<1 | 2 | 3 | 4>(currentQuarter);

  const q = useQuery<IftaQuarterReport>({
    queryKey: ["/api/admin/clients", client.id, "ifta", year, quarter],
    queryFn: () =>
      apiJson<IftaQuarterReport>(
        "GET",
        `/api/admin/clients/${client.id}/ifta?year=${year}&quarter=${quarter}`,
      ),
  });

  const yearOptions = [currentYear, currentYear - 1, currentYear - 2];
  const csvUrl = `/api/admin/clients/${client.id}/ifta.csv?year=${year}&quarter=${quarter}`;

  return (
    <div className="space-y-4">
      {/* Header card — selectors + download */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-3">
            <span>IFTA квартальный отчёт</span>
            <a
              href={csvUrl}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
              download
            >
              ↓ Скачать CSV
            </a>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">Год</Label>
              <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
                <SelectTrigger className="h-8 w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {yearOptions.map((y) => (
                    <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">Квартал</Label>
              <div className="inline-flex rounded-md border border-border bg-muted/30 p-1">
                {([1, 2, 3, 4] as const).map((qq) => (
                  <button
                    key={qq}
                    type="button"
                    onClick={() => setQuarter(qq)}
                    className={`rounded px-3 py-1 text-xs font-medium transition ${
                      quarter === qq
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Q{qq}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Отчёт агрегирует пройденные мили (из GPS-трека) и купленное топливо (из чеков) по каждому штату
            для всех водителей работающих на этого перевозчика. CSV можно загружать в IFTA-портал штата регистрации.
          </p>
        </CardContent>
      </Card>

      {q.isLoading && (
        <Card>
          <CardContent className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            Считаем…
          </CardContent>
        </Card>
      )}

      {q.data && (
        <>
          {/* Totals */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Мили всего" value={`${q.data.totals.miles.toLocaleString()} mi`} />
            <Stat label="Галлоны всего" value={`${q.data.totals.gallons.toLocaleString()} gal`} />
            <Stat label="Расход на топливо" value={`$${q.data.totals.fuelCostUsd.toLocaleString()}`} />
            <Stat
              label="Средний MPG"
              value={q.data.totals.avgMpg != null ? q.data.totals.avgMpg.toFixed(2) : "—"}
            />
          </div>

          {/* State breakdown */}
          <Card>
            <CardHeader>
              <CardTitle>По штатам</CardTitle>
            </CardHeader>
            <CardContent>
              {q.data.rows.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Нет данных за этот квартал. Включите GPS трекинг водителям и записывайте чеки на топливо.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                        <th className="py-2 pr-3">Штат</th>
                        <th className="py-2 pr-3 text-right">Мили</th>
                        <th className="py-2 pr-3 text-right">Галлоны</th>
                        <th className="py-2 pr-3 text-right">Стоимость</th>
                      </tr>
                    </thead>
                    <tbody>
                      {q.data.rows.map((r) => (
                        <tr key={r.state} className="border-b border-border/50">
                          <td className="py-2 pr-3 font-medium">{r.state}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{r.miles.toLocaleString()}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{r.gallons.toLocaleString()}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">${r.fuelCostUsd.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {(q.data.unknownStateMiles > 0 || q.data.unknownStateGallons > 0) && (
            <Card>
              <CardContent className="py-3 text-xs text-muted-foreground">
                Не удалось отнести к штату: <span className="font-medium">{q.data.unknownStateMiles} mi</span>{" "}
                и <span className="font-medium">{q.data.unknownStateGallons} gal</span>{" "}
                (пинги/транзакции вне границ или без координат станции)
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function Stat({
  label, value, hint, tone = "neutral",
}: {
  label: string; value: string; hint?: string; tone?: "good" | "bad" | "neutral";
}) {
  const toneCls = tone === "good" ? "text-success" : tone === "bad" ? "text-destructive" : "text-foreground";
  return (
    <Card>
      <CardContent className="p-3">
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className={`mt-1 text-lg font-semibold ${toneCls}`}>{value}</p>
        {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}
// ---------------------------------------------------------------------------
// SafetyTab — Carrier Safety Profile (Montgomery defense, paid add-on)
// Backend: GET /api/admin/clients/:id/safety-profile (JSON)
//          GET /api/admin/clients/:id/safety-profile.md (Markdown download)
// ---------------------------------------------------------------------------

interface SafetyProfile {
  clientId: string;
  clientName: string;
  mc: string;
  generatedAt: string;
  fmcsa: {
    fetched: boolean;
    error?: string;
    raw: Record<string, unknown> | null;
  };
  insurance: Array<{
    kind: "cargo" | "liability" | "general";
    expiresAt: string | null;
    status: "active" | "expiring" | "expired" | "missing";
    daysUntilExpiry: number | null;
  }>;
  operational: {
    loadsTotal: number;
    loadsLast90d: number;
    loadsDelivered: number;
    loadsActive: number;
    firstActivityAt: string | null;
    lastActivityAt: string | null;
  };
  verdict: {
    level: "green" | "yellow" | "red" | "unknown";
    summary: string;
    risks: string[];
    strengths: string[];
  };
  disclaimer: string;
}

function SafetyTab({ client }: { client: Client }) {
  const q = useQuery<SafetyProfile>({
    queryKey: ["/api/admin/clients", client.id, "safety-profile"],
    queryFn: () =>
      apiJson<SafetyProfile>("GET", `/api/admin/clients/${client.id}/safety-profile`),
  });

  const mdUrl = `/api/admin/clients/${client.id}/safety-profile.md`;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-3">
            <span>Carrier Safety Profile</span>
            <a
              href={mdUrl}
              download
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              ↓ Скачать (.md)
            </a>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Документ для брокерской due-diligence после SCOTUS Montgomery v. Caribe Transport II (2026).
            Агрегирует FMCSA SAFER snapshot, статус страховок и операционную историю в этой системе.
          </p>
          <p className="text-xs">
            Можно отдавать брокерам как доказательство carrier vetting. Файл генерируется в формате Markdown,
            конвертируется в PDF через любой redactor (Notion, Google Docs).
          </p>
        </CardContent>
      </Card>

      {q.isLoading && (
        <Card>
          <CardContent className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            Собираем профиль…
          </CardContent>
        </Card>
      )}

      {q.isError && (
        <Card>
          <CardContent className="py-4 text-sm text-destructive">
            Не удалось загрузить профиль. Возможно, FMCSA_WEB_KEY не настроен в Integrations.
          </CardContent>
        </Card>
      )}

      {q.data && (
        <>
          <SafetyVerdictCard verdict={q.data.verdict} mc={q.data.mc} fmcsaFetched={q.data.fmcsa.fetched} />
          <SafetyInsuranceCard insurance={q.data.insurance} />
          <SafetyOperationalCard op={q.data.operational} />
          <Card>
            <CardContent className="py-3 text-[11px] leading-relaxed text-muted-foreground">
              {q.data.disclaimer}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function SafetyVerdictCard({
  verdict, mc, fmcsaFetched,
}: {
  verdict: SafetyProfile["verdict"];
  mc: string;
  fmcsaFetched: boolean;
}) {
  const badgeMap: Record<SafetyProfile["verdict"]["level"], { label: string; cls: string }> = {
    green: { label: "🟢 GREEN — соответствует due-care", cls: "bg-success/10 text-success border-success/30" },
    yellow: { label: "🟡 YELLOW — приемлемо с оговорками", cls: "bg-warning/10 text-warning border-warning/30" },
    red: { label: "🔴 RED — есть дисквалифицирующие сигналы", cls: "bg-destructive/10 text-destructive border-destructive/30" },
    unknown: { label: "⚪ UNKNOWN — недостаточно данных", cls: "bg-muted text-muted-foreground border-border" },
  };
  const badge = badgeMap[verdict.level];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span>Verdict</span>
          <span className="text-xs font-normal text-muted-foreground">MC {mc}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className={`inline-flex rounded-md border px-3 py-1.5 text-sm font-semibold ${badge.cls}`}>
          {badge.label}
        </div>
        <p className="text-sm">{verdict.summary}</p>
        {!fmcsaFetched && (
          <p className="text-xs text-warning">
            ⚠ FMCSA данные не загружены — проверь FMCSA_WEB_KEY в Integrations.
          </p>
        )}
        {verdict.strengths.length > 0 && (
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Сильные стороны</p>
            <ul className="mt-1 space-y-1 text-sm">
              {verdict.strengths.map((s, i) => (
                <li key={i} className="flex gap-2"><span className="text-success">✓</span>{s}</li>
              ))}
            </ul>
          </div>
        )}
        {verdict.risks.length > 0 && (
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Риски</p>
            <ul className="mt-1 space-y-1 text-sm">
              {verdict.risks.map((r, i) => (
                <li key={i} className="flex gap-2"><span className="text-destructive">!</span>{r}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SafetyInsuranceCard({ insurance }: { insurance: SafetyProfile["insurance"] }) {
  const labelMap = { cargo: "Cargo", liability: "Auto liability", general: "General liability" };
  const statusClass = (s: SafetyProfile["insurance"][number]["status"]) =>
    s === "active" ? "text-success"
    : s === "expiring" ? "text-warning"
    : s === "expired" ? "text-destructive"
    : "text-muted-foreground";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Страховки</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2 text-sm">
          {insurance.map((ins) => (
            <div key={ins.kind} className="flex items-center justify-between border-b border-border/50 py-1.5">
              <span className="font-medium">{labelMap[ins.kind]}</span>
              <span className={`text-right ${statusClass(ins.status)}`}>
                {ins.status === "missing"
                  ? "не указано"
                  : `${ins.status.toUpperCase()}${ins.daysUntilExpiry !== null ? ` · ${ins.daysUntilExpiry}d` : ""}`}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function SafetyOperationalCard({ op }: { op: SafetyProfile["operational"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Операционная история</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Всего грузов" value={String(op.loadsTotal)} />
          <Stat label="За 90 дней" value={String(op.loadsLast90d)} />
          <Stat label="Доставлено" value={String(op.loadsDelivered)} />
          <Stat label="Активных сейчас" value={String(op.loadsActive)} />
        </div>
        {op.firstActivityAt && (
          <p className="mt-3 text-xs text-muted-foreground">
            Первая активность: {new Date(op.firstActivityAt).toISOString().slice(0, 10)}
            {op.lastActivityAt && ` · Последняя: ${new Date(op.lastActivityAt).toISOString().slice(0, 10)}`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
