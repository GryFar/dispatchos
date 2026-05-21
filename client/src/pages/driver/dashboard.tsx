import { useMemo } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Truck,
  MapPin,
  Phone,
  Camera,
  DollarSign,
  AlertTriangle,
  Clock,
  ChevronRight,
  Building2,
  UserCircle,
} from "lucide-react";
import type { DriverDashboard, DriverStatus, LoadFull, UserPublic } from "@shared/schema";
import { apiJson, ApiError } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatMoney, formatRelativeAgo } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Driver dashboard (`/d`).
 *
 * Реализует Phase 4 P0 §3.1 из handoff и §2.1 из phase3-structure:
 *   1. Status card — большой, цвет фона = статус.
 *   2. Today panel — pickup или delivery сегодня.
 *   3. Quick actions row — 4 кнопки (P0: только «Позвонить» рабочая,
 *      остальные показывают toast «доступно в P1»).
 *   4. История — последние 3 рейса.
 *
 * Все данные приходят одним запросом `GET /api/me/dashboard`. Поллинг каждые
 * 30 секунд через TanStack Query refetchInterval — Phase 5+ заменит на WS.
 *
 * Status change — отдельный POST /api/me/status, после успеха инвалидируем
 * dashboard query. Optimistic update не делаем в P0: переключение статуса
 * редкое, цена refetch'а ничтожна, простота кода важнее.
 */
