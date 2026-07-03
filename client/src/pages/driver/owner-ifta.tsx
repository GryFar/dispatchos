import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileSpreadsheet, Download } from "lucide-react";
import { apiJson } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable, type DataTableColumn } from "@/components/dispatch/DataTable";
import { EmptyState } from "@/components/dispatch/EmptyState";
import { useT } from "@/lib/i18n";

// ---------------------------------------------------------------------------
// WAVE B — owner IFTA quarterly. GET /api/me/ifta(.csv) — same computation the
// admin route gates behind `admin`, but clientId is derived from the session
// (never a path param). Quarter/year picker + per-state table + CSV download.
// ---------------------------------------------------------------------------

interface IftaStateRow {
  state: string;
  miles: number;
  gallons: number;
  fuelCostUsd: number;
}
interface IftaReport {
  clientId: string;
  year: number;
  quarter: 1 | 2 | 3 | 4;
  periodStart: string;
  periodEnd: string;
  rows: IftaStateRow[];
  totals: { miles: number; gallons: number; fuelCostUsd: number; avgMpg: number | null };
  unknownStateMiles: number;
  unknownStateGallons: number;
  generatedAt: string;
}

const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export default function OwnerIftaPage() {
  const { t } = useT();
  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [quarter, setQuarter] = useState<1 | 2 | 3 | 4>(
    (Math.floor(now.getUTCMonth() / 3) + 1) as 1 | 2 | 3 | 4,
  );

  const { data, isLoading, error } = useQuery<IftaReport>({
    queryKey: ["me", "ifta", year, quarter],
    queryFn: () => apiJson<IftaReport>("GET", `/api/me/ifta?year=${year}&quarter=${quarter}`),
  });

  const years = [now.getUTCFullYear(), now.getUTCFullYear() - 1, now.getUTCFullYear() - 2];

  const columns: DataTableColumn<IftaStateRow>[] = [
    { key: "state", header: t("driver.owner.ifta.col.state"), cell: (r) => r.state, mono: true },
    {
      key: "miles",
      header: t("driver.owner.ifta.col.miles"),
      cell: (r) => nf.format(r.miles),
      align: "right",
      mono: true,
    },
    {
      key: "gallons",
      header: t("driver.owner.ifta.col.gallons"),
      cell: (r) => nf.format(r.gallons),
      align: "right",
      mono: true,
    },
    {
      key: "fuel",
      header: t("driver.owner.ifta.col.fuel"),
      cell: (r) => `$${nf.format(r.fuelCostUsd)}`,
      align: "right",
      mono: true,
    },
  ];

  const csvHref = `/api/me/ifta.csv?year=${year}&quarter=${quarter}`;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <FileSpreadsheet className="h-5 w-5 text-primary" />
          {t("driver.owner.ifta.title")}
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {t("driver.owner.ifta.subtitle")}
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("driver.owner.ifta.year")}
          </label>
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger className="w-[110px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {years.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("driver.owner.ifta.quarter")}
          </label>
          <Select value={String(quarter)} onValueChange={(v) => setQuarter(Number(v) as 1 | 2 | 3 | 4)}>
            <SelectTrigger className="w-[110px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[1, 2, 3, 4].map((q) => (
                <SelectItem key={q} value={String(q)}>
                  Q{q}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button asChild variant="outline" className="gap-1.5">
          <a href={csvHref} download>
            <Download className="h-4 w-4" />
            {t("driver.owner.ifta.downloadCsv")}
          </a>
        </Button>
      </div>

      {error ? (
        <Card className="border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium">{t("common.error")}</p>
        </Card>
      ) : !isLoading && data && data.rows.length === 0 ? (
        <EmptyState
          icon={<FileSpreadsheet />}
          title={t("driver.owner.ifta.emptyTitle")}
          description={t("driver.owner.ifta.emptyDesc")}
        />
      ) : (
        <>
          {data && (
            <Card className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
              <Totals label={t("driver.owner.ifta.col.miles")} value={nf.format(data.totals.miles)} />
              <Totals label={t("driver.owner.ifta.col.gallons")} value={nf.format(data.totals.gallons)} />
              <Totals label={t("driver.owner.ifta.col.fuel")} value={`$${nf.format(data.totals.fuelCostUsd)}`} />
              <Totals
                label={t("driver.owner.ifta.avgMpg")}
                value={data.totals.avgMpg == null ? "—" : data.totals.avgMpg.toFixed(1)}
              />
            </Card>
          )}
          <DataTable
            columns={columns}
            rows={data?.rows ?? []}
            loading={isLoading}
            rowKey={(r) => r.state}
            density="compact"
          />
          {data && (data.unknownStateMiles > 0 || data.unknownStateGallons > 0) && (
            <p className="text-[11px] text-muted-foreground">
              {t("driver.owner.ifta.unknownNote", {
                miles: nf.format(data.unknownStateMiles),
                gallons: nf.format(data.unknownStateGallons),
              })}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Totals({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <p className="font-mono text-lg font-semibold">{value}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}
