import { useRoute, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  MapPin,
  Truck,
  Building2,
  Camera,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import type { LoadFull } from "@shared/schema";
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
import { StatusBadge } from "@/components/dispatch/StatusBadge";

/**
 * Driver load detail (`/d/loads/:id`).
 *
 * P0 показывает: маршрут, брокера, pickup/delivery, ставку, equipment, ID.
 * Кнопки действий (POD, Check-in, Issue) показываются как заглушки с toast
 * — реальная функциональность в P1 (см. phase4-driver-p1 в handoff §3.2).
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

      {/* Action buttons — P0 stubs */}
      <ActionButtons />

      {/* Footer meta */}
      <p className="px-1 pb-2 text-center text-[11px] text-muted-foreground">
        ID: <span className="font-mono">{data.id}</span>
      </p>
    </div>
  );
}

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

function ActionButtons() {
  const { toast } = useToast();
  const pending = (feature: string) =>
    toast({
      title: "Доступно в P1",
      description: `${feature} появится в следующем PR (phase4-driver-p1).`,
    });

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Button
        variant="outline"
        size="lg"
        className="h-auto flex-col gap-1.5 py-3"
        onClick={() => pending("Check-in (геолокация)")}
      >
        <Truck className="h-5 w-5" />
        <span className="text-xs font-medium">Check-in</span>
      </Button>
      <Button
        variant="outline"
        size="lg"
        className="h-auto flex-col gap-1.5 py-3"
        onClick={() => pending("Загрузка POD")}
      >
        <Camera className="h-5 w-5" />
        <span className="text-xs font-medium">POD</span>
      </Button>
      <Button
        variant="outline"
        size="lg"
        className="h-auto flex-col gap-1.5 py-3"
        onClick={() => pending("Отметить delivered")}
      >
        <CheckCircle2 className="h-5 w-5" />
        <span className="text-xs font-medium">Доставил</span>
      </Button>
      <Button
        variant="outline"
        size="lg"
        className="h-auto flex-col gap-1.5 py-3"
        onClick={() => pending("Сообщить о проблеме")}
      >
        <AlertTriangle className="h-5 w-5" />
        <span className="text-xs font-medium">Проблема</span>
      </Button>
    </div>
  );
}
