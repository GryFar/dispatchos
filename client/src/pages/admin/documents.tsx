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
import { useT } from "@/lib/i18n";

/**
 * Documents page — архив всех документов (rate con, BOL, POD, COI, W9, etc).
 *
 * GET /api/documents → DocumentRecord[] (live, v1.2.7).
 * Параллельно подгружаем /api/clients чтобы показать имя клиента, а не ID.
 */

// storageUrl is free-form operator input. Only render it as a link when it is
// a real http(s) URL — otherwise a stored value like `javascript:...` would
// execute in the admin's session when the "Открыть" link is clicked (stored XSS).
function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw, window.location.origin);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

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

const STATUS_KEYS = ["needed", "received", "submitted", "verified", "issue"] as const;

const STATUS_LABEL_KEY: Record<string, string> = {
  needed: "admin.documents.statusNeeded",
  received: "admin.documents.statusReceived",
  submitted: "admin.documents.statusSubmitted",
  verified: "admin.documents.statusVerified",
  issue: "admin.documents.statusIssue",
};

export default function DocumentsPage() {
  const { t } = useT();
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
              {t("admin.documents.eyebrow")}
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("admin.documents.title")}</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {t("admin.documents.subtitle")}
            </p>
          </div>
        </header>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("admin.documents.searchPlaceholder")}
              className="pl-9"
            />
          </div>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("admin.documents.allTypes")}</SelectItem>
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
              <SelectItem value="all">{t("admin.documents.allStatuses")}</SelectItem>
              {STATUS_KEYS.map((k) => (
                <SelectItem key={k} value={k}>{t(STATUS_LABEL_KEY[k])}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {docsQuery.error ? (
          <Alert variant="destructive">
            <AlertDescription>{t("admin.documents.loadError", { message: (docsQuery.error as Error).message })}</AlertDescription>
          </Alert>
        ) : (
          <DocumentsTable rows={rows} loading={docsQuery.isLoading} clientMap={clientMap} />
        )}

        {docsQuery.data && (
          <p className="text-xs text-muted-foreground">
            {t("admin.documents.total", { count: docsQuery.data.length })}
            {(q || typeFilter !== "all" || statusFilter !== "all") && t("admin.documents.filtered", { count: rows.length })}
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
  const { t } = useT();
  const columns: DataTableColumn<DocumentRecord>[] = [
    {
      key: "file",
      header: t("admin.documents.colFile"),
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
      header: t("admin.documents.colType"),
      cell: (d) => <StatusBadge variant="info">{TYPE_LABELS[d.type] ?? d.type}</StatusBadge>,
      width: "120px",
    },
    {
      key: "client",
      header: t("admin.documents.colClient"),
      cell: (d) => (
        <span className="text-xs">
          {clientMap.get(d.clientId) ?? d.clientId}
        </span>
      ),
      hideOnMobile: true,
    },
    {
      key: "status",
      header: t("admin.documents.colStatus"),
      cell: (d) => (
        <StatusBadge variant={STATUS_VARIANT[d.status]} dot>
          {STATUS_LABEL_KEY[d.status] ? t(STATUS_LABEL_KEY[d.status]) : d.status}
        </StatusBadge>
      ),
      width: "120px",
    },
    {
      key: "created",
      header: t("admin.documents.colCreated"),
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
      cell: (d) => {
        const href = safeHttpUrl(d.storageUrl);
        return href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            {t("admin.documents.open")}
          </a>
        ) : null;
      },
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
          title={t("admin.documents.emptyTitle")}
          description={t("admin.documents.emptyDescription")}
        />
      }
    />
  );
}
