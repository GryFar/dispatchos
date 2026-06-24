import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Package, Search, Truck } from "lucide-react";
import type { Load } from "@shared/schema";
import { apiJson } from "@/lib/queryClient";
import { formatDate, formatMiles, formatMoney, formatPpm } from "@/lib/format";
import { DataTable, type DataTableColumn } from "@/components/dispatch/DataTable";
import { McCell, MoneyCell } from "@/components/dispatch/cells";
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
 * Loads page — все грузы в системе. Compact density (много колонок).
 *
 * Live endpoint: GET /api/loads → Load[]. No pagination, no filters server-side.
 * Filtering is client-side (acceptable до пары тысяч строк).
 */
export default function LoadsPage() {
  const { t } = useT();
  const [q, setQ] = useState("");
  const [equipFilter, setEquipFilter] = useState<"all" | string>("all");
  const [ppmRange, setPpmRange] = useState<"all" | "low" | "mid" | "high">("all");

  const { data, isLoading, error } = useQuery<Load[]>({
    queryKey: ["/api/loads"],
    queryFn: () => apiJson<Load[]>("GET", "/api/loads"),
    staleTime: 30_000,
  });

  const rows = useMemo(() => {
    let r = data ?? [];
    if (q) {
      const needle = q.toLowerCase();
      r = r.filter(
        (l) =>
          l.brokerName.toLowerCase().includes(needle) ||
          l.originCity.toLowerCase().includes(needle) ||
          l.destinationCity.toLowerCase().includes(needle) ||
          l.brokerMc.toLowerCase().includes(needle) ||
          l.id.toLowerCase().includes(needle),
      );
    }
    if (equipFilter !== "all") {
      r = r.filter((l) => l.equipment === equipFilter);
    }
    if (ppmRange !== "all") {
      r = r.filter((l) => {
        const ppm = computePpm(l);
        if (ppmRange === "high") return ppm >= 2.5;
        if (ppmRange === "mid") return ppm >= 1.8 && ppm < 2.5;
        return ppm < 1.8;
      });
    }
    return r;
  }, [data, q, equipFilter, ppmRange]);

  return (
    <DensityProvider value="compact">
      <div className="space-y-6">
        <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {t("admin.loads.eyebrow")}
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("admin.loads.title")}</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {t("admin.loads.subtitle")}
            </p>
          </div>
        </header>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1 sm:max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("admin.loads.searchPlaceholder")}
              className="pl-9"
            />
          </div>
          <Select value={equipFilter} onValueChange={(v) => setEquipFilter(v)}>
            <SelectTrigger className="sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("admin.loads.allEquipment")}</SelectItem>
              <SelectItem value="enclosed_car_hauler">Enclosed Car Hauler</SelectItem>
              <SelectItem value="open_car_hauler">Open Car Hauler</SelectItem>
              <SelectItem value="hotshot_flatbed">Hotshot Flatbed</SelectItem>
              <SelectItem value="sprinter_van">Sprinter Van</SelectItem>
            </SelectContent>
          </Select>
          <Select value={ppmRange} onValueChange={(v) => setPpmRange(v as typeof ppmRange)}>
            <SelectTrigger className="sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("admin.loads.allPpm")}</SelectItem>
              <SelectItem value="high">High ($2.50+)</SelectItem>
              <SelectItem value="mid">Mid ($1.80–$2.50)</SelectItem>
              <SelectItem value="low">Low (&lt;$1.80)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{t("admin.loads.loadError", { message: (error as Error).message })}</AlertDescription>
          </Alert>
        ) : (
          <LoadsTable rows={rows} loading={isLoading} />
        )}

        {data && (
          <p className="text-xs text-muted-foreground">
            {t("admin.loads.total", { count: data.length })}
            {(q || equipFilter !== "all" || ppmRange !== "all") && t("admin.loads.filtered", { count: rows.length })}
          </p>
        )}
      </div>
    </DensityProvider>
  );
}

function computePpm(l: Load): number {
  return l.loadedMiles > 0 ? l.rate / l.loadedMiles : 0;
}

function LoadsTable({ rows, loading }: { rows: Load[]; loading: boolean }) {
  const { t } = useT();
  const [, setLocation] = useLocation();
  const columns: DataTableColumn<Load>[] = [
    {
      key: "lane",
      header: t("admin.loads.colLane"),
      cell: (l) => (
        <div className="min-w-0">
          <p className="truncate text-xs font-medium">
            {l.originCity}, {l.originState} → {l.destinationCity}, {l.destinationState}
          </p>
          <p className="truncate text-[10px] text-muted-foreground font-mono">
            {l.id}
          </p>
        </div>
      ),
    },
    {
      key: "rate",
      header: t("admin.loads.colRate"),
      align: "right",
      mono: true,
      cell: (l) => <MoneyCell value={l.rate} />,
      width: "90px",
    },
    {
      key: "miles",
      header: t("admin.loads.colMiles"),
      align: "right",
      mono: true,
      cell: (l) => formatMiles(l.loadedMiles),
      width: "90px",
      hideOnMobile: true,
    },
    {
      key: "ppm",
      header: t("admin.loads.colPpm"),
      align: "right",
      mono: true,
      cell: (l) => {
        const ppm = computePpm(l);
        const tone = ppm >= 2.5 ? "text-success" : ppm >= 1.8 ? "text-warning" : "text-destructive";
        return <span className={tone}>{formatPpm(ppm)}</span>;
      },
      width: "90px",
    },
    {
      key: "broker",
      header: t("admin.loads.colBroker"),
      cell: (l) => (
        <div className="min-w-0">
          <p className="truncate text-xs font-medium">{l.brokerName}</p>
          <p className="text-[10px] text-muted-foreground">
            <McCell value={l.brokerMc} />
          </p>
        </div>
      ),
      hideOnMobile: true,
    },
    {
      key: "fraudRisk",
      header: t("admin.loads.colFraud"),
      align: "center",
      cell: (l) => {
        const variant = l.fraudRisk >= 70 ? "stop" : l.fraudRisk >= 40 ? "verify" : "clean";
        return <StatusBadge variant={variant}>{l.fraudRisk}</StatusBadge>;
      },
      width: "80px",
      hideOnMobile: true,
    },
    {
      key: "equipment",
      header: t("admin.loads.colType"),
      cell: (l) => <span className="text-xs capitalize">{l.equipment.replace("_", " ")}</span>,
      width: "90px",
      hideOnMobile: true,
    },
    {
      key: "pickup",
      header: t("admin.loads.colPickup"),
      cell: (l) => <span className="text-xs text-muted-foreground">{formatDate(l.pickupAt)}</span>,
      width: "120px",
      hideOnMobile: true,
    },
  ];

  return (
    <DataTable
      density="compact"
      columns={columns}
      rows={rows}
      loading={loading}
      onRowClick={(l) => setLocation(`/loads/${l.id}`)}
      empty={
        <EmptyState
          icon={<Package />}
          title={t("admin.loads.emptyTitle")}
          description={t("admin.loads.emptyDescription")}
        />
      }
    />
  );
}

void Truck;
