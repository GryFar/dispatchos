import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Headset, Search, ShieldCheck } from "lucide-react";
import type { BrokerRecord } from "@shared/schema";
import { apiJson } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatDateFull, formatRelativeAgo } from "@/lib/format";
import { DataTable, type DataTableColumn } from "@/components/dispatch/DataTable";
import { McCell } from "@/components/dispatch/cells";
import { StatusBadge } from "@/components/dispatch/StatusBadge";
import { EmptyState } from "@/components/dispatch/EmptyState";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DensityProvider } from "@/lib/density";
import { useT, tr } from "@/lib/i18n";

/**
 * Brokers page — реестр проверенных брокеров.
 *
 * GET /api/brokers → BrokerRecord[] (live, v1.2.7)
 * POST /api/broker/check → BrokerRecord (initiates FMCSA check)
 */
export default function BrokersPage() {
  const { t } = useT();
  const [q, setQ] = useState("");
  const [verdictFilter, setVerdictFilter] = useState<"all" | "clean" | "verify" | "stop">("all");
  const [checkOpen, setCheckOpen] = useState(false);

  const { data, isLoading, error } = useQuery<BrokerRecord[]>({
    queryKey: ["/api/brokers"],
    queryFn: () => apiJson<BrokerRecord[]>("GET", "/api/brokers"),
    staleTime: 60_000,
  });

  const rows = useMemo(() => {
    let r = data ?? [];
    if (q) {
      const needle = q.toLowerCase();
      r = r.filter(
        (b) =>
          b.brokerName.toLowerCase().includes(needle) ||
          b.brokerMc.toLowerCase().includes(needle),
      );
    }
    if (verdictFilter !== "all") {
      r = r.filter((b) => b.verdict === verdictFilter);
    }
    return r;
  }, [data, q, verdictFilter]);

  return (
    <DensityProvider value="compact">
      <div className="space-y-6">
        <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {t("admin.brokers.eyebrow")}
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("admin.brokers.title")}</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {t("admin.brokers.subtitle")}
            </p>
          </div>
          <Button onClick={() => setCheckOpen(true)}>
            <ShieldCheck className="h-4 w-4" />
            {t("admin.brokers.checkBroker")}
          </Button>
        </header>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("admin.brokers.searchPlaceholder")}
              className="pl-9"
            />
          </div>
          <Select value={verdictFilter} onValueChange={(v) => setVerdictFilter(v as typeof verdictFilter)}>
            <SelectTrigger className="sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("admin.brokers.allVerdicts")}</SelectItem>
              <SelectItem value="clean">Clean</SelectItem>
              <SelectItem value="verify">Verify</SelectItem>
              <SelectItem value="stop">Stop</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{t("admin.brokers.loadError", { message: (error as Error).message })}</AlertDescription>
          </Alert>
        ) : (
          <BrokersTable rows={rows} loading={isLoading} />
        )}

        {data && (
          <p className="text-xs text-muted-foreground">
            {t("admin.brokers.total", { count: data.length })}
            {(q || verdictFilter !== "all") && ` ${t("admin.brokers.filtered", { count: rows.length })}`}
          </p>
        )}

        <CheckBrokerDialog open={checkOpen} onOpenChange={setCheckOpen} />
      </div>
    </DensityProvider>
  );
}

function BrokersTable({ rows, loading }: { rows: BrokerRecord[]; loading: boolean }) {
  const { t } = useT();
  const columns: DataTableColumn<BrokerRecord>[] = [
    {
      key: "name",
      header: t("admin.brokers.colBroker"),
      cell: (b) => (
        <div className="min-w-0">
          <p className="truncate text-xs font-medium">{b.brokerName}</p>
          <p className="text-[10px] text-muted-foreground">
            <McCell value={b.brokerMc} />
          </p>
        </div>
      ),
    },
    {
      key: "authority",
      header: "Authority",
      cell: (b) => {
        const variant =
          b.authorityStatus === "authorized" ? "clean"
          : b.authorityStatus === "not_authorized" ? "stop"
          : "verify";
        return (
          <div>
            <StatusBadge variant={variant}>{b.authorityStatus.replace(/_/g, " ")}</StatusBadge>
            {b.authorityAgeMonths > 0 && (
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {t("admin.brokers.months", { count: b.authorityAgeMonths })}
              </p>
            )}
          </div>
        );
      },
      width: "160px",
    },
    {
      key: "risk",
      header: "Risk",
      align: "center",
      cell: (b) => {
        const variant = b.riskScore >= 70 ? "stop" : b.riskScore >= 40 ? "verify" : "clean";
        return <StatusBadge variant={variant}>{b.riskScore}</StatusBadge>;
      },
      width: "80px",
    },
    {
      key: "verdict",
      header: "Verdict",
      cell: (b) => <StatusBadge variant={b.verdict} dot>{b.verdict.toUpperCase()}</StatusBadge>,
      width: "110px",
    },
    {
      key: "flags",
      header: "Flags",
      cell: (b) =>
        b.flags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {b.flags.slice(0, 3).map((f, i) => (
              <span
                key={i}
                className="rounded bg-warning/10 px-1 py-0.5 text-[10px] text-warning"
              >
                {f}
              </span>
            ))}
            {b.flags.length > 3 && (
              <span className="text-[10px] text-muted-foreground">+{b.flags.length - 3}</span>
            )}
          </div>
        ) : (
          <span className="text-[10px] text-muted-foreground">—</span>
        ),
      hideOnMobile: true,
    },
    {
      key: "checked",
      header: t("admin.brokers.colChecked"),
      cell: (b) => (
        <span className="text-[10px] text-muted-foreground" title={formatDateFull(b.checkedAt)}>
          {formatRelativeAgo(b.checkedAt)}
        </span>
      ),
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
          icon={<Headset />}
          title={t("admin.brokers.emptyTitle")}
          description={t("admin.brokers.emptyDescription")}
        />
      }
    />
  );
}

