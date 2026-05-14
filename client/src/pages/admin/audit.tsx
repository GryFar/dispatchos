import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { History, Search } from "lucide-react";
import { apiJson } from "@/lib/queryClient";
import { formatDateFull, formatRelativeAgo } from "@/lib/format";
import { DataTable, type DataTableColumn } from "@/components/dispatch/DataTable";
import { EmptyState } from "@/components/dispatch/EmptyState";
import { StatusBadge } from "@/components/dispatch/StatusBadge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DensityProvider } from "@/lib/density";

/**
 * Audit log viewer.
 *
 * GET /api/audit — Phase 1 endpoint, currently returns plain array. After Phase 3 P4
 * запросы с параметрами вернут { items, nextCursor, hasMore, total }. Этот компонент
 * корректно обрабатывает оба формата.
 *
 * Filters (eventType, entityType) делаются client-side для legacy формата. После P4
 * они начнут уходить как query params, см. AuditListFilters в admin-api-spec.
 */

type LegacyAuditEvent = {
  id?: string;
  eventType: string;
  entityType?: string;
  entityId?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  payload?: unknown;
  createdAt?: string;
  timestamp?: string;
  ts?: string;
};

type AuditListResponse =
  | LegacyAuditEvent[]
  | { items: LegacyAuditEvent[]; nextCursor: string | null; hasMore: boolean; total: number | null };

export default function AuditPage() {
  const [q, setQ] = useState("");
  const [entityFilter, setEntityFilter] = useState<"all" | string>("all");

  const { data, isLoading, error } = useQuery<AuditListResponse>({
    queryKey: ["/api/audit"],
    queryFn: () => apiJson<AuditListResponse>("GET", "/api/audit"),
    staleTime: 15_000,
  });

  const events = useMemo(() => {
    if (!data) return [];
    const items = Array.isArray(data) ? data : data.items;
    return items.map((e) => ({
      ...e,
      createdAt: e.createdAt ?? e.timestamp ?? e.ts ?? "",
    }));
  }, [data]);

  const entityTypes = useMemo(() => {
    const s = new Set<string>();
    for (const e of events) if (e.entityType) s.add(e.entityType);
    return Array.from(s).sort();
  }, [events]);

  const rows = useMemo(() => {
    let r = events;
    if (q) {
      const needle = q.toLowerCase();
      r = r.filter(
        (e) =>
          e.eventType.toLowerCase().includes(needle) ||
          (e.entityId ?? "").toLowerCase().includes(needle) ||
          (e.actorEmail ?? "").toLowerCase().includes(needle) ||
          JSON.stringify(e.payload ?? "").toLowerCase().includes(needle),
      );
    }
    if (entityFilter !== "all") {
      r = r.filter((e) => e.entityType === entityFilter);
    }
    return r;
  }, [events, q, entityFilter]);

  return (
    <DensityProvider value="compact">
      <div className="space-y-6">
        <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Admin / Audit log
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">Audit log</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Все события системы: создание, обновление, ошибки, login'ы.
            </p>
          </div>
        </header>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Поиск: event, entityId, actor"
              className="pl-9"
            />
          </div>
          <Select value={entityFilter} onValueChange={setEntityFilter}>
            <SelectTrigger className="sm:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все сущности</SelectItem>
              {entityTypes.map((t) => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>Не удалось загрузить audit: {(error as Error).message}</AlertDescription>
          </Alert>
        ) : (
          <AuditTable rows={rows} loading={isLoading} />
        )}

        {events.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Всего: {events.length}
            {(q || entityFilter !== "all") && ` · отфильтровано: ${rows.length}`}
            {Array.isArray(data) && events.length >= 100 && " · показаны последние"}
          </p>
        )}
      </div>
    </DensityProvider>
  );
}

function AuditTable({
  rows,
  loading,
}: {
  rows: (LegacyAuditEvent & { createdAt: string })[];
  loading: boolean;
}) {
  const columns: DataTableColumn<LegacyAuditEvent & { createdAt: string }>[] = [
    {
      key: "when",
      header: "Когда",
      cell: (e) => (
        <span className="text-[10px] text-muted-foreground" title={e.createdAt ? formatDateFull(e.createdAt) : ""}>
          {e.createdAt ? formatRelativeAgo(e.createdAt) : "—"}
        </span>
      ),
      width: "100px",
    },
    {
      key: "event",
      header: "Событие",
      cell: (e) => (
        <span className="font-mono text-[11px]">{e.eventType}</span>
      ),
      width: "200px",
    },
    {
      key: "entity",
      header: "Сущность",
      cell: (e) =>
        e.entityType ? (
          <div className="flex items-center gap-2">
            <StatusBadge variant="info">{e.entityType}</StatusBadge>
            {e.entityId && (
              <span className="truncate font-mono text-[10px] text-muted-foreground">
                {e.entityId}
              </span>
            )}
          </div>
        ) : (
          <span className="text-[10px] text-muted-foreground">—</span>
        ),
      width: "240px",
      hideOnMobile: true,
    },
    {
      key: "actor",
      header: "Actor",
      cell: (e) =>
        e.actorEmail ? (
          <span className="text-[11px]">{e.actorEmail}</span>
        ) : e.actorUserId ? (
          <span className="font-mono text-[10px] text-muted-foreground">{e.actorUserId}</span>
        ) : (
          <span className="text-[10px] text-muted-foreground">система</span>
        ),
      width: "180px",
      hideOnMobile: true,
    },
    {
      key: "payload",
      header: "Payload",
      cell: (e) =>
        e.payload ? (
          <code className="block max-w-md truncate rounded bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {JSON.stringify(e.payload)}
          </code>
        ) : null,
      hideOnMobile: true,
    },
  ];

  return (
    <DataTable
      density="compact"
      columns={columns}
      rows={rows}
      loading={loading}
      rowKey={(e, i) => e.id ?? `${e.createdAt}-${i}`}
      empty={
        <EmptyState
          icon={<History />}
          title="Нет событий"
          description="Audit пуст. Любое действие admin'а пишет событие сюда."
        />
      }
    />
  );
}
