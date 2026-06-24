import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Archive, ArchiveRestore, Briefcase, Plus, Search } from "lucide-react";
import type { Client } from "@shared/schema";
import { formatClientDisplay } from "@shared/format-client";
import { apiJson } from "@/lib/queryClient";
import { useT, tr } from "@/lib/i18n";
import { useToast } from "@/hooks/use-toast";
import { formatMc, formatPpm } from "@/lib/format";
import { DataTable, type DataTableColumn } from "@/components/dispatch/DataTable";
import { McCell, PpmCell } from "@/components/dispatch/cells";
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

/**
 * Clients page — реестр клиентов. Live endpoints (v1.2.7).
 *
 * GET /api/clients — список (response: Client[], no pagination)
 * POST /api/clients — создание (body: InsertClient)
 *
 * Существующий backend не предоставляет PATCH/DELETE для клиентов. Редактирование
 * profile добавим в Phase 3 (или пользоваться легаси-дашбордом). Пока — read + create only.
 */
export default function ClientsPage() {
  const { t } = useT();
  const [createOpen, setCreateOpen] = useState(false);
  const [q, setQ] = useState("");
  const [equipFilter, setEquipFilter] = useState<"all" | string>("all");
  const [showArchived, setShowArchived] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, error } = useQuery<Client[]>({
    queryKey: ["/api/clients", showArchived],
    queryFn: () =>
      apiJson<Client[]>("GET", `/api/clients${showArchived ? "?includeDeleted=1" : ""}`),
    staleTime: 60_000,
  });
  const archiveMutation = useMutation({
    mutationFn: (id: string) => apiJson("DELETE", `/api/clients/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/clients"] });
      toast({ title: t("admin.clients.archivedToast") });
    },
    onError: () => {
      toast({ title: t("admin.clients.archiveErrorToast"), variant: "destructive" });
    },
  });

  function handleArchive(client: Client) {
    const ok = window.confirm(
      t("admin.clients.archiveConfirm", { name: client.name }),
    );
    if (ok) archiveMutation.mutate(client.id);
  }

  const restoreMutation = useMutation({
    mutationFn: (id: string) => apiJson("POST", `/api/clients/${id}/restore`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/clients"] });
      toast({ title: t("admin.clients.restoredToast") });
    },
    onError: () => {
      toast({ title: t("admin.clients.restoreErrorToast"), variant: "destructive" });
    },
  });

  function handleRestore(client: Client) {
    restoreMutation.mutate(client.id);
  }
  const rows = useMemo(() => {
    let r = data ?? [];
    if (q) {
      const needle = q.toLowerCase();
      r = r.filter(
        (c) =>
          c.name.toLowerCase().includes(needle) ||
          c.mc.toLowerCase().includes(needle),
      );
    }
    if (equipFilter !== "all") {
      r = r.filter((c) => c.equipment === equipFilter);
    }
    // showArchived ON => show ONLY archived clients; OFF => only active ones.
    r = r.filter((c) => (showArchived ? Boolean(c.deletedAt) : !c.deletedAt));
    return r;
  }, [data, q, equipFilter, showArchived]);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("admin.clients.breadcrumb")}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("admin.clients.title")}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {t("admin.clients.subtitle")}
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          {t("admin.clients.addClient")}
        </Button>
      </header>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("admin.clients.searchPlaceholder")}
            className="pl-9"
          />
        </div>
        <Select value={equipFilter} onValueChange={(v) => setEquipFilter(v)}>
          <SelectTrigger className="sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("admin.clients.allTypes")}</SelectItem>
            <SelectItem value="enclosed_car_hauler">Enclosed Car Hauler</SelectItem>
            <SelectItem value="open_car_hauler">Open Car Hauler</SelectItem>
            <SelectItem value="hotshot_flatbed">Hotshot Flatbed</SelectItem>
            <SelectItem value="sprinter_van">Sprinter Van</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant={showArchived ? "secondary" : "outline"}
          size="sm"
          onClick={() => setShowArchived((v) => !v)}
        >
          {showArchived ? t("admin.clients.hideArchive") : t("admin.clients.showArchive")}
        </Button>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{t("admin.clients.loadError", { message: (error as Error).message })}</AlertDescription>
        </Alert>
      ) : (
        <ClientsTable
          rows={rows}
          loading={isLoading}
          onArchive={handleArchive}
          archiving={archiveMutation.isPending}
          onRestore={handleRestore}
          restoring={restoreMutation.isPending}
        />
      )}

      {data && (
        <p className="text-xs text-muted-foreground">
          {t("admin.clients.total", { count: data.length })}
          {(q || equipFilter !== "all") && ` ${t("admin.clients.filtered", { count: rows.length })}`}
        </p>
      )}

      <CreateClientDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function ClientsTable({
  rows,
  loading,
  onArchive,
  archiving,
  onRestore,
  restoring,
}: {
  rows: Client[];
  loading: boolean;
  onArchive: (client: Client) => void;
  archiving: boolean;
  onRestore: (client: Client) => void;
  restoring: boolean;
}) {
  const { t } = useT();
  const columns: DataTableColumn<Client>[] = [
    {
      key: "name",
      header: t("admin.clients.colClient"),
      cell: (c) => (
        <Link
          href={`/clients/${c.id}`}
          className="block min-w-0 transition-colors hover:text-primary"
        >
          {/* Henry QA Bug #6+7: show combined 'Company — Contact' */}
          <p className="truncate font-medium">{formatClientDisplay(c as any)}</p>
          <p className="truncate text-xs text-muted-foreground">
            <McCell value={c.mc} />
          </p>
        </Link>
      ),
    },
    {
      key: "equipment",
      header: "Equipment",
      cell: (c) => (
        <StatusBadge variant="info" className="capitalize">
          {c.equipment.replace("_", " ")}
        </StatusBadge>
      ),
      width: "140px",
    },
    {
      key: "ppm",
      header: "Target / Min PPM",
      align: "right",
      cell: (c) => (
        <div className="font-mono tabular-nums text-xs">
          <div><PpmCell value={c.targetPpm} target={c.targetPpm} /></div>
          <div className="text-muted-foreground">min {formatPpm(c.minimumPpm)}</div>
        </div>
      ),
      width: "160px",
      hideOnMobile: true,
    },
    {
      key: "economics",
      header: "MPG / Fuel / FCpm",
      align: "right",
      cell: (c) => (
        <div className="font-mono tabular-nums text-xs text-muted-foreground">
          <div>{c.mpg.toFixed(1)} mpg</div>
          <div>${c.fuelPrice.toFixed(2)}/gal</div>
          <div>${c.fixedCostPerMile.toFixed(2)}/mi</div>
        </div>
      ),
      width: "150px",
      hideOnMobile: true,
    },
    {
      key: "location",
      header: t("admin.clients.colLocation"),
      cell: (c) =>
        c.currentLocation ? (
          <span className="text-xs">
            {c.currentLocation.city}, {c.currentLocation.state}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
      width: "160px",
      hideOnMobile: true,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (c) =>
        c.deletedAt ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRestore(c)}
            disabled={restoring}
            title={t("admin.clients.restoreTitle")}
          >
            <ArchiveRestore className="h-4 w-4 text-muted-foreground" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onArchive(c)}
            disabled={archiving}
            title={t("admin.clients.archiveTitle")}
          >
            <Archive className="h-4 w-4 text-muted-foreground" />
          </Button>
        ),
      width: "60px",
    },
  ];


  return (
    <DataTable
      columns={columns}
      rows={rows}
      loading={loading}
      empty={
        <EmptyState
          icon={<Briefcase />}
          title={t("admin.clients.emptyTitle")}
          description={t("admin.clients.emptyDescription")}
        />
      }
    />
  );
}

// ===========================================================================
// CREATE CLIENT DIALOG
// ===========================================================================

const createClientSchema = z.object({
  name: z.string().min(1, tr("admin.clients.nameRequired")),
  mc: z.string().min(1, tr("admin.clients.mcRequired")),
  equipment: z.enum(["enclosed_car_hauler", "open_car_hauler", "hotshot_flatbed", "sprinter_van"]),
  targetPpm: z.coerce.number().min(0.5, tr("admin.clients.minPpm")),
  minimumPpm: z.coerce.number().min(0.5, tr("admin.clients.minPpm")),
  mpg: z.coerce.number().min(1, "MPG > 1"),
  fuelPrice: z.coerce.number().min(0.5, "$0.50+"),
  fixedCostPerMile: z.coerce.number().min(0),
});
type CreateClientForm = z.infer<typeof createClientSchema>;

function CreateClientDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (b: boolean) => void }) {
  const { t } = useT();
  const qc = useQueryClient();
  const { toast } = useToast();

  const form = useForm<CreateClientForm>({
    resolver: zodResolver(createClientSchema),
    defaultValues: {
      name: "",
      mc: "",
      equipment: "enclosed_car_hauler",
      targetPpm: 2.5,
      minimumPpm: 1.8,
      mpg: 8,
      fuelPrice: 4.0,
      fixedCostPerMile: 0.35,
    },
  });

  const mutation = useMutation({
    mutationFn: (values: CreateClientForm) =>
      apiJson<Client>("POST", "/api/clients", {
        ...values,
        preferredLanes: [],
        avoidStates: [],
        currentLocation: {
          city: "",
          state: "",
          lat: 0,
          lng: 0,
          status: "unknown",
          updatedAt: new Date().toISOString(),
          source: "manual_checkin",
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/clients"] });
      toast({ title: t("admin.clients.createdToast") });
      onOpenChange(false);
      form.reset();
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: t("common.error"), description: err.message });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={form.handleSubmit((v) => mutation.mutate(v))}>
          <DialogHeader>
            <DialogTitle>{t("admin.clients.newClient")}</DialogTitle>
            <DialogDescription>
              {t("admin.clients.newClientDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3 py-4">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="name">{t("admin.clients.clientName")}</Label>
              <Input id="name" {...form.register("name")} placeholder="Ivan Petrov LLC" />
              {form.formState.errors.name && (
                <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mc">MC</Label>
              <Input id="mc" {...form.register("mc")} placeholder="123456" />
              {form.formState.errors.mc && (
                <p className="text-xs text-destructive">{form.formState.errors.mc.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="equipment">Equipment</Label>
              <Select
                value={form.watch("equipment")}
                onValueChange={(v) =>
                  form.setValue(
                    "equipment",
                    v as "enclosed_car_hauler" | "open_car_hauler" | "hotshot_flatbed" | "sprinter_van",
                  )
                }
              >
                <SelectTrigger id="equipment">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="enclosed_car_hauler">Enclosed Car Hauler</SelectItem>
                  <SelectItem value="open_car_hauler">Open Car Hauler</SelectItem>
                  <SelectItem value="hotshot_flatbed">Hotshot Flatbed</SelectItem>
                  <SelectItem value="sprinter_van">Sprinter Van</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="targetPpm">Target PPM ($/mi)</Label>
              <Input id="targetPpm" type="number" step="0.05" {...form.register("targetPpm")} />
              {form.formState.errors.targetPpm && (
                <p className="text-xs text-destructive">{form.formState.errors.targetPpm.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="minimumPpm">Min PPM ($/mi)</Label>
              <Input id="minimumPpm" type="number" step="0.05" {...form.register("minimumPpm")} />
              {form.formState.errors.minimumPpm && (
                <p className="text-xs text-destructive">{form.formState.errors.minimumPpm.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mpg">MPG</Label>
              <Input id="mpg" type="number" step="0.1" {...form.register("mpg")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fuelPrice">Fuel price ($/gal)</Label>
              <Input id="fuelPrice" type="number" step="0.01" {...form.register("fuelPrice")} />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="fixedCostPerMile">Fixed cost ($/mi)</Label>
              <Input id="fixedCostPerMile" type="number" step="0.01" {...form.register("fixedCostPerMile")} />
              <p className="text-[11px] text-muted-foreground">
                {t("admin.clients.fixedCostHint")}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? t("admin.clients.creating") : t("admin.clients.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// avoid unused-import warning while keeping these public helpers for future use
void formatMc;
