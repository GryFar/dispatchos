import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, FileText, Search } from "lucide-react";
import type { Client, DocumentRecord } from "@shared/schema";
import { apiJson } from "@/lib/queryClient";
import { formatDate, formatDateFull } from "@/lib/format";
import { DataTable, type DataTableColumn } from "@/components/dispatch/DataTable";
import { StatusBadge } from "@/components/dispatch/StatusBadge";
import { EmptyState } from "@/components/dispatch/EmptyState";
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
 * Documents page — архив всех документов (rate con, BOL, POD, COI, W9, etc).
 *
 * GET /api/documents → DocumentRecord[] (live, v1.2.7).
 * Параллельно подгружаем /api/clients чтобы показать имя клиента, а не ID.
 */

const TYPE_LABELS: Record<string, string> = {
  rate_confirmation: "Rate Con",
  bol: "BOL",
  pod: "POD",
  coi: "COI",
  w9: "W9",
  authorization_letter: "Auth Letter",
  other: "Other",
};

const STATUS_VARIANT: Record<string, "active" | "clean" | "verify" | "stop" | "pending" | "info"> = {
  needed: "pending",
  received: "info",
  submitted: "active",
  verified: "clean",
  issue: "stop",
};

const STATUS_LABEL: Record<string, string> = {
  needed: "Нужен",
  received: "Получен",
  submitted: "Отправлен",
  verified: "Проверен",
  issue: "Проблема",
};

export default function DocumentsPage() {
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | string>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | string>("all");

  const docsQuery = useQuery<DocumentRecord[]>({
    queryKey: ["/api/documents"],
    queryFn: () => apiJson<DocumentRecord[]>("GET", "/api/documents"),
    staleTime: 30_000,
  });
  const clientsQuery = useQuery<Client[]>({
    queryKey: ["/api/clients"],
    queryFn: () => apiJson<Client[]>("GET", "/api/clients"),
    staleTime: 60_000,
  });

  const clientMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of clientsQuery.data ?? []) m.set(c.id, c.name);
    return m;
  }, [clientsQuery.data]);

  const rows = useMemo(() => {
    let r = docsQuery.data ?? [];
    if (q) {
      const needle = q.toLowerCase();
      r = r.filter(
        (d) =>
          d.fileName.toLowerCase().includes(needle) ||
          (d.notes ?? "").toLowerCase().includes(needle) ||
          (clientMap.get(d.clientId) ?? "").toLowerCase().includes(needle),
      );
    }
    if (typeFilter !== "all") r = r.filter((d) => d.type === typeFilter);
    if (statusFilter !== "all") r = r.filter((d) => d.status === statusFilter);
    return r;
  }, [docsQuery.data, q, typeFilter, statusFilter, clientMap]);

  return (
    <DensityProvider value="compact">
      <div className="space-y-6">
        <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Admin / Документы
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">Документы</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Архив rate con, BOL, POD, COI, W9 по всем клиентам.
            </p>
          </div>
        </header>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Поиск: файл, клиент, notes"
              className="pl-9"
            />
          </div>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все типы</SelectItem>
              {Object.entries(TYPE_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все статусы</SelectItem>
              {Object.entries(STATUS_LABEL).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {docsQuery.error ? (
          <Alert variant="destructive">
            <AlertDescription>Не удалось загрузить документы: {(docsQuery.error as Error).message}</AlertDescription>
          </Alert>
        ) : (
          <DocumentsTable rows={rows} loading={docsQuery.isLoading} clientMap={clientMap} />
        )}

        {docsQuery.data && (
          <p className="text-xs text-muted-foreground">
            Всего: {docsQuery.data.length}
            {(q || typeFilter !== "all" || statusFilter !== "all") && ` · отфильтровано: ${rows.length}`}
          </p>
        )}
      </div>
    </DensityProvider>
  );
}

function DocumentsTable({
  rows,
  loading,
  clientMap,
}: {
  rows: DocumentRecord[];
  loading: boolean;
  clientMap: Map<string, string>;
}) {
  const columns: DataTableColumn<DocumentRecord>[] = [
    {
      key: "file",
      header: "Файл",
      cell: (d) => (
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="truncate text-xs font-medium">{d.fileName}</p>
            {d.notes && <p className="truncate text-[10px] text-muted-foreground">{d.notes}</p>}
          </div>
        </div>
      ),
    },
    {
      key: "type",
      header: "Тип",
      cell: (d) => <StatusBadge variant="info">{TYPE_LABELS[d.type] ?? d.type}</StatusBadge>,
      width: "120px",
    },
    {
      key: "client",
      header: "Клиент",
      cell: (d) => (
        <span className="text-xs">
          {clientMap.get(d.clientId) ?? d.clientId}
        </span>
      ),
      hideOnMobile: true,
    },
    {
      key: "status",
      header: "Статус",
      cell: (d) => (
        <StatusBadge variant={STATUS_VARIANT[d.status]} dot>
          {STATUS_LABEL[d.status] ?? d.status}
        </StatusBadge>
      ),
      width: "120px",
    },
    {
      key: "created",
      header: "Добавлен",
      cell: (d) => (
        <span className="text-[10px] text-muted-foreground" title={formatDateFull(d.createdAt)}>
          {formatDate(d.createdAt)}
        </span>
      ),
      width: "120px",
      hideOnMobile: true,
    },
    {
      key: "url",
      header: "",
      align: "right",
      cell: (d) =>
        d.storageUrl ? (
          <a
            href={d.storageUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            Открыть
          </a>
        ) : null,
      width: "100px",
      hideOnMobile: true,
    },
  ];

  return (
    <DataTable
      density="compact"
      columns={columns}
      rows={rows}
      loading={loading}
      empty={
        <EmptyState
          icon={<FileText />}
          title="Нет документов"
          description="Загрузите rate con, BOL или POD через legacy-дашборд или прямой API."
        />
      }
    />
  );
}
