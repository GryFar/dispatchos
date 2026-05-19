import { useRoute, useLocation } from "wouter";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  MapPin,
  Truck,
  Building2,
  Camera,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Loader2,
} from "lucide-react";
import type {
  CheckinKind,
  ExpenseCategory,
  IssueSeverity,
  LoadCheckin,
  LoadFull,
} from "@shared/schema";
import { apiJson, ApiError } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  formatMoney,
  formatDateFull,
  formatMiles,
  formatMc,
} from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/dispatch/StatusBadge";

/**
 * Driver load detail (`/d/loads/:id`).
 *
 * P1 makes action buttons functional:
 *   - Check-in: pulls navigator.geolocation, POSTs /api/me/loads/:id/checkin
 *   - POD: opens upload dialog → POST /api/me/expenses style multipart
 *     (NOTE: POD upload is wired into /api/me/documents in this PR since
 *      we don't have a dedicated POD storage yet; type='other' and a note
 *      gives admin enough context. Real "load-attached POD" can graduate
 *      to a typed slot in P2.)
 *   - Доставил: shortcut for check-in kind=delivered
 *   - Проблема: opens issue dialog → POST /api/me/issues
 *
 * Backend гарантирует 404 если load не принадлежит текущему driver'у —
 * никаких проверок tenant'а на фронте не нужно.
 */
