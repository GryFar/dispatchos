import { useEffect, useMemo, useState } from "react";
import { useRoute, useLocation, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Briefcase,
  ChevronRight,
  Download,
  FileText,
  Loader2,
  MapPin,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { Client, Equipment } from "@shared/schema";
import { formatClientDisplay } from "@shared/format-client";
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
import { useT } from "@/lib/i18n";

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

type TabKey = "profile" | "location" | "stats" | "fuel" | "ifta" | "safety" | "clearinghouse";

export default function ClientDetailPage() {
  const { t } = useT();
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
          {t("admin.clientDetail.noClientId")}
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
          {t("admin.clientDetail.loadError")}
          <Button variant="ghost" size="sm" onClick={() => setLocation("/clients")}>
            {t("admin.clientDetail.backToList")}
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
          {t("admin.clientDetail.breadcrumbClients")}
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
            {/* Henry QA Bug #6+7: show combined 'Company — Contact' in header */}
            <h1 className="text-2xl font-semibold tracking-tight">
              {formatClientDisplay(client as any)}
            </h1>
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
          {t("admin.clientDetail.tabProfile")}
        </TabButton>
        <TabButton active={tab === "location"} onClick={() => setTab("location")}>
          {t("admin.clientDetail.tabLocation")}
        </TabButton>
        <TabButton active={tab === "fuel"} onClick={() => setTab("fuel")}>
          {t("admin.clientDetail.tabFuel")}
        </TabButton>
        <TabButton active={tab === "ifta"} onClick={() => setTab("ifta")}>
          IFTA
        </TabButton>
        <TabButton active={tab === "safety"} onClick={() => setTab("safety")}>
          Safety
        </TabButton>
        <TabButton active={tab === "clearinghouse"} onClick={() => setTab("clearinghouse")}>
          D&A
        </TabButton>
        <TabButton active={tab === "stats"} onClick={() => setTab("stats")}>
          {t("admin.clientDetail.tabStats")}
        </TabButton>
      </div>

      {tab === "profile" && <ProfileTab client={client} />}
      {tab === "location" && <LocationTab client={client} />}
      {tab === "fuel" && <FuelTab client={client} />}
      {tab === "ifta" && <IftaTab client={client} />}
      {tab === "safety" && <SafetyTab client={client} />}
      {tab === "clearinghouse" && <ClearinghouseTab client={client} />}
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
  const { t } = useT();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // local form state (uncontrolled через React state — react-hook-form для такой
  // мульти-секционной формы избыточен)
  const [form, setForm] = useState({
    name: client.name,
    // Henry QA Bug #6+7 — contact person fields
    contactPersonName: (client as any).contactPersonName ?? "",
    contactPersonEmail: (client as any).contactPersonEmail ?? "",
    contactPersonPhone: (client as any).contactPersonPhone ?? "",
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
    // Killer feature #5 — UCR/IRP renewal calendar.
    ucrExpiresAt: (client as any).ucrExpiresAt ?? "",
    ucrBaseState: (client as any).ucrBaseState ?? "",
    irpExpiresAt: (client as any).irpExpiresAt ?? "",
    irpBaseJurisdiction: (client as any).irpBaseJurisdiction ?? "",
  });

  // Reset the form only when we navigate to a DIFFERENT client, not on every
  // background/window-focus refetch of the same client — otherwise a refetch
  // returns a fresh `client` object reference and silently wipes unsaved edits.
  // (Depending on the whole `client` object re-ran this on every refetch.)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setForm({
      name: client.name,
      // Henry QA Bug #6+7 — contact person fields
      contactPersonName: (client as any).contactPersonName ?? "",
      contactPersonEmail: (client as any).contactPersonEmail ?? "",
      contactPersonPhone: (client as any).contactPersonPhone ?? "",
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
      ucrExpiresAt: (client as any).ucrExpiresAt ?? "",
      ucrBaseState: (client as any).ucrBaseState ?? "",
      irpExpiresAt: (client as any).irpExpiresAt ?? "",
      irpBaseJurisdiction: (client as any).irpBaseJurisdiction ?? "",
    });
  }, [client.id]);

  const mutation = useMutation({
    mutationFn: (patch: Partial<Client>) =>
      apiJson<Client>("PATCH", `/api/admin/clients/${client.id}`, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/clients", client.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/clients"] });
      toast({ title: t("common.success"), description: t("admin.clientDetail.profileSaved") });
    },
    onError: (e: any) => {
      toast({
        title: t("common.error"),
        description: e?.message ?? t("admin.clientDetail.saveFailed"),
        variant: "destructive",
      });
    },
  });

  function handleSave() {
    // Validate every editable numeric field before mutating: reject NaN /
    // negative / absurd values so a stray keystroke can't push bogus economics
    // (negative PPM, garbage fuel price, etc.) into the load-scoring backend.
    // Always-sent fields are validated against the raw value; optional fields
    // only when they are non-empty (empty = "leave/clear", handled below).
    const numericChecks: Array<{ field: string; raw: unknown; max: number; optional?: boolean }> = [
      { field: "Target PPM", raw: form.targetPpm, max: 100 },
      { field: "Minimum PPM", raw: form.minimumPpm, max: 100 },
      { field: "MPG", raw: form.mpg, max: 100 },
      { field: "Fuel price", raw: form.fuelPrice, max: 100 },
      { field: "Fixed cost / mile", raw: form.fixedCostPerMile, max: 100 },
      { field: "Avg MPG", raw: form.avgMpg, max: 100, optional: true },
      { field: "Max GVW (lbs)", raw: form.maxGvwLbs, max: 1_000_000, optional: true },
      { field: "Tolls / mile", raw: form.tollsCostPerMile, max: 100, optional: true },
      { field: "Wear / mile", raw: form.wearCostPerMile, max: 100, optional: true },
      { field: "Hours available", raw: form.hoursAvailable, max: 1000, optional: true },
      { field: "Fuel tank (gallons)", raw: form.fuelTankGallons, max: 100_000, optional: true },
    ];
    if (form.payMode === "cpm") {
      numericChecks.push({ field: "Cents per mile", raw: form.payCentsPerMile, max: 100, optional: true });
    } else if (form.payMode === "pct") {
      numericChecks.push({ field: "Percent of gross", raw: form.payPctOfGross, max: 100, optional: true });
    }
    for (const c of numericChecks) {
      if (c.optional && (c.raw === "" || c.raw == null)) continue;
      const n = Number(c.raw);
      if (!Number.isFinite(n) || n < 0 || n > c.max) {
        toast({
          title: t("common.error"),
          description: t("admin.clientDetail.invalidNumber", { field: c.field }),
          variant: "destructive",
        });
        return;
      }
    }

    const patch: Partial<Client> = {
      name: form.name,
      // Henry QA Bug #6+7 — contact person: send empty string as undefined to clear.
      ...({} as any),
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
    (patch as any).contactPersonName = form.contactPersonName.trim() || undefined;
    (patch as any).contactPersonEmail = form.contactPersonEmail.trim() || undefined;
    (patch as any).contactPersonPhone = form.contactPersonPhone.trim() || undefined;

    // Smart-matching fields — отправляем ТОЛЬКО заполненные
    if (form.equipmentTypes.length > 0) patch.equipmentTypes = form.equipmentTypes;
    if (form.avgMpg !== "") patch.avgMpg = Number(form.avgMpg);
    // maxGvwLbs is a HARD load filter server-side (routes.ts) — must be
    // persisted when set, otherwise admin edits are silently dropped.
    if (form.maxGvwLbs !== "") patch.maxGvwLbs = Number(form.maxGvwLbs);
    // Pay model — send BOTH fields every save so switching mode actually clears
    // the other field server-side. `null` is the server's "clear this field"
    // signal (additive merge can't otherwise remove a stale value).
    //   none → both cleared; cpm → cpm set, pct cleared; pct → pct set, cpm cleared.
    if (form.payMode === "cpm") {
      patch.payCentsPerMile =
        form.payCentsPerMile !== "" ? Number(form.payCentsPerMile) : null;
      patch.payPctOfGross = null;
    } else if (form.payMode === "pct") {
      patch.payPctOfGross =
        form.payPctOfGross !== "" ? Number(form.payPctOfGross) : null;
      patch.payCentsPerMile = null;
    } else {
      patch.payCentsPerMile = null;
      patch.payPctOfGross = null;
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
    (patch as any).ucrExpiresAt = form.ucrExpiresAt || undefined;
    (patch as any).ucrBaseState = form.ucrBaseState || undefined;
    (patch as any).irpExpiresAt = form.irpExpiresAt || undefined;
    (patch as any).irpBaseJurisdiction = form.irpBaseJurisdiction || undefined;
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
      {/* Block 1 — Company info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("admin.clientDetail.companyInfo")}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {t("admin.clientDetail.companyInfoHint")}
          </p>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label={t("admin.clientDetail.companyNameLabel")}>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="MC#">
            <Input value={form.mc} onChange={(e) => setForm({ ...form, mc: e.target.value })} />
          </Field>
          <Field label={t("admin.clientDetail.primaryEquipment")}>
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

      {/* Block 1b — Henry QA Bug #6+7: Contact person */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("admin.clientDetail.contactPerson")}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {t("admin.clientDetail.contactPersonHint")}
          </p>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label={t("admin.clientDetail.contactName")}>
            <Input
              placeholder={t("admin.clientDetail.contactNamePlaceholder")}
              value={form.contactPersonName}
              onChange={(e) => setForm({ ...form, contactPersonName: e.target.value })}
            />
          </Field>
          <Field label={t("admin.clientDetail.contactEmail")}>
            <Input
              type="email"
              placeholder="john@example.com"
              value={form.contactPersonEmail}
              onChange={(e) => setForm({ ...form, contactPersonEmail: e.target.value })}
            />
          </Field>
          <Field label={t("admin.clientDetail.contactPhone")}>
            <Input
              placeholder="(555) 123-4567"
              value={form.contactPersonPhone}
              onChange={(e) => setForm({ ...form, contactPersonPhone: e.target.value })}
            />
          </Field>
        </CardContent>
      </Card>

      {/* Block 2 — Экономика */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("admin.clientDetail.tripEconomics")}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {t("admin.clientDetail.tripEconomicsHint")}
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
          <Field label={t("admin.clientDetail.avgMpgLabel")}>
            <Input
              type="number"
              step="0.1"
              placeholder={t("admin.clientDetail.avgMpgPlaceholder", { value: MPG_DEFAULTS[form.equipment as Equipment] ?? 8 })}
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
          <CardTitle className="text-base">{t("admin.clientDetail.driverPay")}</CardTitle>
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
              <SelectItem value="none">{t("admin.clientDetail.payModeNone")}</SelectItem>
              <SelectItem value="cpm">{t("admin.clientDetail.payModeCpm")}</SelectItem>
              <SelectItem value="pct">{t("admin.clientDetail.payModePct")}</SelectItem>
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
          <CardTitle className="text-base">{t("admin.clientDetail.hardFilters")}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {t("admin.clientDetail.hardFiltersHint")}
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <Label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("admin.clientDetail.equipmentTypes")}
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
              {t("admin.clientDetail.equipmentTypesHint")}
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

          <Field label={t("admin.clientDetail.blockedBrokers")}>
            <Input
              placeholder="123456, 789012"
              value={form.blockedBrokers}
              onChange={(e) => setForm({ ...form, blockedBrokers: e.target.value })}
            />
          </Field>

          <div>
            <Label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("admin.clientDetail.avoidStates", { count: form.avoidStates.length })}
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
          <Field label={t("admin.clientDetail.preferredLanes")}>
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
          <CardTitle className="text-base">{t("admin.clientDetail.insuranceCertificates")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            {t("admin.clientDetail.insuranceAlertHint")}
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

      {/* Killer feature #5 — UCR / IRP renewal calendar */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">UCR / IRP renewals</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            {t("admin.clientDetail.ucrIrpHint")}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <InsuranceDateField
                label="UCR expires"
                value={form.ucrExpiresAt}
                onChange={(v) => setForm({ ...form, ucrExpiresAt: v })}
              />
              <Input
                className="mt-2"
                placeholder={t("admin.clientDetail.baseStatePlaceholder")}
                maxLength={2}
                value={form.ucrBaseState}
                onChange={(e) => setForm({ ...form, ucrBaseState: e.target.value.toUpperCase() })}
              />
            </div>
            <div>
              <InsuranceDateField
                label="IRP plates expire"
                value={form.irpExpiresAt}
                onChange={(v) => setForm({ ...form, irpExpiresAt: v })}
              />
              <Input
                className="mt-2"
                placeholder={t("admin.clientDetail.baseJurisdictionPlaceholder")}
                maxLength={2}
                value={form.irpBaseJurisdiction}
                onChange={(e) => setForm({ ...form, irpBaseJurisdiction: e.target.value.toUpperCase() })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Compliance documents upload — photo/PDF or manual date (per user request 2026-05-26) */}
      <ComplianceDocsCard clientId={client.id} />

      {/* Footer — save */}
      <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-2 border-t border-border bg-background/90 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
        <Button onClick={handleSave} disabled={mutation.isPending}>
          <Save className="mr-2 h-4 w-4" />
          {mutation.isPending ? t("admin.clientDetail.saving") : t("common.save")}
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
  const { t } = useT();
  let badge: { text: string; cls: string } | null = null;
  if (value) {
    const expiry = new Date(`${value}T00:00:00`).getTime();
    const daysUntil = Math.round((expiry - Date.now()) / (24 * 3600 * 1000));
    if (daysUntil < 0) {
      badge = { text: t("admin.clientDetail.expiredDaysAgo", { days: Math.abs(daysUntil) }), cls: "text-destructive border-destructive/40 bg-destructive/5" };
    } else if (daysUntil === 0) {
      badge = { text: t("admin.clientDetail.expiresToday"), cls: "text-destructive border-destructive/40 bg-destructive/5" };
    } else if (daysUntil <= 7) {
      badge = { text: t("admin.clientDetail.inDaysWarn", { days: daysUntil }), cls: "text-warning border-warning/40 bg-warning/5" };
    } else if (daysUntil <= 30) {
      badge = { text: t("admin.clientDetail.inDaysSoon", { days: daysUntil }), cls: "text-amber-600 border-amber-500/30 bg-amber-500/5" };
    } else {
      badge = { text: t("admin.clientDetail.inDaysOk", { days: daysUntil }), cls: "text-success border-success/30 bg-success/5" };
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
  const { t } = useT();
  const loc = client.currentLocation;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("admin.clientDetail.currentLocation")}</CardTitle>
        <p className="text-xs text-muted-foreground">
          {t("admin.clientDetail.currentLocationHint")}
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
          <Field label={t("admin.clientDetail.updatedAt")}>
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
  const { t } = useT();
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground">
        <MapPin className="h-8 w-8 opacity-50" />
        <p>{t("admin.clientDetail.statsComingSoon")}</p>
        <p className="text-xs">
          {t("admin.clientDetail.statsPlanned")}
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
  const { t } = useT();
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
            {d === 1 ? t("admin.clientDetail.periodDay") : t("admin.clientDetail.periodDays", { days: d })}
          </button>
        ))}
      </div>

      {!hasData && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            <p className="font-medium">{t("admin.clientDetail.fuelNoData")}</p>
            <p className="mt-1 text-xs">
              {t("admin.clientDetail.fuelNoDataHint")}
            </p>
            <ul className="mt-2 inline-block text-left text-xs">
              <li>{t("admin.clientDetail.fuelNoDataStep1")}</li>
              <li>{t("admin.clientDetail.fuelNoDataStep2")}</li>
            </ul>
          </CardContent>
        </Card>
      )}

      {hasData && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label={t("admin.clientDetail.fuelMiles")} value={`${s.totalMiles.toFixed(0)} mi`} />
            <Stat label={t("admin.clientDetail.fuelGallons")} value={`${s.gallons.toFixed(1)} gal`} />
            <Stat label={t("admin.clientDetail.fuelSpend")} value={`$${(s.spendCents / 100).toFixed(2)}`} />
            <Stat
              label={t("admin.clientDetail.fuelActualMpg")}
              value={actualMpgFmt}
              hint={s.expectedMpg != null ? `target ${expectedMpgFmt}` : undefined}
              tone={mpgDeltaPct == null ? "neutral" : mpgDeltaPct < -5 ? "bad" : mpgDeltaPct > 5 ? "good" : "neutral"}
            />
          </div>

          {/* Overpay alerts */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>{t("admin.clientDetail.fuelOverpays")}</span>
                {s.overpayAlerts.length > 0 && (
                  <span className="text-sm font-normal text-warning">
                    {t("admin.clientDetail.fuelCouldSave", { amount: s.overpayTotalDollars.toFixed(2) })}
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {s.overpayAlerts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("admin.clientDetail.fuelNoOverpays")}
                </p>
              ) : (
                <div className="space-y-2">
                  {s.overpayAlerts.map((a) => (
                    <div key={a.transactionId} className="flex items-start justify-between gap-3 rounded-md border border-warning/30 bg-warning/5 p-3 text-sm">
                      <div className="min-w-0">
                        <p className="font-medium">
                          {t("admin.clientDetail.fuelStationPaid", {
                            station: a.stationName ?? t("admin.clientDetail.fuelStationFallback"),
                            price: (a.paidCentsPerGallon / 100).toFixed(2),
                          })}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {t("admin.clientDetail.fuelCheaperNearby", {
                            km: a.cheaperDistanceKm.toFixed(1),
                            place: a.cheaperAtName ?? t("admin.clientDetail.fuelOtherPlace"),
                            price: (a.cheaperCentsPerGallon / 100).toFixed(2),
                            time: new Date(a.occurredAt).toLocaleString(),
                          })}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-sm font-semibold text-warning">+${a.savedDollars.toFixed(2)}</p>
                        <p className="text-[10px] text-muted-foreground">{t("admin.clientDetail.fuelOverpaid")}</p>
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
  const { t } = useT();
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
            <span>{t("admin.clientDetail.iftaTitle")}</span>
            <a
              href={csvUrl}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
              download
            >
              {t("admin.clientDetail.iftaDownloadCsv")}
            </a>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">{t("admin.clientDetail.iftaYear")}</Label>
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
              <Label className="text-xs text-muted-foreground">{t("admin.clientDetail.iftaQuarter")}</Label>
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
            {t("admin.clientDetail.iftaHint")}
          </p>
        </CardContent>
      </Card>

      {q.isLoading && (
        <Card>
          <CardContent className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            {t("admin.clientDetail.iftaCalculating")}
          </CardContent>
        </Card>
      )}

      {q.data && (
        <>
          {/* Totals */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label={t("admin.clientDetail.iftaTotalMiles")} value={`${q.data.totals.miles.toLocaleString()} mi`} />
            <Stat label={t("admin.clientDetail.iftaTotalGallons")} value={`${q.data.totals.gallons.toLocaleString()} gal`} />
            <Stat label={t("admin.clientDetail.iftaFuelCost")} value={`$${q.data.totals.fuelCostUsd.toLocaleString()}`} />
            <Stat
              label={t("admin.clientDetail.iftaAvgMpg")}
              value={q.data.totals.avgMpg != null ? q.data.totals.avgMpg.toFixed(2) : "—"}
            />
          </div>

          {/* State breakdown */}
          <Card>
            <CardHeader>
              <CardTitle>{t("admin.clientDetail.iftaByState")}</CardTitle>
            </CardHeader>
            <CardContent>
              {q.data.rows.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {t("admin.clientDetail.iftaNoQuarterData")}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                        <th className="py-2 pr-3">{t("admin.clientDetail.iftaColState")}</th>
                        <th className="py-2 pr-3 text-right">{t("admin.clientDetail.iftaColMiles")}</th>
                        <th className="py-2 pr-3 text-right">{t("admin.clientDetail.iftaColGallons")}</th>
                        <th className="py-2 pr-3 text-right">{t("admin.clientDetail.iftaColCost")}</th>
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
                {t("admin.clientDetail.iftaUnknownState", {
                  miles: q.data.unknownStateMiles,
                  gallons: q.data.unknownStateGallons,
                })}
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
  const { t } = useT();
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
              {t("admin.clientDetail.safetyDownloadMd")}
            </a>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            {t("admin.clientDetail.safetyIntro1")}
          </p>
          <p className="text-xs">
            {t("admin.clientDetail.safetyIntro2")}
          </p>
        </CardContent>
      </Card>

      {q.isLoading && (
        <Card>
          <CardContent className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            {t("admin.clientDetail.safetyBuilding")}
          </CardContent>
        </Card>
      )}

      {q.isError && (
        <Card>
          <CardContent className="py-4 text-sm text-destructive">
            {t("admin.clientDetail.safetyLoadError")}
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
  const { t } = useT();
  const badgeMap: Record<SafetyProfile["verdict"]["level"], { label: string; cls: string }> = {
    green: { label: t("admin.clientDetail.verdictGreen"), cls: "bg-success/10 text-success border-success/30" },
    yellow: { label: t("admin.clientDetail.verdictYellow"), cls: "bg-warning/10 text-warning border-warning/30" },
    red: { label: t("admin.clientDetail.verdictRed"), cls: "bg-destructive/10 text-destructive border-destructive/30" },
    unknown: { label: t("admin.clientDetail.verdictUnknown"), cls: "bg-muted text-muted-foreground border-border" },
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
            {t("admin.clientDetail.fmcsaNotLoaded")}
          </p>
        )}
        {verdict.strengths.length > 0 && (
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t("admin.clientDetail.strengths")}</p>
            <ul className="mt-1 space-y-1 text-sm">
              {verdict.strengths.map((s, i) => (
                <li key={i} className="flex gap-2"><span className="text-success">✓</span>{s}</li>
              ))}
            </ul>
          </div>
        )}
        {verdict.risks.length > 0 && (
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t("admin.clientDetail.risks")}</p>
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
  const { t } = useT();
  const labelMap = { cargo: "Cargo", liability: "Auto liability", general: "General liability" };
  const statusClass = (s: SafetyProfile["insurance"][number]["status"]) =>
    s === "active" ? "text-success"
    : s === "expiring" ? "text-warning"
    : s === "expired" ? "text-destructive"
    : "text-muted-foreground";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("admin.clientDetail.insuranceTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2 text-sm">
          {insurance.map((ins) => (
            <div key={ins.kind} className="flex items-center justify-between border-b border-border/50 py-1.5">
              <span className="font-medium">{labelMap[ins.kind]}</span>
              <span className={`text-right ${statusClass(ins.status)}`}>
                {ins.status === "missing"
                  ? t("admin.clientDetail.insuranceMissing")
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
  const { t } = useT();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("admin.clientDetail.operationalHistory")}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label={t("admin.clientDetail.opLoadsTotal")} value={String(op.loadsTotal)} />
          <Stat label={t("admin.clientDetail.opLast90d")} value={String(op.loadsLast90d)} />
          <Stat label={t("admin.clientDetail.opDelivered")} value={String(op.loadsDelivered)} />
          <Stat label={t("admin.clientDetail.opActiveNow")} value={String(op.loadsActive)} />
        </div>
        {op.firstActivityAt && (
          <p className="mt-3 text-xs text-muted-foreground">
            {t("admin.clientDetail.opFirstActivity", { date: new Date(op.firstActivityAt).toISOString().slice(0, 10) })}
            {op.lastActivityAt && t("admin.clientDetail.opLastActivity", { date: new Date(op.lastActivityAt).toISOString().slice(0, 10) })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ClearinghouseTab — FMCSA Drug & Alcohol Clearinghouse query log (49 CFR §382)
// Backend: GET /api/admin/clients/:id/clearinghouse
//          POST /api/admin/users/:userId/clearinghouse
// ---------------------------------------------------------------------------

interface ClearinghouseDriverRow {
  user_id: string;
  full_name: string;
  email: string;
  last_annual_at: string | null;
  annual_valid_until: string | null;
  annual_result: string | null;
  pre_employment_at: string | null;
}

function ClearinghouseTab({ client }: { client: Client }) {
  const { t } = useT();
  const qc = useQueryClient();
  const queryKey = ["/api/admin/clients", client.id, "clearinghouse"] as const;
  const q = useQuery<{ drivers: ClearinghouseDriverRow[] }>({
    queryKey,
    queryFn: () =>
      apiJson<{ drivers: ClearinghouseDriverRow[] }>(
        "GET",
        `/api/admin/clients/${client.id}/clearinghouse`,
      ),
  });

  const [recording, setRecording] = useState<ClearinghouseDriverRow | null>(null);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>FMCSA Drug & Alcohol Clearinghouse</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            {t("admin.clientDetail.clearinghouseIntro1")}
          </p>
          <p className="text-xs">
            {t("admin.clientDetail.clearinghouseIntro2")}
          </p>
        </CardContent>
      </Card>

      {q.isLoading && (
        <Card>
          <CardContent className="flex h-24 items-center justify-center text-sm text-muted-foreground">
            …
          </CardContent>
        </Card>
      )}

      {q.data && q.data.drivers.length === 0 && (
        <Card>
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            {t("admin.clientDetail.clearinghouseNoDrivers")}
          </CardContent>
        </Card>
      )}

      {q.data && q.data.drivers.length > 0 && (
        <Card>
          <CardContent className="pt-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="py-2 pr-3">{t("admin.clientDetail.chColDriver")}</th>
                    <th className="py-2 pr-3">{t("admin.clientDetail.chColPreEmployment")}</th>
                    <th className="py-2 pr-3">{t("admin.clientDetail.chColAnnualLast")}</th>
                    <th className="py-2 pr-3">{t("admin.clientDetail.chColAnnualValidUntil")}</th>
                    <th className="py-2 pr-3">{t("admin.clientDetail.chColStatus")}</th>
                    <th className="py-2 pr-3 text-right">{t("admin.clientDetail.chColAction")}</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.drivers.map((d) => (
                    <ClearinghouseRow key={d.user_id} row={d} onRecord={() => setRecording(d)} />
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {recording && (
        <ClearinghouseRecordDialog
          driver={recording}
          onClose={() => setRecording(null)}
          onSaved={() => {
            setRecording(null);
            qc.invalidateQueries({ queryKey });
          }}
        />
      )}
    </div>
  );
}

function ClearinghouseRow({
  row, onRecord,
}: { row: ClearinghouseDriverRow; onRecord: () => void }) {
  const { t } = useT();
  const annualValidMs = row.annual_valid_until ? new Date(row.annual_valid_until).getTime() : null;
  const annualDaysLeft = annualValidMs !== null
    ? Math.floor((annualValidMs - Date.now()) / (24 * 3600 * 1000))
    : null;

  let statusLabel: string;
  let statusCls: string;
  if (row.annual_result === "prohibited") {
    statusLabel = t("admin.clientDetail.chStatusProhibited");
    statusCls = "text-destructive";
  } else if (annualDaysLeft === null) {
    statusLabel = t("admin.clientDetail.chStatusAnnualMissing");
    statusCls = "text-destructive";
  } else if (annualDaysLeft < 0) {
    statusLabel = t("admin.clientDetail.chStatusExpired", { days: -annualDaysLeft });
    statusCls = "text-destructive";
  } else if (annualDaysLeft <= 60) {
    statusLabel = t("admin.clientDetail.chStatusDue", { days: annualDaysLeft });
    statusCls = "text-warning";
  } else {
    statusLabel = t("admin.clientDetail.chStatusCurrent");
    statusCls = "text-success";
  }

  return (
    <tr className="border-b border-border/40">
      <td className="py-2 pr-3 font-medium">{row.full_name || row.email}</td>
      <td className="py-2 pr-3 text-xs text-muted-foreground">
        {row.pre_employment_at ? new Date(row.pre_employment_at).toISOString().slice(0, 10) : "—"}
      </td>
      <td className="py-2 pr-3 text-xs text-muted-foreground">
        {row.last_annual_at ? new Date(row.last_annual_at).toISOString().slice(0, 10) : "—"}
      </td>
      <td className="py-2 pr-3 text-xs text-muted-foreground">
        {row.annual_valid_until ? new Date(row.annual_valid_until).toISOString().slice(0, 10) : "—"}
      </td>
      <td className={`py-2 pr-3 text-xs font-medium ${statusCls}`}>{statusLabel}</td>
      <td className="py-2 pr-3 text-right">
        <Button size="sm" variant="outline" onClick={onRecord}>{t("admin.clientDetail.chRecordQuery")}</Button>
      </td>
    </tr>
  );
}

function ClearinghouseRecordDialog({
  driver, onClose, onSaved,
}: {
  driver: ClearinghouseDriverRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useT();
  const toast = useToast();
  const [queryType, setQueryType] = useState<"pre_employment" | "annual">("annual");
  const [result, setResult] = useState<"clear" | "prohibited" | "pending" | "consent_revoked">("clear");
  const [queriedAt, setQueriedAt] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");

  const mut = useMutation({
    mutationFn: () => apiJson("POST", `/api/admin/users/${driver.user_id}/clearinghouse`, {
      queryType,
      result,
      queriedAt: new Date(queriedAt + "T12:00:00Z").toISOString(),
      notes: notes.trim() || undefined,
    }),
    onSuccess: () => {
      toast.toast({ title: t("admin.clientDetail.chSavedTitle"), description: t("admin.clientDetail.chSavedDesc") });
      onSaved();
    },
    onError: (err) => {
      toast.toast({
        title: t("common.error"),
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
        <h3 className="text-base font-semibold">{t("admin.clientDetail.chDialogTitle")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{driver.full_name || driver.email}</p>

        <div className="mt-4 space-y-3 text-sm">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t("admin.clientDetail.chQueryType")}</label>
            <div className="inline-flex rounded-md border border-border bg-muted/30 p-1">
              {(["pre_employment", "annual"] as const).map((qt) => (
                <button
                  key={qt}
                  type="button"
                  onClick={() => setQueryType(qt)}
                  className={`rounded px-3 py-1 text-xs font-medium transition ${
                    queryType === qt ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {qt === "pre_employment" ? t("admin.clientDetail.chColPreEmployment") : t("admin.clientDetail.chAnnual")}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t("admin.clientDetail.chQueryDate")}</label>
            <Input
              type="date"
              value={queriedAt}
              onChange={(e) => setQueriedAt(e.target.value)}
              className="max-w-xs"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t("admin.clientDetail.chResult")}</label>
            <select
              value={result}
              onChange={(e) => setResult(e.target.value as typeof result)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            >
              <option value="clear">{t("admin.clientDetail.chResultClear")}</option>
              <option value="prohibited">{t("admin.clientDetail.chResultProhibited")}</option>
              <option value="pending">{t("admin.clientDetail.chResultPending")}</option>
              <option value="consent_revoked">{t("admin.clientDetail.chResultConsentRevoked")}</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t("admin.clientDetail.chNotes")}</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder={t("admin.clientDetail.chNotesPlaceholder")}
              className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={mut.isPending}>{t("common.cancel")}</Button>
            <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
              {mut.isPending ? t("admin.clientDetail.saving") : t("admin.clientDetail.chRecord")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ComplianceDocsCard — upload + list of carrier-scoped compliance docs
// ---------------------------------------------------------------------------
//
// Two ways to capture compliance dates (per user request 2026-05-26):
//   1. Type the date manually in the cards above.
//   2. Upload a photo / PDF of the doc here — the server auto-fills the
//      matching cargoInsuranceExpiresAt / ucrExpiresAt / etc on the client
//      when an expiry is provided with the upload.
//
// Owner-operator drivers upload directly via the driver portal
// (/api/me/documents). Those land with client_id auto-set to their
// linked_client_id so they appear here too.

interface ComplianceDoc {
  id: string;
  ownerUserId: string;
  clientId: string | null;
  type:
    | "cargo_insurance" | "auto_liability" | "general_liability"
    | "ucr_certificate" | "irp_cab_card" | "mcs150" | "dq_file"
    | "dq_application" | "dq_inquiry_prev_employer" | "dq_mvr"
    | "dq_road_test" | "dq_annual_review"
    | "cdl" | "medical" | "coi" | "w9" | "ifta" | "other";
  fileName: string;
  storagePath: string;
  expiresAt: string | null;
  notes: string | null;
  createdAt: string;
}

const COMPLIANCE_DOC_TYPES = [
  { value: "cargo_insurance", label: "Cargo insurance" },
  { value: "auto_liability", label: "Auto liability" },
  { value: "general_liability", label: "General liability" },
  { value: "ucr_certificate", label: "UCR certificate" },
  { value: "irp_cab_card", label: "IRP cab card" },
  { value: "mcs150", label: "MCS-150" },
  { value: "dq_file", label: "DQ file (general)" },
  // FMCSA §391 per-driver — эти виды чаще живут на driver,
  // но компания тоже может загрузить за них.
  { value: "dq_application", label: "DQ — анкета водителя" },
  { value: "dq_inquiry_prev_employer", label: "DQ — запрос пред. работодателю" },
  { value: "dq_mvr", label: "DQ — MVR (ежегодно)" },
  { value: "dq_road_test", label: "DQ — road test cert" },
  { value: "dq_annual_review", label: "DQ — annual driving review" },
  { value: "medical", label: "Medical certificate (§391.43)" },
  { value: "cdl", label: "CDL copy (§391.11)" },
  { value: "other", label: "Другое" },
] as const;

function ComplianceDocsCard({ clientId }: { clientId: string }) {
  const { t } = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [docType, setDocType] = useState<string>("cargo_insurance");
  const [docExpires, setDocExpires] = useState<string>("");
  const [docNotes, setDocNotes] = useState<string>("");
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const q = useQuery<{ items: ComplianceDoc[]; total: number }>({
    queryKey: ["/api/admin/clients", clientId, "documents"],
    queryFn: () => apiJson("GET", `/api/admin/clients/${clientId}/documents`),
  });

  async function handleUpload() {
    if (!pickedFile) {
      toast({ title: t("admin.clientDetail.docsPickFile"), variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", pickedFile);
      fd.append("type", docType);
      if (docExpires) fd.append("expiresAt", docExpires);
      if (docNotes) fd.append("notes", docNotes);
      const res = await fetch(`/api/admin/clients/${clientId}/documents`, {
        method: "POST",
        body: fd,
        credentials: "same-origin",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error((j as { message?: string })?.message ?? `${res.status}`);
      }
      toast({ title: t("admin.clientDetail.docsUploaded") });
      setPickedFile(null);
      setDocExpires("");
      setDocNotes("");
      await queryClient.invalidateQueries({
        queryKey: ["/api/admin/clients", clientId, "documents"],
      });
      // Also refetch the client so the auto-filled date shows up immediately.
      await queryClient.invalidateQueries({
        queryKey: ["/api/admin/clients", clientId],
      });
    } catch (err) {
      toast({
        title: t("admin.clientDetail.docsUploadFailed"),
        description: (err as Error).message,
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(docId: string) {
    if (!window.confirm(t("admin.clientDetail.docsDeleteConfirm"))) return;
    try {
      const res = await fetch(
        `/api/admin/clients/${clientId}/documents/${docId}`,
        { method: "DELETE", credentials: "same-origin" },
      );
      if (!res.ok) throw new Error(`${res.status}`);
      await queryClient.invalidateQueries({
        queryKey: ["/api/admin/clients", clientId, "documents"],
      });
    } catch (err) {
      toast({
        title: t("admin.clientDetail.docsDeleteFailed"),
        description: (err as Error).message,
        variant: "destructive",
      });
    }
  }

  const items = q.data?.items ?? [];

  const docTypeLabel = (value: string, fallback: string) => {
    const key = `admin.clientDetail.docType.${value}`;
    const translated = t(key);
    return translated === key ? fallback : translated;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <FileText className="h-4 w-4" /> {t("admin.clientDetail.docsTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {t("admin.clientDetail.docsHint")}
        </p>

        <div className="grid gap-3 rounded-lg border border-dashed border-border p-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">{t("admin.clientDetail.docsType")}</Label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={docType}
              onChange={(e) => setDocType(e.target.value)}
            >
              {COMPLIANCE_DOC_TYPES.map((dt) => (
                <option key={dt.value} value={dt.value}>{docTypeLabel(dt.value, dt.label)}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("admin.clientDetail.docsExpires")}</Label>
            <Input
              type="date"
              value={docExpires}
              onChange={(e) => setDocExpires(e.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs">{t("admin.clientDetail.docsNote")}</Label>
            <Input
              value={docNotes}
              onChange={(e) => setDocNotes(e.target.value)}
              placeholder={t("admin.clientDetail.docsNotePlaceholder")}
              maxLength={500}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs">{t("admin.clientDetail.docsFile")}</Label>
            <Input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              onChange={(e) => setPickedFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="sm:col-span-2 flex justify-end">
            <Button
              size="sm"
              onClick={handleUpload}
              disabled={!pickedFile || uploading}
              className="gap-2"
            >
              {uploading ? (
                <><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("common.loading")}</>
              ) : (
                <><Upload className="h-3.5 w-3.5" /> {t("admin.clientDetail.docsUpload")}</>
              )}
            </Button>
          </div>
        </div>

        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("admin.clientDetail.docsEmpty")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {items.map((d) => {
              const fallbackLabel =
                COMPLIANCE_DOC_TYPES.find((dt) => dt.value === d.type)?.label ?? d.type;
              const label = docTypeLabel(d.type, fallbackLabel);
              return (
                <li
                  key={d.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">{label}</Badge>
                      <span className="truncate font-medium">{d.fileName}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {d.expiresAt ? t("admin.clientDetail.docsExpiresOn", { date: d.expiresAt }) : t("admin.clientDetail.docsNoExpiry")}
                      {" · "}
                      {t("admin.clientDetail.docsUploadedOn", { date: new Date(d.createdAt).toLocaleDateString() })}
                      {d.notes ? ` · ${d.notes.slice(0, 50)}` : ""}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => handleDelete(d.id)}
                    title={t("admin.clientDetail.docsDeleteTitle")}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
