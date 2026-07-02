import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  DollarSign,
  History,
  Package,
  TrendingUp,
  Users as UsersIcon,
  XCircle,
} from "lucide-react";
import type { DashboardStats } from "@shared/schema";
import { apiJson } from "@/lib/queryClient";
import { formatDateFull, formatMoney, formatRelativeAgo } from "@/lib/format";
import { KpiCard } from "@/components/dispatch/KpiCard";
import { EndpointPending, isEndpointMissing } from "@/components/dispatch/EndpointPending";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/**
 * Admin Dashboard.
 *
 * Top: 4 KPI cards (MRR, Users, Loads, Audit).
 * Bottom-left: integration health checklist.
 * Bottom-right: system info (version, uptime, db size).
 *
 * Endpoint `/api/admin/dashboard/stats` — Phase 3 (P3 priority).
 * Until then, the page shows <EndpointPending> for the KPI section, but the
 * page is structurally complete — ИИ-бэкендеру достаточно реализовать endpoint
 * по spec.
 */
export default function DashboardPage() {
  const { t } = useT();
  const { data, isLoading, error } = useQuery<DashboardStats>({
    queryKey: ["/api/admin/dashboard/stats"],
    queryFn: () => apiJson<DashboardStats>("GET", "/api/admin/dashboard/stats"),
    staleTime: 60_000,
  });

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("admin.dashboard.breadcrumb")}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("admin.dashboard.title")}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {t("admin.dashboard.subtitle")}
          </p>
        </div>
      </header>

      {/* KPI grid */}
      {isLoading ? (
        <KpiGridSkeleton />
      ) : isEndpointMissing(error) ? (
        <EndpointPending
          endpoint="GET /api/admin/dashboard/stats"
          description={t("admin.dashboard.endpointPending")}
        />
      ) : error ? (
        <Alert variant="destructive">
          <AlertDescription>
            {t("admin.dashboard.loadError", { message: (error as Error).message })}
          </AlertDescription>
        </Alert>
      ) : data ? (
        <KpiGrid data={data} />
      ) : null}

      {/* Two-column bottom: integrations + system */}
      {data && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2 shadow-card">
            <CardContent className="p-5">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-sm font-semibold">{t("admin.dashboard.integrations")}</h2>
                <p className="text-xs text-muted-foreground">
                  {t("admin.dashboard.updatedLabel")}: {data.audit.lastEventAt ? formatRelativeAgo(data.audit.lastEventAt) : "—"}
                </p>
              </div>
              <ul className="space-y-2">
                {Object.entries(data.integrations).map(([name, h]) => (
                  <li
                    key={name}
                    className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/20 px-3 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <IntegrationStatusIcon status={h.status} />
                      <div className="min-w-0">
                        <p className="text-sm font-medium capitalize">{name}</p>
                        {h.message && (
                          <p className="truncate text-xs text-muted-foreground">{h.message}</p>
                        )}
                      </div>
                    </div>
                    <span
                      className={cn(
                        "text-xs font-medium uppercase tracking-wider",
                        h.status === "ok" && "text-success",
                        h.status === "warn" && "text-warning",
                        h.status === "missing" && "text-muted-foreground",
                        h.status === "error" && "text-destructive",
                      )}
                    >
                      {h.status === "ok" ? t("admin.dashboard.statusOk")
                        : h.status === "warn" ? t("admin.dashboard.statusWarn")
                        : h.status === "missing" ? t("admin.dashboard.statusMissing")
                        : t("common.error")}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card className="shadow-card">
            <CardContent className="p-5">
              <h2 className="mb-4 text-sm font-semibold">{t("admin.dashboard.system")}</h2>
              <dl className="space-y-3 text-sm">
                <SystemRow label={t("admin.dashboard.version")} value={<span className="font-mono">{data.system.version}</span>} />
                <SystemRow label={t("admin.dashboard.uptime")} value={<span className="font-mono">{formatUptime(data.system.uptimeSeconds)}</span>} />
                <SystemRow
                  label={t("admin.dashboard.dbSize")}
                  value={
                    <span className="font-mono">
                      {data.system.dbSizeBytes != null
                        ? formatBytes(data.system.dbSizeBytes)
                        : "—"}
                    </span>
                  }
                />
                <SystemRow
                  label={t("admin.dashboard.lastEvent")}
                  value={
                    <span title={data.audit.lastEventAt ? formatDateFull(data.audit.lastEventAt) : undefined}>
                      {data.audit.lastEventAt ? formatRelativeAgo(data.audit.lastEventAt) : "—"}
                    </span>
                  }
                />
              </dl>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function KpiGrid({ data }: { data: DashboardStats }) {
  const { t } = useT();
  const usersTotal = data.users.admins + data.users.dispatchers + data.users.drivers;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <KpiCard
        label={t("admin.dashboard.kpiMrr")}
        numericValue={data.mrr.currentUsd}
        formatNumeric={formatMoney}
        value={formatMoney(data.mrr.currentUsd)}
        helper={t("admin.dashboard.kpiMrrHelper", { count: data.mrr.activeClients })}
        icon={<DollarSign className="h-5 w-5" />}
        accent="primary"
        trend={data.mrr.trend
          ? {
              direction: data.mrr.trend.direction,
              value: `${data.mrr.trend.direction === "up" ? "+" : data.mrr.trend.direction === "down" ? "−" : ""}${Math.abs(data.mrr.trend.percent).toFixed(1)}%`,
            }
          : undefined}
      />
      <KpiCard
        label={t("admin.dashboard.kpiUsers")}
        numericValue={usersTotal}
        value={usersTotal}
        helper={`${data.users.admins} admin / ${data.users.dispatchers} disp / ${data.users.drivers} driv`}
        icon={<UsersIcon className="h-5 w-5" />}
        accent="chart-2"
      />
      <KpiCard
        label={t("admin.dashboard.kpiLoads")}
        numericValue={data.loads.weekCount}
        value={data.loads.weekCount}
        helper={`${formatMoney(data.loads.weekGrossUsd)} gross`}
        icon={<Package className="h-5 w-5" />}
        accent="primary"
      />
      <KpiCard
        label={t("admin.dashboard.kpiEvents")}
        numericValue={data.audit.eventsLast24h}
        value={data.audit.eventsLast24h}
        helper={
          data.audit.errorEventsLast24h > 0
            ? t("admin.dashboard.kpiEventsErrors", { count: data.audit.errorEventsLast24h })
            : t("admin.dashboard.kpiEventsNoErrors")
        }
        icon={<History className="h-5 w-5" />}
        accent={data.audit.errorEventsLast24h > 0 ? "warning" : "muted"}
      />
    </div>
  );
}

function KpiGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="rounded-lg border border-border bg-card p-5 shadow-card">
          <div className="h-3 w-16 animate-skeleton" />
          <div className="mt-4 h-7 w-24 animate-skeleton" />
          <div className="mt-3 h-3 w-20 animate-skeleton" />
        </div>
      ))}
    </div>
  );
}

function IntegrationStatusIcon({ status }: { status: "ok" | "warn" | "missing" | "error" }) {
  if (status === "ok") return <CheckCircle2 className="h-4 w-4 text-success" />;
  if (status === "warn") return <AlertCircle className="h-4 w-4 text-warning" />;
  if (status === "error") return <XCircle className="h-4 w-4 text-destructive" />;
  return <CircleDashed className="h-4 w-4 text-muted-foreground" />;
}

function SystemRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return `${days}d ${hours}h`;
}

// Workaround for unused imports in dev — keep them imported so this file compiles
// even before all features wired (Activity, TrendingUp are exported for re-use).
void Activity;
void TrendingUp;