export default function DriverLoadDetailPage() {
  const [match, params] = useRoute("/loads/:id");
  const [, setLocation] = useLocation();
  const loadId = match ? params?.id : null;

  const { data, isLoading, error } = useQuery<LoadFull>({
    queryKey: ["me", "load", loadId],
    queryFn: () => apiJson<LoadFull>("GET", `/api/me/loads/${loadId}`),
    enabled: Boolean(loadId),
  });

  const { data: checkinsData } = useQuery<{ items: LoadCheckin[] }>({
    queryKey: ["me", "load", loadId, "checkins"],
    queryFn: () =>
      apiJson<{ items: LoadCheckin[] }>("GET", `/api/me/loads/${loadId}/checkins`),
    enabled: Boolean(loadId),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    );
  }

  if (error) {
    const is404 = error instanceof ApiError && error.status === 404;
    return (
      <div className="space-y-4">
        <BackBar onClick={() => setLocation("/loads")} />
        <Card className="border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium">
            {is404 ? "Рейс не найден." : "Не удалось загрузить рейс."}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {is404
              ? "Возможно, он принадлежит другому водителю или был удалён."
              : (error as Error).message}
          </p>
        </Card>
      </div>
    );
  }

  if (!data) return null;

  const isBooked = Boolean(data.driverId && data.bookedAt);

  return (
    <div className="space-y-4">
      <BackBar onClick={() => setLocation("/loads")} />

      {/* Headline: route + money + status badge */}
      <Card className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Маршрут
            </p>
            <p className="mt-1 text-lg font-semibold tracking-tight">
              {data.originCity}, {data.originState}
              <span className="mx-2 text-muted-foreground">→</span>
              {data.destinationCity}, {data.destinationState}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {formatMiles(data.loadedMiles)} mi · {data.equipment.replace(/_/g, " ")}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="font-mono text-xl font-semibold">
              {formatMoney(data.rate)}
            </p>
            <div className="mt-2">
              <StatusBadge variant={isBooked ? "active" : "info"}>
                {isBooked ? "В работе" : "Доступен"}
              </StatusBadge>
            </div>
          </div>
        </div>
      </Card>

      {/* Pickup + delivery */}
      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <StopBlock
            label="Pickup"
            city={data.originCity}
            state={data.originState}
            iso={data.pickupAt}
          />
          <StopBlock
            label="Delivery"
            city={data.destinationCity}
            state={data.destinationState}
            iso={data.deliveryAt}
          />
        </div>
      </Card>

      {/* Broker info */}
      <Card className="p-4">
        <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Building2 className="h-3.5 w-3.5" /> Брокер
        </p>
        <p className="mt-2 text-sm font-medium">{data.brokerName}</p>
        <p className="mt-0.5 font-mono text-xs text-muted-foreground">
          {formatMc(data.brokerMc)}
        </p>
        {data.notes && (
          <p className="mt-3 rounded-md border border-border bg-muted/30 p-3 text-xs">
            {data.notes}
          </p>
        )}
      </Card>

      {/* Action buttons — P1: wired to real APIs */}
      <ActionButtons loadId={data.id} />

      {/* Checkins timeline (P1) */}
      {checkinsData && checkinsData.items.length > 0 && (
        <Card className="p-4">
          <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Clock className="h-3.5 w-3.5" /> Хронология
          </p>
          <ul className="mt-3 space-y-2">
            {checkinsData.items.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-xs">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                <div className="flex-1">
                  <p className="font-medium">{CHECKIN_LABELS[c.kind]}</p>
                  <p className="text-muted-foreground">
                    {formatDateFull(c.createdAt)}
                    {typeof c.lat === "number" && typeof c.lng === "number" && (
                      <> · {c.lat.toFixed(4)}, {c.lng.toFixed(4)}</>
                    )}
                  </p>
                  {c.notes && <p className="mt-0.5 text-muted-foreground">{c.notes}</p>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Footer meta */}
      <p className="px-1 pb-2 text-center text-[11px] text-muted-foreground">
        ID: <span className="font-mono">{data.id}</span>
      </p>
    </div>
  );
}

const CHECKIN_LABELS: Record<CheckinKind, string> = {
  pickup_arrived: "Прибыл на pickup",
  loaded: "Загружен",
  in_transit: "В пути",
  delivery_arrived: "Прибыл на delivery",
  delivered: "Доставлен",
  note: "Заметка",
};

function BackBar({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md px-1 py-1 text-sm font-medium text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" />
      Все рейсы
    </button>
  );
}

function StopBlock({
  label,
  city,
  state,
  iso,
}: {
  label: string;
  city: string;
  state: string;
  iso: string;
}) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <MapPin className="h-3.5 w-3.5" /> {label}
      </p>
      <p className="mt-1.5 text-sm font-medium">
        {city}, {state}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {formatDateFull(iso)}
      </p>
    </div>
  );
}

function ActionButtons({ loadId }: { loadId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [issueOpen, setIssueOpen] = useState(false);
  const [expenseOpen, setExpenseOpen] = useState(false);

  const checkinMutation = useMutation({
    mutationFn: (input: { kind: CheckinKind; lat?: number; lng?: number; notes?: string }) =>
      apiJson("POST", `/api/me/loads/${loadId}/checkin`, input),
    onSuccess: () => {
      toast({ title: "Check-in отправлен" });
      qc.invalidateQueries({ queryKey: ["me", "load", loadId, "checkins"] });
      qc.invalidateQueries({ queryKey: ["me", "load", loadId] });
      qc.invalidateQueries({ queryKey: ["/api/me/dashboard"] });
    },
    onError: (err: ApiError) => {
      toast({
        variant: "destructive",
        title: "Не удалось",
        description: err.message,
      });
    },
  });

  function withGeo(kind: CheckinKind) {
    if (!navigator.geolocation) {
      toast({
        variant: "destructive",
        title: "Геолокация недоступна",
        description: "Браузер не поддерживает определение местоположения.",
      });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        checkinMutation.mutate({
          kind,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        }),
      (err) =>
        toast({
          variant: "destructive",
          title: "Геолокация запрещена",
          description: err.message,
        }),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Button
          variant="outline"
          size="lg"
          className="h-auto flex-col gap-1.5 py-3"
          disabled={checkinMutation.isPending}
          onClick={() => withGeo("pickup_arrived")}
        >
          {checkinMutation.isPending ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Truck className="h-5 w-5" />
          )}
          <span className="text-xs font-medium">Check-in</span>
        </Button>
        <Button
          variant="outline"
          size="lg"
          className="h-auto flex-col gap-1.5 py-3"
          onClick={() => setExpenseOpen(true)}
        >
          <Camera className="h-5 w-5" />
          <span className="text-xs font-medium">Receipt</span>
        </Button>
        <Button
          variant="outline"
          size="lg"
          className="h-auto flex-col gap-1.5 py-3"
          disabled={checkinMutation.isPending}
          onClick={() => withGeo("delivered")}
        >
          <CheckCircle2 className="h-5 w-5" />
          <span className="text-xs font-medium">Доставил</span>
        </Button>
        <Button
          variant="outline"
          size="lg"
          className="h-auto flex-col gap-1.5 py-3"
          onClick={() => setIssueOpen(true)}
        >
          <AlertTriangle className="h-5 w-5" />
          <span className="text-xs font-medium">Проблема</span>
        </Button>
      </div>

      <IssueDialog open={issueOpen} onOpenChange={setIssueOpen} loadId={loadId} />
      <ExpenseDialog open={expenseOpen} onOpenChange={setExpenseOpen} loadId={loadId} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Issue dialog
// ---------------------------------------------------------------------------
function IssueDialog({
  open,
  onOpenChange,
  loadId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  loadId: string;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [severity, setSeverity] = useState<IssueSeverity>("warn");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      apiJson("POST", "/api/me/issues", {
        loadId,
        severity,
        title,
        description: description || undefined,
      }),
    onSuccess: () => {
      toast({
        title: "Отправлено диспетчеру",
        description: "Админ увидит вашу проблему в очереди.",
      });
      qc.invalidateQueries({ queryKey: ["/api/me/dashboard"] });
      onOpenChange(false);
      setTitle("");
      setDescription("");
      setSeverity("warn");
    },
    onError: (err: ApiError) =>
      toast({ variant: "destructive", title: "Не удалось", description: err.message }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Сообщить о проблеме</DialogTitle>
          <DialogDescription>
            Админ получит уведомление с возможностью связаться.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="issue-sev">Срочность</Label>
            <Select value={severity} onValueChange={(v) => setSeverity(v as IssueSeverity)}>
              <SelectTrigger id="issue-sev" className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="info">Информация</SelectItem>
                <SelectItem value="warn">Внимание</SelectItem>
                <SelectItem value="urgent">СРОЧНО</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="issue-title">Заголовок</Label>
            <Input
              id="issue-title"
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Брокер не отвечает"
              className="h-11"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="issue-desc">Описание (опц.)</Label>
            <Textarea
              id="issue-desc"
              value={description}
              maxLength={2000}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Что произошло, что вы пробовали..."
              rows={4}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || title.length < 3}
          >
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Отправить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Expense dialog (with optional photo)
// ---------------------------------------------------------------------------
function ExpenseDialog({
  open,
  onOpenChange,
  loadId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  loadId: string;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [category, setCategory] = useState<ExpenseCategory>("fuel");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const fd = new FormData();
      fd.append("loadId", loadId);
      fd.append("category", category);
      fd.append("amount", amount);
      if (notes) fd.append("notes", notes);
      if (photo) fd.append("photo", photo);
      const res = await fetch("/api/me/expenses", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new ApiError(res.status, msg || "Upload failed", null);
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Расход записан" });
      qc.invalidateQueries({ queryKey: ["/api/me/expenses"] });
      onOpenChange(false);
      setAmount("");
      setNotes("");
      setPhoto(null);
      setCategory("fuel");
    },
    onError: (err: ApiError) =>
      toast({ variant: "destructive", title: "Не удалось", description: err.message }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Записать расход</DialogTitle>
          <DialogDescription>
            Чек по топливу, парковке, ремонту и т.п. — для своего учёта.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="exp-cat">Категория</Label>
            <Select value={category} onValueChange={(v) => setCategory(v as ExpenseCategory)}>
              <SelectTrigger id="exp-cat" className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fuel">Топливо</SelectItem>
                <SelectItem value="parking">Парковка</SelectItem>
                <SelectItem value="tolls">Платные дороги</SelectItem>
                <SelectItem value="repair">Ремонт</SelectItem>
                <SelectItem value="lumper">Lumper</SelectItem>
                <SelectItem value="other">Другое</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="exp-amt">Сумма (USD)</Label>
            <Input
              id="exp-amt"
              type="number"
              step="0.01"
              min="0.01"
              max="100000"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="42.50"
              className="h-11"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="exp-notes">Заметки (опц.)</Label>
            <Input
              id="exp-notes"
              value={notes}
              maxLength={500}
              onChange={(e) => setNotes(e.target.value)}
              className="h-11"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="exp-photo">Фото чека (опц.)</Label>
            <Input
              id="exp-photo"
              type="file"
              accept="image/jpeg,image/png,application/pdf"
              onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
              className="h-11 py-2.5"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !amount || Number(amount) <= 0}
          >
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Сохранить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
