import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronsUpDown,
  Copy,
  Loader2,
  Mail,
  Radio,
} from "lucide-react";
import type { Client } from "@shared/schema";
import { apiJson, ApiError } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import type { AdapterMeta } from "./load-sources";

/**
 * /admin/load-sources/new — 4-step wizard to create a load source.
 *
 * Step 1: adapter + client + label
 * Step 2: dynamic config form (per adapter)
 * Step 3: credentials (only if adapter.requiresCredentials)
 * Step 4: poll interval + status
 *
 * Backend: POST /api/admin/load-sources (server/routes/admin-load-sources.ts).
 * Credentials sent as plaintext; backend encrypts (AES-256-GCM). 503 if the
 * keyring env (DISPATCHOS_KEYRING_PRIMARY) isn't set.
 */

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY",
];

// What config + credential fields each adapter needs. Mirrors the backend
// adapter contract (server/lib/adapters/*). Stub adapters are listed so the
// form is ready the moment they're implemented.
type FieldDef = { key: string; label: string; labelKey?: string; placeholder?: string; placeholderKey?: string; type?: "text" | "number" | "state" };
interface AdapterShape {
  config: FieldDef[];
  credentials: FieldDef[];
}
const ADAPTER_SHAPES: Record<string, AdapterShape> = {
  mock: {
    config: [
      { key: "originState", label: "Откуда (штат)", labelKey: "admin.loadSourceNew.fieldOriginState", type: "state" },
      { key: "destinationState", label: "Куда (штат)", labelKey: "admin.loadSourceNew.fieldDestinationState", type: "state" },
      { key: "count", label: "Сколько грузов генерировать", labelKey: "admin.loadSourceNew.fieldCount", type: "number", placeholder: "5" },
    ],
    credentials: [],
  },
  sylectus_email: {
    config: [
      { key: "inboundAddress", label: "Inbound адрес", labelKey: "admin.loadSourceNew.fieldInboundAddress", placeholder: "loads+ivan@dispatchos.co" },
    ],
    credentials: [],
  },
  super_dispatch: {
    config: [
      { key: "savedSearchId", label: "Saved Search ID", placeholder: "(опц.)", placeholderKey: "admin.loadSourceNew.placeholderOptional" },
      { key: "equipmentFilter", label: "Equipment filter", placeholder: "(опц.)", placeholderKey: "admin.loadSourceNew.placeholderOptional" },
    ],
    credentials: [
      { key: "username", label: "Username" },
      { key: "password", label: "Password" },
    ],
  },
  one23_loadboard: {
    config: [{ key: "endpoint", label: "Endpoint", placeholder: "https://api.123loadboard.com/v1" }],
    credentials: [{ key: "apiKey", label: "API Key" }],
  },
  dat_scraper: {
    config: [{ key: "savedSearchUrl", label: "Saved Search URL" }],
    credentials: [
      { key: "username", label: "Username" },
      { key: "password", label: "Password" },
    ],
  },
  rxo_email: { config: [{ key: "fromDomain", label: "From-домен", labelKey: "admin.loadSourceNew.fieldFromDomain", placeholder: "rxo.com" }], credentials: [] },
  tql_email: { config: [{ key: "fromDomain", label: "From-домен", labelKey: "admin.loadSourceNew.fieldFromDomain", placeholder: "tql.com" }], credentials: [] },
  coyote_email: { config: [{ key: "fromDomain", label: "From-домен", labelKey: "admin.loadSourceNew.fieldFromDomain", placeholder: "coyote.com" }], credentials: [] },
  echo_email: { config: [{ key: "fromDomain", label: "From-домен", labelKey: "admin.loadSourceNew.fieldFromDomain", placeholder: "echo.com" }], credentials: [] },
  landstar_email: { config: [{ key: "fromDomain", label: "From-домен", labelKey: "admin.loadSourceNew.fieldFromDomain", placeholder: "landstar.com" }], credentials: [] },
  chr_navisphere: {
    config: [{ key: "customerCode", label: "Customer Code" }],
    credentials: [
      { key: "clientId", label: "Client ID" },
      { key: "clientSecret", label: "Client Secret" },
    ],
  },
};