// ===========================================================================
// CHECK BROKER DIALOG
// ===========================================================================

const checkBrokerSchema = z.object({
  brokerMc: z.string().min(1, tr("admin.brokers.mcRequired")),
  brokerName: z.string().optional(),
});
type CheckBrokerForm = z.infer<typeof checkBrokerSchema>;

function CheckBrokerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (b: boolean) => void }) {
  const { t } = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [result, setResult] = useState<BrokerRecord | null>(null);

  const localizedSchema = useMemo(
    () =>
      z.object({
        brokerMc: z.string().min(1, t("admin.brokers.mcRequired")),
        brokerName: z.string().optional(),
      }),
    [t],
  );

  const form = useForm<CheckBrokerForm>({
    resolver: zodResolver(localizedSchema),
    defaultValues: { brokerMc: "", brokerName: "" },
  });

  const mutation = useMutation({
    mutationFn: (values: CheckBrokerForm) =>
      apiJson<BrokerRecord>("POST", "/api/broker/check", values),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/brokers"] });
      setResult(data);
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: t("admin.brokers.checkError"), description: err.message });
    },
  });

  function handleClose() {
    onOpenChange(false);
    setTimeout(() => {
      form.reset();
      setResult(null);
    }, 200);
  }

  return (
    <Dialog open={open} onOpenChange={(b) => (b ? onOpenChange(true) : handleClose())}>
      <DialogContent className="sm:max-w-md">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle>{result.brokerName}</DialogTitle>
              <DialogDescription>
                <McCell value={result.brokerMc} />
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-4">
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">Verdict</span>
                <StatusBadge variant={result.verdict} dot>
                  {result.verdict.toUpperCase()}
                </StatusBadge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">Authority</span>
                <span className="text-sm capitalize">{result.authorityStatus.replace(/_/g, " ")}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">Risk score</span>
                <span className="font-mono text-sm">{result.riskScore}</span>
              </div>
              {result.flags.length > 0 && (
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">Flags</p>
                  <ul className="mt-1.5 space-y-1">
                    {result.flags.map((f, i) => (
                      <li
                        key={i}
                        className="rounded bg-warning/10 px-2 py-1 text-xs text-warning"
                      >
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button onClick={handleClose}>{t("common.success")}</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={form.handleSubmit((v) => mutation.mutate(v))}>
            <DialogHeader>
              <DialogTitle>{t("admin.brokers.checkBroker")}</DialogTitle>
              <DialogDescription>
                {t("admin.brokers.checkDialogDescription")}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-1.5">
                <Label htmlFor="brokerMc">{t("admin.brokers.mcLabel")}</Label>
                <Input
                  id="brokerMc"
                  placeholder="123456"
                  autoFocus
                  {...form.register("brokerMc")}
                />
                {form.formState.errors.brokerMc && (
                  <p className="text-xs text-destructive">{form.formState.errors.brokerMc.message}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="brokerName">{t("admin.brokers.nameLabel")}</Label>
                <Input id="brokerName" placeholder="ABC Logistics LLC" {...form.register("brokerName")} />
              </div>
              <Alert>
                <AlertDescription className="text-xs">
                  {t("admin.brokers.checkHint")}
                </AlertDescription>
              </Alert>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={handleClose}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? t("admin.brokers.checking") : t("admin.brokers.check")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
