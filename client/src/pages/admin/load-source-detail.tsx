import { useEffect, useMemo, useState } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  KeyRound,
  Loader2,
  PlayCircle,
  Radio,
  Save,
  Trash2,
  XCircle,
} from "lucide-react";
import type { Client } from "@shared/schema";
import { apiJson, ApiError } from "@/lib/queryClient";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/dispatch/StatusBadge";
import { formatDateFull } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { AdapterMeta, LoadSource, LoadSourceStatus } from "./load-sources";

/**
 * /admin/load-sources/:id — detail + edit + test + rotate credentials + delete.
 *
 * Backend: GET/PATCH/DELETE /api/admin/load-sources/:id, POST /:id/test
 * (server/routes/admin-load-sources.ts).
 */

const STATUS_LABEL_KEY: Record<LoadSourceStatus, string> = {
  active: "admin.loadSourceDetail.statusActive",
  paused: "admin.loadSourceDetail.statusPaused",
  error: "admin.loadSourceDetail.statusError",
  needs_credentials: "admin.loadSourceDetail.statusNeedsCredentials",
};
function statusVariant(s: LoadSourceStatus): "active" | "info" | "blocked" | "pending" {
  switch (s) {
    case "active":
      return "active";
    case "paused":
      return "info";
    case "error":
      return "blocked";
    case "needs_credentials":
      return "pending";
  }
}

type TestResult = { ok: boolean; latencyMs: number; sample?: unknown; error?: string };

