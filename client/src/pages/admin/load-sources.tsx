import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Loader2, Plus, Radio, AlertCircle } from "lucide-react";
import type { Client } from "@shared/schema";
import { apiJson } from "@/lib/queryClient";
import { useT } from "@/lib/i18n";
import { formatDateFull } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DataTable, type DataTableColumn } from "@/components/dispatch/DataTable";
import { StatusBadge } from "@/components/dispatch/StatusBadge";
import { EmptyState } from "@/components/dispatch/EmptyState";
import { EndpointPending, isEndpointMissing } from "@/components/dispatch/EndpointPending";

/**
 * /admin/load-sources — Phase 6 load source management.
 *
 * Lists configured polling sources (mock / Sylectus / SuperDispatch / ...).
 * Backend: GET /api/admin/load-sources (server/routes/admin-load-sources.ts).
 * Credentials are never sent to the UI — rows carry `hasCredentials: boolean`.
 *
 * Этап 1: list + table. Wizard (create) and detail land in later steps.
 */

// load_sources types are not in shared/schema.ts (backend keeps them in
// server/lib/adapters/types.ts), so we mirror the redacted shape here.
export type LoadSourceStatus = "active" | "paused" | "error" | "needs_credentials";

export interface LoadSource {
  id: string;
  clientId: string;
  adapterKey: string;
  label: string;
  status: LoadSourceStatus;
  configJson: Record<string, unknown>;
  hasCredentials: boolean;
  pollIntervalMin: number;
  lastPolledAt: string | null;
  lastLoadsFound: number;
  lastErrorAt: string | null;
  lastErrorMsg: string | null;
  failureStreak: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

export interface AdapterMeta {
  key: string;
  label: string;
  requiresCredentials: boolean;
  implemented: boolean;
}

const STATUS_LABEL_KEY: Record<LoadSourceStatus, string> = {
  active: "admin.loadSources.statusActive",
  paused: "admin.loadSources.statusPaused",
  error: "admin.loadSources.statusError",
  needs_credentials: "admin.loadSources.statusNeedsCredentials",
};

// Map our status to a real StatusBadge variant (see StatusBadge.tsx — it has
// no warning/danger/neutral; the closest existing variants are used).
//   active           -> active  (green)
//   paused           -> info    (neutral slate)
//   error            -> blocked (red)
//   needs_credentials-> pending (amber)
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

export default function LoadSourcesPage() {
  const { t } = useT();
  const [, setLocation] = useLocation();

  const { data, isLoading, error } = useQuery<{ loadSources: LoadSource[] }>({
    queryKey: ["/api/admin/load-sources"],
    queryFn: () => apiJson("GET", "/api/admin/load-sources"),
  });

  // Adapter metadata — label lookup + (later) wizard dropdown.
  const { data: adapterData } = useQuery<{ adapters: AdapterMeta[] }>({
    queryKey: ["/api/admin/load-sources/adapters"],
    queryFn: () => apiJson("GET", "/api/admin/load-sources/adapters"),
    staleTime: 5 * 60_000,
  });

  // Client name lookup so the table shows "Ivan K." not "ivan-enclosed-01".
  const { data: clients = [] } = useQuery<Client[]>({
    queryKey: ["/api/clients"],
    queryFn: () => apiJson("GET", "/api/clients"),
    staleTime: 60_000,
  });

  const adapterLabel = useMemo(() => {
    const m = new Map<string, string>();
    (adapterData?.adapters ?? []).forEach((a) => m.set(a.key, a.label));
    return m;
  }, [adapterData]);

  const clientName = useMemo(() => {
    const m = new Map<string, string>();
    clients.forEach((c) => m.set(c.id, c.name));
    return m;
  }, [clients]);

  const sources = data?.loadSources ?? [];

  // The load-sources endpoint may not be mounted yet (Vite SPA fallback returns
  // the HTML shell) — show the sibling "endpoint pending" panel, matching
  // /admin/users behaviour, rather than a misleading empty state.
  if (isEndpointMissing(error)) {
    return <EndpointPending endpoint="GET /api/admin/load-sources" />;
  }

  const columns: DataTableColumn<LoadSource>[] = [
    {
      key: "label",
      header: t("admin.loadSources.colName"),
      cell: (s) => (
        <div className="flex flex-col">
          <span className="font-medium">{s.label}</span>
          <span className="text-[11px] text-muted-foreground">
            {adapterLabel.get(s.adapterKey) ?? s.adapterKey}
          </span>
        </div>
      ),
    },
    {
      key: "client",
      header: t("admin.loadSources.colClient"),
      cell: (s) => clientName.get(s.clientId) ?? <span className="text-muted-foreground">{s.clientId}</span>,
    },
    {
      key: "status",
      header: t("admin.loadSources.colStatus"),
      cell: (s) => (
        <div className="flex items-center gap-1.5">
          <StatusBadge variant={statusVariant(s.status)}>{t(STATUS_LABEL_KEY[s.status])}</StatusBadge>
          {s.status === "error" && s.lastErrorMsg && (
            <span title={s.lastErrorMsg}>
              <AlertCircle className="h-3.5 w-3.5 text-destructive" />
            </span>
          )}
        </div>
      ),
    },
    {
      key: "poll",
      header: t("admin.loadSources.colInterval"),
      align: "right",
      mono: true,
      hideOnMobile: true,
      cell: (s) => t("admin.loadSources.intervalMin", { min: s.pollIntervalMin }),
    },
    {
      key: "lastPolled",
      header: t("admin.loadSources.colLastPolled"),
      hideOnMobile: true,
      cell: (s) =>
        s.lastPolledAt ? (
          <div className="flex flex-col">
            <span className="text-xs">{formatDateFull(s.lastPolledAt)}</span>
            <span className="text-[11px] text-muted-foreground">
              {t("admin.loadSources.found", { count: s.lastLoadsFound })}
            </span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("admin.loadSources.eyebrow")}
          </p>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Radio className="h-6 w-6 text-primary" />
            {t("admin.loadSources.title")}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {t("admin.loadSources.subtitle")}
          </p>
        </div>
        <Button onClick={() => setLocation("/load-sources/new")}>
          <Plus className="h-4 w-4" />
          {t("admin.loadSources.addSource")}
        </Button>
      </div>

      {isLoading ? (
        <Card className="flex h-32 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </Card>
      ) : error ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {t("admin.loadSources.loadFailed", { message: (error as Error).message })}
          </AlertDescription>
        </Alert>
      ) : sources.length === 0 ? (
        <Card className="p-2">
          <EmptyState
            icon={<Radio className="h-6 w-6" />}
            title={t("admin.loadSources.emptyTitle")}
            description={t("admin.loadSources.emptyDescription")}
          />
        </Card>
      ) : (
        <DataTable
          columns={columns}
          rows={sources}
          onRowClick={(s) => setLocation(`/load-sources/${s.id}`)}
        />
      )}
    </div>
  );
}
