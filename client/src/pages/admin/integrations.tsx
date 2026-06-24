import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  ExternalLink,
  Inbox,
  Loader2,
  MessageSquare,
  Plug,
  Settings,
  Sparkles,
  Trash2,
  Wrench,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiJson, ApiError } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/i18n";

type IntegrationKind =
  | "feeder"
  | "enrichment"
  | "messaging"
  | "observability"
  | "infra";

type IntegrationStatus =
  | "ready"
  | "active"
  | "needs_config"
  | "local_endpoint_ready"
  | "local_folder_mode"
  | "sandbox"
  | "error";

interface EnvVarMeta {
  envVar: string;
  label: string;
  type: "secret" | "url" | "text";
  help?: string;
  placeholder?: string;
}

interface EnvVarSource {
  envVar: string;
  source: "db" | "env" | "missing";
}

interface Integration {
  key: string;
  label: string;
  kind: IntegrationKind;
  status: IntegrationStatus;
  missing: string[];
  envVarMeta: EnvVarMeta[];
  envVarSources: EnvVarSource[];
  stats24h: { eventCount: number; lastEventAt: string | null };
  notes?: string;
  docsUrl?: string;
}

interface IntegrationsResponse {
  generatedAt: string;
  integrations: Integration[];
}

type KindMeta = { labelKey: string; icon: typeof Plug };
const KIND_META: Record<IntegrationKind, KindMeta> = {
  feeder: { labelKey: "admin.integrations.kindFeeder", icon: Inbox },
  enrichment: { labelKey: "admin.integrations.kindEnrichment", icon: Sparkles },
  messaging: { labelKey: "admin.integrations.kindMessaging", icon: MessageSquare },
  observability: { labelKey: "admin.integrations.kindObservability", icon: Activity },
  infra: { labelKey: "admin.integrations.kindInfra", icon: Database },
};

type ToneKey = "active" | "ok" | "warn" | "muted" | "danger";
type StatusMeta = { labelKey: string; tone: ToneKey };
const STATUS_META: Record<IntegrationStatus, StatusMeta> = {
  active: { labelKey: "admin.integrations.statusActive", tone: "active" },
  ready: { labelKey: "admin.integrations.statusReady", tone: "ok" },
  needs_config: { labelKey: "admin.integrations.statusNeedsConfig", tone: "warn" },
  local_endpoint_ready: { labelKey: "admin.integrations.statusLocal", tone: "muted" },
  local_folder_mode: { labelKey: "admin.integrations.statusLocal", tone: "muted" },
  sandbox: { labelKey: "admin.integrations.statusSandbox", tone: "muted" },
  error: { labelKey: "admin.integrations.statusError", tone: "danger" },
};

const TONE_CLASS: Record<ToneKey, string> = {
  active: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  ok: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  muted: "bg-muted text-muted-foreground border-border",
  danger: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30",
};

function formatRelative(
  iso: string | null,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const seconds = Math.round(diffMs / 1000);
  if (seconds < 60) return t("admin.integrations.secondsAgo", { seconds });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("admin.integrations.minutesAgo", { minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("admin.integrations.hoursAgo", { hours });
  const days = Math.round(hours / 24);
  return t("admin.integrations.daysAgo", { days });
}

export default function IntegrationsPage() {
  const { t } = useT();
  const { data, isLoading, isError } = useQuery<IntegrationsResponse>({
    queryKey: ["/api/admin/integrations"],
    queryFn: () => apiJson("GET", "/api/admin/integrations"),
    refetchInterval: 30_000,
  });

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          {t("admin.integrations.breadcrumb")}
        </p>
        <h1 className="text-2xl font-semibold">{t("admin.integrations.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("admin.integrations.subtitlePrefix")}{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            server/lib/integrations.ts
          </code>
          .
        </p>
      </header>

      {isLoading && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-xl border border-border bg-muted/40"
            />
          ))}
        </div>
      )}

      {isError && (
        <Card>
          <CardContent className="flex items-center gap-2 py-6 text-sm text-rose-500">
            <AlertTriangle className="h-4 w-4" />
            {t("admin.integrations.loadError")}
          </CardContent>
        </Card>
      )}

      {data && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.integrations.map((item) => (
            <IntegrationCard key={item.key} item={item} />
          ))}
        </div>
      )}

      {data && (
        <p className="text-xs text-muted-foreground">
          {t("admin.integrations.updatedAt", {
            time: new Date(data.generatedAt).toLocaleString("ru-RU"),
          })}
        </p>
      )}
    </div>
  );
}

