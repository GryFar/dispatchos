import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { CreditCard, FilePlus2, Plus } from "lucide-react";
import type {
  Client,
  GenerateInvoiceInput,
  Invoice,
  InvoicePreview,
  InvoiceStatus,
} from "@shared/schema";
import { apiJson } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatDateOnly, formatMoney, formatMoneyCents } from "@/lib/format";
import { DataTable, type DataTableColumn } from "@/components/dispatch/DataTable";
import { MoneyCell } from "@/components/dispatch/cells";
import { StatusBadge } from "@/components/dispatch/StatusBadge";
import { EmptyState } from "@/components/dispatch/EmptyState";
import { EndpointPending, isEndpointMissing } from "@/components/dispatch/EndpointPending";
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

type InvoiceListResponse = {
  items: Invoice[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number | null;
};

const STATUS_VARIANT: Record<InvoiceStatus, "info" | "active" | "clean" | "stop"> = {
  draft: "info",
  sent: "active",
  paid: "clean",
  void: "stop",
};

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  paid: "Paid",
  void: "Void",
};

export default function BillingPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | InvoiceStatus>("all");

  const queryUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (statusFilter !== "all") params.set("status", statusFilter);
    params.set("limit", "50");
    return `/api/admin/billing/invoices?${params.toString()}`;
  }, [statusFilter]);

  const { data, isLoading, error } = useQuery<InvoiceListResponse>({
    queryKey: [queryUrl],
    queryFn: () => apiJson<InvoiceListResponse>("GET", queryUrl),
    staleTime: 30_000,
  });

  if (isEndpointMissing(error)) {
    return (
      <div className="space-y-6">
        <Header onCreate={() => setCreateOpen(true)} />
        <EndpointPending
          endpoint="GET /api/admin/billing/invoices"
          description="Биллинг и инвойсы будут доступны после Phase 3 (priority P2). После реализации появится список, фильтры и preview перед генерацией."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Header onCreate={() => setCreateOpen(true)} />

      <div className="flex items-center gap-2">
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
          <SelectTrigger className="sm:w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все статусы</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="paid">Paid</SelectItem>
            <SelectItem value="void">Void</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>Не удалось загрузить инвойсы: {(error as Error).message}</AlertDescription>
        </Alert>
      ) : (
        <InvoicesTable rows={data?.items ?? []} loading={isLoading} />
      )}

      <GenerateInvoiceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function Header({ onCreate }: { onCreate: () => void }) {
  return (
    <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Admin / Биллинг
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Биллинг</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Еженедельные инвойсы клиентам: $150 flat + 3% от gross booked.
        </p>
      </div>
      <Button onClick={onCreate}>
        <Plus className="h-4 w-4" />
        Сгенерировать инвойс
      </Button>
    </header>
  );
}

