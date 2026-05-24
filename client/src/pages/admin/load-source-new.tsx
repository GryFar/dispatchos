import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronsUpDown,
  Loader2,
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
type FieldDef = { key: string; label: string; placeholder?: string; type?: "text" | "number" | "state" };
interface AdapterShape {
  config: FieldDef[];
  credentials: FieldDef[];
}
const ADAPTER_SHAPES: Record<string, AdapterShape> = {
  mock: {
    config: [
      { key: "originState", label: "Откуда (штат)", type: "state" },
      { key: "destinationState", label: "Куда (штат)", type: "state" },
      { key: "count", label: "Сколько грузов генерировать", type: "number", placeholder: "5" },
    ],
    credentials: [],
  },
  sylectus_email: {
    config: [
      { key: "inboundAddress", label: "Inbound адрес", placeholder: "loads+ivan@dispatchos.co" },
    ],
    credentials: [],
  },
  super_dispatch: {
    config: [
      { key: "savedSearchId", label: "Saved Search ID", placeholder: "(опц.)" },
      { key: "equipmentFilter", label: "Equipment filter", placeholder: "(опц.)" },
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
  rxo_email: { config: [{ key: "fromDomain", label: "From-домен", placeholder: "rxo.com" }], credentials: [] },
  tql_email: { config: [{ key: "fromDomain", label: "From-домен", placeholder: "tql.com" }], credentials: [] },
  coyote_email: { config: [{ key: "fromDomain", label: "From-домен", placeholder: "coyote.com" }], credentials: [] },
  echo_email: { config: [{ key: "fromDomain", label: "From-домен", placeholder: "echo.com" }], credentials: [] },
  landstar_email: { config: [{ key: "fromDomain", label: "From-домен", placeholder: "landstar.com" }], credentials: [] },
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
    1: "Адаптер и клиент",
    2: "Настройки",
    3: "Доступы",
    4: "Опрос",
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
      const body: Record<string, unknown> = {
        clientId,
        adapterKey,
        label,
        configJson: cfg,
        pollIntervalMin: Number(pollIntervalMin) || 15,
        status,
      };
      if (needsCreds) body.credentials = credentials;
      return apiJson("POST", "/api/admin/load-sources", body);
    },
    onSuccess: () => {
      toast({ title: "Источник создан" });
      qc.invalidateQueries({ queryKey: ["/api/admin/load-sources"], exact: false });
      setLocation("/load-sources");
    },
    onError: (err: Error) => {
      const msg =
        err instanceof ApiError && err.status === 503
          ? "Ключ шифрования не настроен на сервере (DISPATCHOS_KEYRING_PRIMARY)."
          : err.message;
      toast({ title: "Не удалось создать", description: msg, variant: "destructive" });
    },
  });

  // Validation per step.
  const step1Valid = adapterKey && clientId && label.trim().length > 0;
  const step3Valid = !needsCreds || shape.credentials.every((f) => (credentials[f.key] ?? "").length > 0);

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

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <button
        onClick={() => setLocation("/load-sources")}
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> К источникам
      </button>

      <div>
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Admin / Источники грузов / Новый
        </p>
        <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Radio className="h-6 w-6 text-primary" /> Новый источник
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
                <Label>Адаптер</Label>
                <Select value={adapterKey} onValueChange={setAdapterKey}>
                  <SelectTrigger>
                    <SelectValue placeholder="Выберите источник" />
                  </SelectTrigger>
                  <SelectContent>
                    {adapters.map((a) => (
                      <SelectItem key={a.key} value={a.key} disabled={!a.implemented}>
                        {a.label}
                        {!a.implemented && " — скоро"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Клиент</Label>
                <ClientCombobox value={clientId} onChange={setClientId} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="label">Название</Label>
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
                  У этого адаптера нет дополнительных настроек.
                </p>
              ) : (
                shape.config.map((f) => (
                  <div key={f.key} className="space-y-1.5">
                    <Label>{f.label}</Label>
                    {f.type === "state" ? (
                      <Select
                        value={config[f.key] ?? ""}
                        onValueChange={(v) => setConfig((c) => ({ ...c, [f.key]: v }))}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Штат" />
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
                        placeholder={f.placeholder}
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
                Доступы шифруются на сервере (AES-256-GCM) и никогда не
                показываются в интерфейсе.
              </p>
              {shape.credentials.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label>{f.label}</Label>
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
                <Label htmlFor="poll">Интервал опроса (минуты)</Label>
                <Input
                  id="poll"
                  type="number"
                  min={1}
                  max={1440}
                  value={pollIntervalMin}
                  onChange={(e) => setPollIntervalMin(e.target.value)}
                />
                <p className="text-[11px] text-muted-foreground">
                  Cron опрашивает источник каждые N минут (1–1440).
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>Статус при создании</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as "active" | "paused")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="paused">На паузе (не опрашивать пока)</SelectItem>
                    <SelectItem value="active">Активен (начать опрос)</SelectItem>
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
          <ArrowLeft className="h-4 w-4" /> Назад
        </Button>
        {isLastStep ? (
          <Button
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending || !step1Valid || !step3Valid}
          >
            {createMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            Создать источник
          </Button>
        ) : (
          <Button
            onClick={goNext}
            disabled={(step === 1 && !step1Valid) || (step === 3 && !step3Valid)}
          >
            Далее <ArrowRight className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

function ClientCombobox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
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
              {isLoading ? "Загрузка..." : "Выберите клиента"}
            </span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="Поиск по имени, MC или ID..." />
          <CommandEmpty>Клиенты не найдены.</CommandEmpty>
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