function IntegrationCard({ item }: { item: Integration }) {
  const { t } = useT();
  const kindMeta = KIND_META[item.kind];
  const statusMeta = STATUS_META[item.status];
  const KindIcon = kindMeta.icon;
  const [setupOpen, setSetupOpen] = useState(false);

  return (
    <Card className="flex flex-col">
      <CardHeader className="space-y-2 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2">
            <div className="rounded-md bg-muted p-2">
              <KindIcon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base leading-tight">
                {item.label}
              </CardTitle>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t(kindMeta.labelKey)}
              </p>
            </div>
          </div>
          <Badge
            variant="outline"
            className={TONE_CLASS[statusMeta.tone]}
          >
            {t(statusMeta.labelKey)}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3 pt-0">
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Activity className="h-3 w-3" />
            {t("admin.integrations.events24h", { count: item.stats24h.eventCount })}
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatRelative(item.stats24h.lastEventAt, t)}
          </span>
        </div>

        {item.missing.length > 0 && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
            <p className="mb-1 inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-300">
              <Wrench className="h-3 w-3" />
              {t("admin.integrations.notConfigured")}
            </p>
            <p className="font-mono text-[11px] text-muted-foreground">
              {item.missing.join(", ")}
            </p>
          </div>
        )}

        {item.status === "active" && item.missing.length === 0 && (
          <div className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3 w-3" />
            {t("admin.integrations.working")}
          </div>
        )}

        {item.notes && (
          <p className="text-xs text-muted-foreground">{item.notes}</p>
        )}

        {item.envVarMeta.length > 0 && (
          <div className="mt-1 flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setSetupOpen(true)}>
              <Settings className="h-3.5 w-3.5" />
              {t("admin.integrations.configure")}
            </Button>
            {item.docsUrl && (
              <a
                href={item.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ExternalLink className="h-3 w-3" />
                {t("admin.integrations.docs")}
              </a>
            )}
          </div>
        )}
      </CardContent>
      {setupOpen && (
        <IntegrationSetupDialog item={item} onClose={() => setSetupOpen(false)} />
      )}
    </Card>
  );
}

// ===========================================================================
// IntegrationSetupDialog — форма ввода secrets, хранится в integration_configs
// ===========================================================================

function IntegrationSetupDialog({
  item,
  onClose,
}: {
  item: Integration;
  onClose: () => void;
}) {
  const { t } = useT();
  const { toast } = useToast();
  const qc = useQueryClient();
  // For each env var: empty string = no change. Empty after edit + explicit Очистить = clear.
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(item.envVarMeta.map((m) => [m.envVar, ""])),
  );

  const setMutation = useMutation({
    mutationFn: () =>
      apiJson("POST", `/api/admin/integrations/${item.key}/config`, { values }),
    onSuccess: () => {
      toast({ description: t("admin.integrations.savedToast", { label: item.label }) });
      qc.invalidateQueries({ queryKey: ["/api/admin/integrations"] });
      onClose();
    },
    onError: (err: Error) => {
      const msg = err instanceof ApiError ? err.message : t("admin.integrations.saveError");
      toast({ variant: "destructive", description: msg });
    },
  });

  const clearMutation = useMutation({
    mutationFn: () =>
      apiJson("DELETE", `/api/admin/integrations/${item.key}/config`),
    onSuccess: () => {
      toast({ description: t("admin.integrations.clearedToast", { label: item.label }) });
      qc.invalidateQueries({ queryKey: ["/api/admin/integrations"] });
      onClose();
    },
    onError: (err: Error) => {
      const msg = err instanceof ApiError ? err.message : t("admin.integrations.clearError");
      toast({ variant: "destructive", description: msg });
    },
  });

  // Has at least one non-empty value to submit?
  const hasChanges = Object.values(values).some((v) => v.trim().length > 0);
  const hasAnyDbValue = item.envVarSources.some((s) => s.source === "db");

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("admin.integrations.setupTitle", { label: item.label })}</DialogTitle>
          <DialogDescription>
            {t("admin.integrations.setupDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {item.envVarMeta.map((meta) => {
            const src = item.envVarSources.find((s) => s.envVar === meta.envVar);
            const sourceLabel =
              src?.source === "db"
                ? t("admin.integrations.sourceDb")
                : src?.source === "env"
                  ? t("admin.integrations.sourceEnv")
                  : t("admin.integrations.sourceMissing");
            const sourceTone =
              src?.source === "db"
                ? "text-emerald-600 dark:text-emerald-400"
                : src?.source === "env"
                  ? "text-sky-600 dark:text-sky-400"
                  : "text-amber-600 dark:text-amber-400";
            return (
              <div key={meta.envVar} className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={meta.envVar} className="text-xs">
                    {meta.label}
                    <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                      {meta.envVar}
                    </span>
                  </Label>
                  <span className={`text-[10px] ${sourceTone}`}>{sourceLabel}</span>
                </div>
                <Input
                  id={meta.envVar}
                  type={meta.type === "secret" ? "password" : meta.type === "url" ? "url" : "text"}
                  placeholder={meta.placeholder ?? (src?.source !== "missing" ? t("admin.integrations.keepBlankPlaceholder") : "")}
                  value={values[meta.envVar]}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [meta.envVar]: e.target.value }))
                  }
                  className="font-mono text-xs"
                />
                {meta.help && (
                  <p className="text-[10px] text-muted-foreground">{meta.help}</p>
                )}
              </div>
            );
          })}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          {hasAnyDbValue && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => clearMutation.mutate()}
              disabled={clearMutation.isPending}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("admin.integrations.clearAll")}
            </Button>
          )}
          <div className="flex gap-2 sm:ml-auto">
            <Button variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => setMutation.mutate()}
              disabled={!hasChanges || setMutation.isPending}
            >
              {setMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("common.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}