export default function LoadSourceDetailPage() {
  const { t } = useT();
  const [match, params] = useRoute("/load-sources/:id");
  const id = match ? params?.id : null;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery<{ loadSource: LoadSource }>({
    queryKey: ["/api/admin/load-sources", id],
    queryFn: () => apiJson("GET", `/api/admin/load-sources/${id}`),
    enabled: Boolean(id),
  });
  const source = data?.loadSource;

  const { data: adapterData } = useQuery<{ adapters: AdapterMeta[] }>({
    queryKey: ["/api/admin/load-sources/adapters"],
    queryFn: () => apiJson("GET", "/api/admin/load-sources/adapters"),
    staleTime: 5 * 60_000,
  });
  const adapterMeta = adapterData?.adapters.find((a) => a.key === source?.adapterKey);

  const { data: clients = [] } = useQuery<Client[]>({
    queryKey: ["/api/clients"],
    queryFn: () => apiJson("GET", "/api/clients"),
    staleTime: 60_000,
  });
  const clientName = useMemo(
    () => clients.find((c) => c.id === source?.clientId)?.name ?? "—",
    [clients, source],
  );

  // Editable form
  const [label, setLabel] = useState("");
  const [status, setStatus] = useState<LoadSourceStatus>("paused");
  const [pollIntervalMin, setPollIntervalMin] = useState("15");
  useEffect(() => {
    if (source) {
      setLabel(source.label);
      setStatus(source.status);
      setPollIntervalMin(String(source.pollIntervalMin));
    }
  }, [source]);

  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const saveMutation = useMutation({
    mutationFn: () =>
      apiJson("PATCH", `/api/admin/load-sources/${id}`, {
        label,
        status,
        pollIntervalMin: Math.min(1440, Math.max(1, Math.round(Number(pollIntervalMin)) || 15)),
      }),
    onSuccess: () => {
      toast({ title: t("admin.loadSourceDetail.saved") });
      qc.invalidateQueries({ queryKey: ["/api/admin/load-sources"], exact: false });
    },
    onError: (err: Error) =>
      toast({ title: t("admin.loadSourceDetail.saveFailed"), description: err.message, variant: "destructive" }),
  });

  const testMutation = useMutation({
    mutationFn: () => apiJson<TestResult>("POST", `/api/admin/load-sources/${id}/test`),
    onSuccess: (res) => {
      setTestResult(res);
      qc.invalidateQueries({ queryKey: ["/api/admin/load-sources"], exact: false });
    },
    onError: (err: Error) =>
      toast({ title: t("admin.loadSourceDetail.testFailed"), description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiJson("DELETE", `/api/admin/load-sources/${id}`),
    onSuccess: () => {
      toast({ title: t("admin.loadSourceDetail.sourceStopped"), description: t("admin.loadSourceDetail.statusSetToPaused") });
      qc.invalidateQueries({ queryKey: ["/api/admin/load-sources"], exact: false });
      setLocation("/load-sources");
    },
    onError: (err: Error) => {
      toast({ title: t("admin.loadSourceDetail.failed"), description: err.message, variant: "destructive" });
      setDeleteOpen(false);
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <BackBar onClick={() => setLocation("/load-sources")} />
        <Card className="flex h-32 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </Card>
      </div>
    );
  }
  if (error || !source) {
    const is404 = error instanceof ApiError && error.status === 404;
    return (
      <div className="space-y-4">
        <BackBar onClick={() => setLocation("/load-sources")} />
        <Card className="border-destructive/40 bg-destructive/5 p-4 text-sm">
          {is404 ? t("admin.loadSourceDetail.notFound") : t("admin.loadSourceDetail.loadFailed")}
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-20">
      <BackBar onClick={() => setLocation("/load-sources")} />

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("admin.loadSourceDetail.breadcrumb", { source: adapterMeta?.label ?? source.adapterKey })}
          </p>
          <h1 className="mt-1 flex items-center gap-2 truncate text-2xl font-semibold tracking-tight">
            <Radio className="h-6 w-6 shrink-0 text-primary" /> {source.label}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("admin.loadSourceDetail.client", { name: clientName })}</p>
        </div>
        <StatusBadge variant={statusVariant(source.status)}>{t(STATUS_LABEL_KEY[source.status])}</StatusBadge>
      </div>

      {source.status === "error" && source.lastErrorMsg && (
        <Card className="border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="flex items-center gap-2 font-medium text-destructive">
            <AlertTriangle className="h-4 w-4" /> {t("admin.loadSourceDetail.lastError")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{source.lastErrorMsg}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("admin.loadSourceDetail.failureStreak", { count: source.failureStreak })}
          </p>
        </Card>
      )}

      {/* Settings */}
      <Card>
        <CardHeader>
          <CardTitle>{t("admin.loadSourceDetail.settings")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="label">{t("admin.loadSourceDetail.name")}</Label>
            <Input id="label" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("admin.loadSourceDetail.statusLabel")}</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as LoadSourceStatus)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["active", "paused", "error", "needs_credentials"] as LoadSourceStatus[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(STATUS_LABEL_KEY[s])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="poll">{t("admin.loadSourceDetail.intervalMin")}</Label>
              <Input
                id="poll"
                type="number"
                min={1}
                max={1440}
                value={pollIntervalMin}
                onChange={(e) => setPollIntervalMin(e.target.value)}
              />
            </div>
          </div>

          {/* Config (read-only view of stored configJson) */}
          {Object.keys(source.configJson ?? {}).length > 0 && (
            <div className="space-y-1.5">
              <Label>{t("admin.loadSourceDetail.configuration")}</Label>
              <pre className="overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs">
                {JSON.stringify(source.configJson, null, 2)}
              </pre>
            </div>
          )}

          <div className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
            <span className="text-muted-foreground">
              {t("admin.loadSourceDetail.credentials")}:{" "}
              {source.hasCredentials ? (
                <Badge variant="outline" className="border-emerald-500/40 text-emerald-600">
                  {t("admin.loadSourceDetail.credentialsConfigured")}
                </Badge>
              ) : adapterMeta?.requiresCredentials ? (
                <Badge variant="outline" className="border-amber-500/40 text-amber-600">
                  {t("admin.loadSourceDetail.credentialsNotSet")}
                </Badge>
              ) : (
                <span>{t("admin.loadSourceDetail.credentialsNotRequired")}</span>
              )}
            </span>
            {adapterMeta?.requiresCredentials && (
              <RotateCredentialsButton
                sourceId={source.id}
                adapterKey={source.adapterKey}
                onDone={() => qc.invalidateQueries({ queryKey: ["/api/admin/load-sources"], exact: false })}
              />
            )}
          </div>

          <div className="flex justify-end">
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {t("common.save")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Test */}
      <Card>
        <CardHeader>
          <CardTitle>{t("admin.loadSourceDetail.connectionCheck")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t("admin.loadSourceDetail.connectionCheckDesc")}
            </p>
            <Button
              variant="outline"
              onClick={() => testMutation.mutate()}
              disabled={testMutation.isPending}
            >
              {testMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <PlayCircle className="h-4 w-4" />
              )}
              {t("admin.loadSourceDetail.test")}
            </Button>
          </div>

          {testResult && (
            <div
              className={`rounded-md border p-3 text-sm ${
                testResult.ok
                  ? "border-emerald-500/40 bg-emerald-500/5"
                  : "border-destructive/40 bg-destructive/5"
              }`}
            >
              <p className="flex items-center gap-2 font-medium">
                {testResult.ok ? (
                  <>
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" /> {t("admin.loadSourceDetail.testSuccess")}
                  </>
                ) : (
                  <>
                    <XCircle className="h-4 w-4 text-destructive" /> {t("common.error")}
                  </>
                )}
                <span className="ml-auto text-xs text-muted-foreground">{t("admin.loadSourceDetail.latencyMs", { ms: testResult.latencyMs })}</span>
              </p>
              {testResult.error && (
                <p className="mt-1 text-xs text-muted-foreground">{testResult.error}</p>
              )}
              {testResult.ok && testResult.sample != null && (
                <pre className="mt-2 max-h-48 overflow-auto rounded border border-border bg-background/60 p-2 text-[11px]">
                  {JSON.stringify(testResult.sample, null, 2)}
                </pre>
              )}
              {testResult.ok && testResult.sample == null && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("admin.loadSourceDetail.connectionOkNoLoads")}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Last poll info */}
      <Card>
        <CardHeader>
          <CardTitle>{t("admin.loadSourceDetail.activity")}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>
            {t("admin.loadSourceDetail.lastPoll")}:{" "}
            {source.lastPolledAt ? formatDateFull(source.lastPolledAt) : t("admin.loadSourceDetail.neverPolled")}
          </p>
          {source.lastPolledAt && <p>{t("admin.loadSourceDetail.lastLoadsFound", { count: source.lastLoadsFound })}</p>}
          <p className="mt-1 text-[11px]">{t("admin.loadSourceDetail.createdAt", { date: formatDateFull(source.createdAt) })}</p>
        </CardContent>
      </Card>

      {/* Danger zone */}
      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="text-destructive">{t("admin.loadSourceDetail.dangerZone")}</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {t("admin.loadSourceDetail.dangerZoneDesc")}
          </p>
          <Button
            variant="outline"
            className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4" /> {t("admin.loadSourceDetail.stop")}
          </Button>
        </CardContent>
      </Card>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" /> {t("admin.loadSourceDetail.stopSourceQuestion")}
            </DialogTitle>
            <DialogDescription>
              {t("admin.loadSourceDetail.stopSourceDesc", { label: source.label })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleteMutation.isPending}>
              {t("common.cancel")}
            </Button>
            <Button
              className="border-destructive/40 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {t("admin.loadSourceDetail.stop")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BackBar({ onClick }: { onClick: () => void }) {
  const { t } = useT();
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" /> {t("admin.loadSourceDetail.backToSources")}
    </button>
  );
}

// Credentials shapes per adapter (mirror of the wizard's ADAPTER_SHAPES creds).
const CRED_FIELDS: Record<string, { key: string; label: string }[]> = {
  super_dispatch: [
    { key: "username", label: "Username" },
    { key: "password", label: "Password" },
  ],
  one23_loadboard: [{ key: "apiKey", label: "API Key" }],
  dat_scraper: [
    { key: "username", label: "Username" },
    { key: "password", label: "Password" },
  ],
  chr_navisphere: [
    { key: "clientId", label: "Client ID" },
    { key: "clientSecret", label: "Client Secret" },
  ],
};

function RotateCredentialsButton({
  sourceId,
  adapterKey,
  onDone,
}: {
  sourceId: string;
  adapterKey: string;
  onDone: () => void;
}) {
  const { t } = useT();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [creds, setCreds] = useState<Record<string, string>>({});
  const fields = CRED_FIELDS[adapterKey] ?? [];

  const mutation = useMutation({
    mutationFn: () =>
      apiJson("PATCH", `/api/admin/load-sources/${sourceId}`, { credentials: creds }),
    onSuccess: () => {
      toast({ title: t("admin.loadSourceDetail.credentialsUpdated") });
      setOpen(false);
      setCreds({});
      onDone();
    },
    onError: (err: Error) => {
      const msg =
        err instanceof ApiError && err.status === 503
          ? t("admin.loadSourceDetail.encryptionKeyMissing")
          : err.message;
      toast({ title: t("admin.loadSourceDetail.failed"), description: msg, variant: "destructive" });
    },
  });

  const valid = fields.every((f) => (creds[f.key] ?? "").length > 0);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <KeyRound className="h-4 w-4" /> {t("admin.loadSourceDetail.updateCredentials")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("admin.loadSourceDetail.updateCredentials")}</DialogTitle>
            <DialogDescription>
              {t("admin.loadSourceDetail.updateCredentialsDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {fields.map((f) => (
              <div key={f.key} className="space-y-1.5">
                <Label>{f.label}</Label>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={creds[f.key] ?? ""}
                  onChange={(e) => setCreds((c) => ({ ...c, [f.key]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={mutation.isPending}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => mutation.mutate()} disabled={!valid || mutation.isPending}>
              {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