function InvoicesTable({ rows, loading }: { rows: Invoice[]; loading: boolean }) {
  const columns: DataTableColumn<Invoice>[] = [
    {
      key: "client",
      header: "Клиент",
      cell: (inv) => <span className="text-sm font-medium">{inv.clientId}</span>,
    },
    {
      key: "week",
      header: "Неделя",
      cell: (inv) => (
        <span className="text-xs text-muted-foreground">
          {formatDateOnly(inv.weekStart)} – {formatDateOnly(inv.weekEnd)}
        </span>
      ),
      width: "200px",
    },
    {
      key: "gross",
      header: "Gross booked",
      align: "right",
      mono: true,
      cell: (inv) => <MoneyCell value={inv.grossBooked} />,
      width: "130px",
      hideOnMobile: true,
    },
    {
      key: "fees",
      header: "Flat + %",
      align: "right",
      mono: true,
      cell: (inv) => (
        <div className="text-xs">
          <div>{formatMoney(inv.flatFee)}</div>
          <div className="text-muted-foreground">{formatMoneyCents(inv.percentFee)}</div>
        </div>
      ),
      width: "120px",
      hideOnMobile: true,
    },
    {
      key: "total",
      header: "Итого",
      align: "right",
      mono: true,
      cell: (inv) => <MoneyCell value={inv.totalDue} cents />,
      width: "120px",
    },
    {
      key: "status",
      header: "Статус",
      cell: (inv) => (
        <StatusBadge variant={STATUS_VARIANT[inv.status]} dot>
          {STATUS_LABEL[inv.status]}
        </StatusBadge>
      ),
      width: "100px",
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      loading={loading}
      empty={
        <EmptyState
          icon={<CreditCard />}
          title="Нет инвойсов"
          description="Сгенерируйте первый инвойс через кнопку выше."
        />
      }
    />
  );
}

// ===========================================================================
// GENERATE INVOICE DIALOG (with preview step)
// ===========================================================================

const generateSchema = z.object({
  clientId: z.string().min(1, "Выберите клиента"),
  weekStart: z.string().min(1, "Начало недели"),
  weekEnd: z.string().min(1, "Конец недели"),
});
type GenerateForm = z.infer<typeof generateSchema>;

function GenerateInvoiceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (b: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [step, setStep] = useState<"form" | "preview">("form");
  const [preview, setPreview] = useState<InvoicePreview | null>(null);

  const clientsQuery = useQuery<Client[]>({
    queryKey: ["/api/clients"],
    queryFn: () => apiJson<Client[]>("GET", "/api/clients"),
    staleTime: 60_000,
    enabled: open,
  });

  const form = useForm<GenerateForm>({
    resolver: zodResolver(generateSchema),
    defaultValues: { clientId: "", weekStart: defaultWeekStart(), weekEnd: defaultWeekEnd() },
  });

  const previewMutation = useMutation({
    mutationFn: (values: GenerateForm) =>
      apiJson<InvoicePreview>("POST", "/api/admin/billing/preview", values as GenerateInvoiceInput),
    onSuccess: (data) => {
      setPreview(data);
      setStep("preview");
    },
    onError: (err: Error) => {
      if (isEndpointMissing(err)) {
        toast({
          variant: "destructive",
          title: "Endpoint не реализован",
          description: "POST /api/admin/billing/preview — Phase 3 (P2).",
        });
      } else {
        toast({ variant: "destructive", title: "Ошибка preview", description: err.message });
      }
    },
  });

  const generateMutation = useMutation({
    mutationFn: (status: "draft" | "sent") => {
      const v = form.getValues();
      return apiJson<Invoice>("POST", "/api/admin/billing/generate", {
        ...v,
        status,
      } as GenerateInvoiceInput);
    },
    onSuccess: () => {
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/admin/billing") });
      toast({ title: "Инвойс создан" });
      handleClose();
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Ошибка генерации", description: err.message });
    },
  });

  function handleClose() {
    onOpenChange(false);
    setTimeout(() => {
      form.reset({ clientId: "", weekStart: defaultWeekStart(), weekEnd: defaultWeekEnd() });
      setPreview(null);
      setStep("form");
    }, 200);
  }

  return (
    <Dialog open={open} onOpenChange={(b) => (b ? onOpenChange(true) : handleClose())}>
      <DialogContent className="sm:max-w-lg">
        {step === "form" ? (
          <form onSubmit={form.handleSubmit((v) => previewMutation.mutate(v))}>
            <DialogHeader>
              <DialogTitle>Сгенерировать инвойс</DialogTitle>
              <DialogDescription>
                Сначала превью — посмотрите breakdown по грузам. Запись в БД только после
                подтверждения.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-1.5">
                <Label htmlFor="clientId">Клиент</Label>
                <Select
                  value={form.watch("clientId")}
                  onValueChange={(v) => form.setValue("clientId", v)}
                >
                  <SelectTrigger id="clientId">
                    <SelectValue placeholder="Выберите клиента" />
                  </SelectTrigger>
                  <SelectContent>
                    {(clientsQuery.data ?? []).map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {form.formState.errors.clientId && (
                  <p className="text-xs text-destructive">{form.formState.errors.clientId.message}</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="weekStart">Начало недели</Label>
                  <Input id="weekStart" type="date" {...form.register("weekStart")} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="weekEnd">Конец недели</Label>
                  <Input id="weekEnd" type="date" {...form.register("weekEnd")} />
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={handleClose}>
                Отмена
              </Button>
              <Button type="submit" disabled={previewMutation.isPending}>
                {previewMutation.isPending ? "Расчёт..." : "Посмотреть превью"}
              </Button>
            </DialogFooter>
          </form>
        ) : preview ? (
          <PreviewView
            preview={preview}
            onBack={() => setStep("form")}
            onSaveDraft={() => generateMutation.mutate("draft")}
            onSaveAndSend={() => generateMutation.mutate("sent")}
            saving={generateMutation.isPending}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PreviewView({
  preview,
  onBack,
  onSaveDraft,
  onSaveAndSend,
  saving,
}: {
  preview: InvoicePreview;
  onBack: () => void;
  onSaveDraft: () => void;
  onSaveAndSend: () => void;
  saving: boolean;
}) {
  return (
    <>
      <DialogHeader>
        <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <FilePlus2 className="h-6 w-6" />
        </div>
        <DialogTitle className="text-center">Превью инвойса</DialogTitle>
        <DialogDescription className="text-center">
          {formatDateOnly(preview.weekStart)} – {formatDateOnly(preview.weekEnd)} · {preview.breakdown.loadCount} грузов
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-4">
        <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
          <Row label="Gross booked" value={formatMoney(preview.grossBooked)} />
          <Row label="Flat fee" value={formatMoney(preview.flatFee)} />
          <Row label="Percent fee (3%)" value={formatMoneyCents(preview.percentFee)} />
          <div className="my-2 border-t border-border" />
          <Row
            label={<span className="font-semibold">Итого</span>}
            value={<span className="font-mono font-semibold">{formatMoneyCents(preview.totalDue)}</span>}
          />
        </div>

        {preview.breakdown.loads.length > 0 ? (
          <div>
            <p className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">Грузы недели</p>
            <div className="max-h-48 overflow-y-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">Lane</th>
                    <th className="px-2 py-1.5 text-right font-medium text-muted-foreground">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.breakdown.loads.map((l) => (
                    <tr key={l.loadId} className="border-t border-border">
                      <td className="px-2 py-1.5">{l.originCity} → {l.destinationCity}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{formatMoney(l.rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <Alert>
            <AlertDescription className="text-xs">
              За этот период грузов нет. Инвойс будет содержать только flat fee.
            </AlertDescription>
          </Alert>
        )}
      </div>

      <DialogFooter className="gap-2 sm:gap-2">
        <Button type="button" variant="outline" onClick={onBack} disabled={saving}>
          Назад
        </Button>
        <Button type="button" variant="outline" onClick={onSaveDraft} disabled={saving}>
          Draft
        </Button>
        <Button type="button" onClick={onSaveAndSend} disabled={saving}>
          {saving ? "Сохранение..." : "Сохранить и отправить"}
        </Button>
      </DialogFooter>
    </>
  );
}

function Row({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </div>
  );
}

function defaultWeekStart(): string {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff - 7);
  return d.toISOString().slice(0, 10);
}

function defaultWeekEnd(): string {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff - 1);
  return d.toISOString().slice(0, 10);
}