function shapeFor(adapterKey: string): AdapterShape {
  return ADAPTER_SHAPES[adapterKey] ?? { config: [], credentials: [] };
}

export default function LoadSourceNewPage() {
  const { t } = useT();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [step, setStep] = useState(1);

  // Step 1
  const [adapterKey, setAdapterKey] = useState("");
  const [clientId, setClientId] = useState("");
  const [label, setLabel] = useState("");
  // Step 2 + 3 — keyed by field key
  const [config, setConfig] = useState<Record<string, string>>({});
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  // Step 4
  const [pollIntervalMin, setPollIntervalMin] = useState("15");
  const [status, setStatus] = useState<"active" | "paused">("paused");
  // Post-create: the minted per-source forwarding address (email adapters).
  // Held here so we can show it with copy + setup instructions BEFORE leaving
  // the wizard — it exists nowhere else in the flow, and mail sent to the bare
  // base address matches no source and never becomes a load.
  const [createdInbound, setCreatedInbound] = useState<string | null>(null);
  const [inboundCopied, setInboundCopied] = useState(false);

  const { data: adapterData } = useQuery<{ adapters: AdapterMeta[] }>({
    queryKey: ["/api/admin/load-sources/adapters"],
    queryFn: () => apiJson("GET", "/api/admin/load-sources/adapters"),
    staleTime: 5 * 60_000,
  });
  const adapters = adapterData?.adapters ?? [];
  const selectedAdapter = adapters.find((a) => a.key === adapterKey);
  const shape = shapeFor(adapterKey);
  const needsCreds = selectedAdapter?.requiresCredentials ?? false;

  // Steps present depend on whether credentials are needed.
  const steps = needsCreds ? [1, 2, 3, 4] : [1, 2, 4];
  const stepLabels: Record<number, string> = {
    1: t("admin.loadSourceNew.step1"),
    2: t("admin.loadSourceNew.step2"),
    3: t("admin.loadSourceNew.step3"),
    4: t("admin.loadSourceNew.step4"),
  };

  const createMutation = useMutation({
    mutationFn: () => {
      // Coerce numeric config fields.
      const cfg: Record<string, unknown> = {};
      const cfgFields = shape.config;
      for (const f of cfgFields) {
        const v = config[f.key];
        if (v === undefined || v === "") continue;
        // mock lane is nested under `lane`
        if (adapterKey === "mock" && (f.key === "originState" || f.key === "destinationState")) {
          cfg.lane = { ...(cfg.lane as object), [f.key]: v };
        } else if (f.type === "number") {
          cfg[f.key] = Number(v);
        } else {
          cfg[f.key] = v;
        }
      }
      // Clamp poll interval to the supported 1–1440 range; fall back to 15 for
      // empty/non-numeric input (the HTML min/max attrs don't enforce typed values).
      const pollNum = Number(pollIntervalMin);
      const body: Record<string, unknown> = {
        clientId,
        adapterKey,
        label,
        configJson: cfg,
        pollIntervalMin: Number.isFinite(pollNum)
          ? Math.min(1440, Math.max(1, Math.round(pollNum)))
          : 15,
        status,
      };
      if (needsCreds) {
        // Filter credentials by the current adapter shape so stale fields from a
        // previously-selected adapter never leak into the payload.
        body.credentials = Object.fromEntries(
          shape.credentials.map((f) => [f.key, credentials[f.key] ?? ""]),
        );
      }
      return apiJson<{ loadSource?: { configJson?: Record<string, unknown> } }>(
        "POST",
        "/api/admin/load-sources",
        body,
      );
    },
    onSuccess: (res) => {
      toast({ title: t("admin.loadSourceNew.sourceCreated") });
      qc.invalidateQueries({ queryKey: ["/api/admin/load-sources"], exact: false });
      // Email adapters auto-mint a unique forwarding address — show it before
      // redirecting (see createdInbound). Everything else goes straight back.
      const inbound = res?.loadSource?.configJson?.inboundAddress;
      if (typeof inbound === "string" && inbound) {
        setCreatedInbound(inbound);
      } else {
        setLocation("/load-sources");
      }
    },
    onError: (err: Error) => {
      const msg =
        err instanceof ApiError && err.status === 503
          ? t("admin.loadSourceNew.keyringNotConfigured")
          : err.message;
      toast({ title: t("admin.loadSourceNew.createFailed"), description: msg, variant: "destructive" });
    },
  });

  // Validation per step.
  const step1Valid = adapterKey && clientId && label.trim().length > 0;
  const step3Valid = !needsCreds || shape.credentials.every((f) => (credentials[f.key] ?? "").length > 0);
  // Poll interval: empty is fine (defaults to 15 on submit); a typed value must be
  // a finite number within the supported 1–1440 range.
  const pollNum = Number(pollIntervalMin);
  const pollValid =
    pollIntervalMin.trim() === "" ||
    (Number.isFinite(pollNum) && pollNum >= 1 && pollNum <= 1440);

  function goNext() {
    const idx = steps.indexOf(step);
    if (idx < steps.length - 1) setStep(steps[idx + 1]);
  }
  function goBack() {
    const idx = steps.indexOf(step);
    if (idx > 0) setStep(steps[idx - 1]);
    else setLocation("/load-sources");
  }
  const isLastStep = step === steps[steps.length - 1];

  // Post-create success: the forwarding address hand-off. The address is the
  // deliverable of an email source — copy it, wire the broker / auto-forward,
  // then leave.
  if (createdInbound) {
    const copyInbound = async () => {
      try {
        await navigator.clipboard.writeText(createdInbound);
        setInboundCopied(true);
        setTimeout(() => setInboundCopied(false), 1500);
      } catch {
        // clipboard blocked — the address stays visible for manual copy
      }
    };
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("admin.loadSourceNew.breadcrumb")}
          </p>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Mail className="h-6 w-6 text-primary" /> {t("admin.loadSourceNew.inboundTitle")}
          </h1>
        </div>
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="space-y-1.5">
              <Label>{t("admin.loadSourceNew.inboundAddressLabel")}</Label>
              <div className="flex items-center gap-2">
                <Input readOnly value={createdInbound} className="font-mono text-xs" />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={copyInbound}
                  aria-label={t("admin.loadSourceNew.copyAddress")}
                >
                  {inboundCopied ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("admin.loadSourceNew.inboundDesc")}
            </p>
            <div className="flex justify-end">
              <Button onClick={() => setLocation("/load-sources")}>
                {t("admin.loadSourceNew.goToSources")}
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <button
        onClick={() => setLocation("/load-sources")}
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> {t("admin.loadSourceNew.backToSources")}
      </button>

      <div>
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {t("admin.loadSourceNew.breadcrumb")}
        </p>
        <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Radio className="h-6 w-6 text-primary" /> {t("admin.loadSourceNew.title")}
        </h1>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2">
        {steps.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold",
                step === s
                  ? "bg-primary text-primary-foreground"
                  : steps.indexOf(step) > i
                  ? "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {steps.indexOf(step) > i ? <Check className="h-4 w-4" /> : i + 1}
            </div>
            <span className={cn("text-xs", step === s ? "font-medium" : "text-muted-foreground")}>
              {stepLabels[s]}
            </span>
            {i < steps.length - 1 && <div className="h-px w-6 bg-border" />}
          </div>
        ))}
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          {/* Step 1 */}
          {step === 1 && (
            <>
              <div className="space-y-1.5">
                <Label>{t("admin.loadSourceNew.adapter")}</Label>
                <Select
                  value={adapterKey}
                  onValueChange={(v) => {
                    setAdapterKey(v);
                    // Reset per-adapter form state so leftover config/credentials
                    // from a previously-selected adapter don't carry over.
                    setConfig({});
                    setCredentials({});
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("admin.loadSourceNew.selectSource")} />
                  </SelectTrigger>
                  <SelectContent>
                    {adapters.map((a) => (
                      <SelectItem key={a.key} value={a.key} disabled={!a.implemented}>
                        {a.label}
                        {!a.implemented && ` — ${t("admin.loadSourceNew.comingSoon")}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>{t("admin.loadSourceNew.client")}</Label>
                <ClientCombobox value={clientId} onChange={setClientId} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="label">{t("admin.loadSourceNew.name")}</Label>
                <Input
                  id="label"
                  value={label}
                  placeholder="Ivan's SuperDispatch"
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>
            </>
          )}

          {/* Step 2 — dynamic config */}
          {step === 2 && (
            <>
              {shape.config.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("admin.loadSourceNew.noExtraSettings")}
                </p>
              ) : (
                shape.config.map((f) => (
                  <div key={f.key} className="space-y-1.5">
                    <Label>{f.labelKey ? t(f.labelKey) : f.label}</Label>
                    {f.type === "state" ? (
                      <Select
                        value={config[f.key] ?? ""}
                        onValueChange={(v) => setConfig((c) => ({ ...c, [f.key]: v }))}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={t("admin.loadSourceNew.statePlaceholder")} />
                        </SelectTrigger>
                        <SelectContent className="max-h-64">
                          {US_STATES.map((st) => (
                            <SelectItem key={st} value={st}>
                              {st}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        type={f.type === "number" ? "number" : "text"}
                        value={config[f.key] ?? ""}
                        placeholder={f.placeholderKey ? t(f.placeholderKey) : f.placeholder}
                        onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}
                      />
                    )}
                  </div>
                ))
              )}
            </>
          )}

          {/* Step 3 — credentials */}
          {step === 3 && needsCreds && (
            <>
              <p className="text-xs text-muted-foreground">
                {t("admin.loadSourceNew.credentialsNotice")}
              </p>
              {shape.credentials.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label>{f.labelKey ? t(f.labelKey) : f.label}</Label>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={credentials[f.key] ?? ""}
                    onChange={(e) => setCredentials((c) => ({ ...c, [f.key]: e.target.value }))}
                  />
                </div>
              ))}
            </>
          )}

          {/* Step 4 — poll + status */}
          {step === 4 && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="poll">{t("admin.loadSourceNew.pollInterval")}</Label>
                <Input
                  id="poll"
                  type="number"
                  min={1}
                  max={1440}
                  value={pollIntervalMin}
                  onChange={(e) => setPollIntervalMin(e.target.value)}
                />
                <p className="text-[11px] text-muted-foreground">
                  {t("admin.loadSourceNew.pollHint")}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>{t("admin.loadSourceNew.statusOnCreate")}</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as "active" | "paused")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="paused">{t("admin.loadSourceNew.statusPaused")}</SelectItem>
                    <SelectItem value="active">{t("admin.loadSourceNew.statusActive")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Nav buttons */}
      <div className="flex items-center justify-between">
        <Button variant="outline" onClick={goBack}>
          <ArrowLeft className="h-4 w-4" /> {t("admin.loadSourceNew.back")}
        </Button>
        {isLastStep ? (
          <Button
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending || !step1Valid || !step3Valid || !pollValid}
          >
            {createMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            {t("admin.loadSourceNew.createSource")}
          </Button>
        ) : (
          <Button
            onClick={goNext}
            disabled={(step === 1 && !step1Valid) || (step === 3 && !step3Valid)}
          >
            {t("admin.loadSourceNew.next")} <ArrowRight className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

function ClientCombobox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const { data: clients = [], isLoading } = useQuery<Client[]>({
    queryKey: ["/api/clients"],
    queryFn: () => apiJson("GET", "/api/clients"),
    staleTime: 60_000,
  });
  const selected = clients.find((c) => c.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          {selected ? (
            <span className="flex flex-col items-start text-left">
              <span className="text-sm">{selected.name}</span>
              <span className="text-[11px] text-muted-foreground">
                {selected.mc} · {selected.id}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">
              {isLoading ? t("common.loading") : t("admin.loadSourceNew.selectClient")}
            </span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder={t("admin.loadSourceNew.clientSearchPlaceholder")} />
          <CommandEmpty>{t("admin.loadSourceNew.noClientsFound")}</CommandEmpty>
          <CommandGroup className="max-h-64 overflow-auto">
            {clients.map((c) => (
              <CommandItem
                key={c.id}
                value={`${c.name} ${c.mc} ${c.id}`}
                onSelect={() => {
                  onChange(c.id);
                  setOpen(false);
                }}
              >
                <Check
                  className={cn("mr-2 h-4 w-4", value === c.id ? "opacity-100" : "opacity-0")}
                />
                <div className="flex flex-col">
                  <span className="text-sm">{c.name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {c.mc} · {c.id}
                  </span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