export default function DriverDashboardPage() {
  const { data, isLoading, error } = useQuery<DriverDashboard>({
    queryKey: ["me", "dashboard"],
    queryFn: () => apiJson<DriverDashboard>("GET", "/api/me/dashboard"),
    // Real-time-ish: 30 sec polling per phase3-structure §3.1 / handoff §2.6.
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-12 w-full rounded-lg" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <Card className="border-destructive/40 bg-destructive/5 p-4 text-sm">
        <p className="font-medium">Не удалось загрузить главный экран.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {(error as Error | null)?.message ?? "Неизвестная ошибка"}
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <StatusCard driver={data.driver} currentLoad={data.currentLoad} />
      <TodayPanel
        currentLoad={data.currentLoad}
        todayPickup={data.todayPickup}
        todayDelivery={data.todayDelivery}
      />
      <PendingDocsCard docs={data.pendingDocs ?? []} />
      <ContextCard client={data.client} dispatcher={data.dispatcher} />
      <QuickActions
        phone={data.driver.phone}
        currentLoadId={data.currentLoad?.id ?? null}
      />
      <RecentLoadsPanel loads={data.recentLoads} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pending documents alert — P1. Only renders when driver has expiring or
// expired docs (within 30 days). Tappable: routes to /d/documents.
// ---------------------------------------------------------------------------
function PendingDocsCard({
  docs,
}: {
  docs: DriverDashboard["pendingDocs"];
}) {
  const [, setLocation] = useLocation();
  // P0 always returned []; defensive filter in case some clients still send
  // the old shape without `status`.
  const flagged = docs.filter(
    (d: Record<string, unknown>) => d.status === "expired" || d.status === "soon",
  );
  if (flagged.length === 0) return null;
  const hasExpired = flagged.some((d: Record<string, unknown>) => d.status === "expired");

  return (
    <button
      type="button"
      onClick={() => setLocation("/documents")}
      className={`flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${
        hasExpired
          ? "border-destructive/40 bg-destructive/10 hover:bg-destructive/15"
          : "border-yellow-500/40 bg-yellow-500/10 hover:bg-yellow-500/15"
      }`}
    >
      <div className="flex items-center gap-3">
        <AlertTriangle
          className={`h-5 w-5 shrink-0 ${
            hasExpired ? "text-destructive" : "text-yellow-500"
          }`}
        />
        <div>
          <p className="text-sm font-semibold">
            {hasExpired ? "Документы просрочены" : "Документы скоро истекают"}
          </p>
          <p className="text-xs text-muted-foreground">
            {flagged.length}{" "}
            {flagged.length === 1
              ? "документ"
              : flagged.length < 5
              ? "документа"
              : "документов"}{" "}
            требуют внимания
          </p>
        </div>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Status card — biggest UI element. Status drives the colour band on top.
// ---------------------------------------------------------------------------

const STATUS_META: Record<
  DriverStatus,
  { label: string; tone: string; description: string }
> = {
  available: {
    label: "🟡 Свободен",
    tone: "bg-warning/15 text-warning border-warning/30",
    description: "Жду назначения от диспетчера",
  },
  on_route: {
    label: "🟢 На грузе",
    tone: "bg-success/15 text-success border-success/30",
    description: "Везу активный груз",
  },
  off_duty: {
    label: "🔴 Off-duty",
    tone: "bg-muted text-muted-foreground border-border",
    description: "HOS reset / не на смене",
  },
};

function StatusCard({
  driver,
  currentLoad,
}: {
  driver: DriverDashboard["driver"];
  currentLoad: LoadFull | null;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const updateStatus = useMutation({
    mutationFn: (status: DriverStatus) =>
      apiJson<UserPublic>("POST", "/api/me/status", { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["me", "dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    },
    onError: (err) => {
      toast({
        title: "Не удалось изменить статус",
        description: err instanceof ApiError ? err.message : String(err),
        variant: "destructive",
      });
    },
  });

  const meta = STATUS_META[driver.status];

  return (
    <Card className={`border ${meta.tone} p-5`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide opacity-80">
            Статус
          </p>
          <p className="mt-1 text-2xl font-semibold tracking-tight">
            {meta.label}
          </p>
          <p className="mt-1 text-sm opacity-80">{meta.description}</p>
        </div>
        <Select
          value={driver.status}
          onValueChange={(value) => updateStatus.mutate(value as DriverStatus)}
          disabled={updateStatus.isPending}
        >
          <SelectTrigger className="h-11 w-[140px] bg-background/30 text-foreground">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="available">Свободен</SelectItem>
            <SelectItem value="on_route">На грузе</SelectItem>
            <SelectItem value="off_duty">Off-duty</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {currentLoad && (
        <div className="mt-4 border-t border-border/40 pt-3">
          <p className="text-xs font-medium uppercase tracking-wide opacity-70">
            Текущий груз
          </p>
          <p className="mt-1 text-sm font-medium">
            {currentLoad.originCity}, {currentLoad.originState} →{" "}
            {currentLoad.destinationCity}, {currentLoad.destinationState}
          </p>
          <div className="mt-1 flex items-center gap-3 text-xs opacity-80">
            <span className="font-mono">{formatMoney(currentLoad.rate)}</span>
            <span>{currentLoad.brokerName}</span>
          </div>
          <Link
            href={`/loads/${currentLoad.id}`}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            Открыть детали <ChevronRight className="h-3 w-3" />
          </Link>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Today panel
// ---------------------------------------------------------------------------

function TodayPanel({
  currentLoad,
  todayPickup,
  todayDelivery,
}: {
  currentLoad: LoadFull | null;
  todayPickup: DriverDashboard["todayPickup"];
  todayDelivery: DriverDashboard["todayDelivery"];
}) {
  const stop = todayPickup ?? todayDelivery;
  const stopKind = todayPickup ? "Pickup" : todayDelivery ? "Delivery" : null;

  if (!stop || !stopKind) {
    return (
      <Card className="p-4">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Clock className="h-4 w-4 text-muted-foreground" />
          Сегодня
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {currentLoad
            ? "На сегодня нет pickup/delivery — следующая активность завтра или позже."
            : "Нет активных грузов."}
        </p>
      </Card>
    );
  }

  return (
    <Card className="border-primary/30 bg-primary/5 p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-primary">
        <Clock className="h-4 w-4" />
        Сегодня · {stopKind}
      </p>
      <p className="mt-2 flex items-center gap-2 text-sm">
        <MapPin className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium">{stop.address}</span>
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {formatRelativeAgo(stop.time)}
        {stop.contact && ` · ${stop.contact}`}
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Quick actions — 4 buttons. P1: POD/Receipt/Issue route the driver to their
// active load if one exists (where check-in/expense/issue forms live), or
// show a friendly hint when there's no load yet. Phone call is native tel:.
// ---------------------------------------------------------------------------

function QuickActions({
  phone,
  currentLoadId,
}: {
  phone?: string;
  currentLoadId: string | null;
}) {
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  // Tapping POD/Receipt/Issue with no active load -> friendly toast. With a
  // load -> deep-link to /d/loads/:id where the action dialogs live.
  const routeOrHint = (action: string) => {
    if (currentLoadId) {
      setLocation(`/loads/${currentLoadId}`);
      return;
    }
    toast({
      title: "Нет активного рейса",
      description: `${action} привязывается к конкретному рейсу. Откройте рейс из списка.`,
    });
  };

  return (
    <div className="grid grid-cols-2 gap-3">
      <Button
        variant="outline"
        size="lg"
        className="h-auto flex-col gap-1.5 py-4"
        onClick={() => routeOrHint("POD/BOL")}
      >
        <Camera className="h-5 w-5" />
        <span className="text-xs font-medium">POD/BOL</span>
      </Button>
      <Button
        variant="outline"
        size="lg"
        className="h-auto flex-col gap-1.5 py-4"
        onClick={() => routeOrHint("Receipt")}
      >
        <DollarSign className="h-5 w-5" />
        <span className="text-xs font-medium">Receipt</span>
      </Button>
      <Button
        variant="outline"
        size="lg"
        className="h-auto flex-col gap-1.5 py-4"
        onClick={() => routeOrHint("Проблема")}
      >
        <AlertTriangle className="h-5 w-5" />
        <span className="text-xs font-medium">Проблема</span>
      </Button>
      {/* Call button. Uses native tel: link when we have a dispatcher number.
       *  Phase 4 P0: dispatcher phone не передаётся в /api/me/dashboard
       *  (нет привязки driver→assigned dispatcher одним запросом). Пока что
       *  показываем мягкий fallback с подсказкой обратиться к менеджеру. */}
      {phone ? (
        <Button asChild variant="default" size="lg" className="h-auto flex-col gap-1.5 py-4">
          <a href={`tel:${phone.replace(/[^+\d]/g, "")}`}>
            <Phone className="h-5 w-5" />
            <span className="text-xs font-medium">Позвонить</span>
          </a>
        </Button>
      ) : (
        <Button
          variant="default"
          size="lg"
          className="h-auto flex-col gap-1.5 py-4"
          onClick={() =>
            toast({
              title: "Нет номера диспетчера",
              description: "Добавьте телефон менеджера в профиле или свяжитесь через Telegram.",
            })
          }
        >
          <Phone className="h-5 w-5" />
          <span className="text-xs font-medium">Позвонить</span>
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recent loads — last 3, compact.
// ---------------------------------------------------------------------------

function RecentLoadsPanel({ loads }: { loads: LoadFull[] }) {
  const items = useMemo(() => loads.slice(0, 3), [loads]);

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Truck className="h-4 w-4 text-muted-foreground" />
          Последние рейсы
        </p>
        <Link
          href="/loads"
          className="text-xs font-medium text-primary hover:underline"
        >
          Все
        </Link>
      </div>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Здесь появятся ваши рейсы, как только диспетчер закрепит первый.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {items.map((load) => (
            <li key={load.id}>
              <Link
                href={`/loads/${load.id}`}
                className="flex items-center justify-between gap-3 py-3 -mx-1 px-1 rounded-md hover:bg-muted/40"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {load.originCity} → {load.destinationCity}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {load.brokerName}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-mono text-sm font-semibold">
                    {formatMoney(load.rate)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatRelativeAgo(load.pickupAt)}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ContextCard — shows driver's carrier company + active dispatcher contact.
// Compact card so driver knows "who I work for" and "who to call" at a glance.
// Phase 5 enrichment. Both fields are nullable: client missing when
// linkedClientId is unset, dispatcher missing when client has no assignment.
// ---------------------------------------------------------------------------
function ContextCard({
  client,
  dispatcher,
}: {
  client: { id: string; name: string; mc: string } | null;
  dispatcher: {
    id: string;
    fullName: string;
    email: string;
    phone: string | null;
  } | null;
}) {
  if (!client && !dispatcher) return null;

  return (
    <Card className="p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {client && (
          <div className="flex items-start gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
              <Building2 className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Моя компания
              </p>
              <p className="mt-0.5 truncate text-sm font-medium">{client.name}</p>
              <p className="font-mono text-[11px] text-muted-foreground">
                {client.mc}
              </p>
            </div>
          </div>
        )}
        {dispatcher && (
          <div className="flex items-start gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
              <UserCircle className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Мой диспетчер
              </p>
              <p className="mt-0.5 truncate text-sm font-medium">
                {dispatcher.fullName}
              </p>
              {dispatcher.phone ? (
                <a
                  href={`tel:${dispatcher.phone}`}
                  className="font-mono text-[11px] text-primary hover:underline"
                >
                  {dispatcher.phone}
                </a>
              ) : (
                <p className="truncate text-[11px] text-muted-foreground">
                  {dispatcher.email}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
