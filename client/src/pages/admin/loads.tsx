import { useMemo, useState } from "react";
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

/**
 * Loads page — все грузы в системе. Compact density (много колонок).
 *
 * Live endpoint: GET /api/loads → Load[]. No pagination, no filters server-side.
 * Filtering is client-side (acceptable до пары тысяч строк).
 */
export default function LoadsPage() {
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
              Admin / Грузы
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">Грузы</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              История всех грузов: ставки, расстояние, broker, market quality.
            </p>
          </div>
        </header>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1 sm:max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Поиск: broker, MC, origin/destination, ID"
              className="pl-9"
            />
          </div>
          <Select value={equipFilter} onValueChange={(v) => setEquipFilter(v)}>
            <SelectTrigger className="sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все equipment</SelectItem>
              <SelectItem value="hotshot">Hotshot</SelectItem>
              <SelectItem value="car_hauler">Car Hauler</SelectItem>
              <SelectItem value="van">Van</SelectItem>
            </SelectContent>
          </Select>
          <Select value={ppmRange} onValueChange={(v) => setPpmRange(v as typeof ppmRange)}>
            <SelectTrigger className="sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все PPM</SelectItem>
              <SelectItem value="high">High ($2.50+)</SelectItem>
              <SelectItem value="mid">Mid ($1.80–$2.50)</SelectItem>
              <SelectItem value="low">Low (&lt;$1.80)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>Не удалось загрузить грузы: {(error as Error).message}</AlertDescription>
          </Alert>
        ) : (
          <LoadsTable rows={rows} loading={isLoading} />
        )}

        {data && (
          <p className="text-xs text-muted-foreground">
            Всего: {data.length}
            {(q || equipFilter !== "all" || ppmRange !== "all") && ` · отфильтровано: ${rows.length}`}
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
  const columns: DataTableColumn<Load>[] = [
    {
      key: "lane",
      header: "Lane",
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
      header: "Rate",
      align: "right",
      mono: true,
      cell: (l) => <MoneyCell value={l.rate} />,
      width: "90px",
    },
    {
      key: "miles",
      header: "Miles",
      align: "right",
      mono: true,
      cell: (l) => formatMiles(l.loadedMiles),
      width: "90px",
      hideOnMobile: true,
    },
    {
      key: "ppm",
      header: "PPM",
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
      header: "Broker",
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
      header: "Fraud",
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
      header: "Type",
      cell: (l) => <span className="text-xs capitalize">{l.equipment.replace("_", " ")}</span>,
      width: "90px",
      hideOnMobile: true,
    },
    {
      key: "pickup",
      header: "Pickup",
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
      empty={
        <EmptyState
          icon={<Package />}
          title="Нет грузов"
          description="Грузы появятся после CSV-импорта или email-ingest. Можно добавить через legacy-дашборд."
        />
      }
    />
  );
}

void Truck;
