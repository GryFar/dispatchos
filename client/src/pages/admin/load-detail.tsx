import { useRoute, useLocation } from "wouter";
import { TrustBadge } from "@/components/dispatch/TrustBadge";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Building2,
  Clock,
  Gauge,
  History,
  Loader2,
  MapPin,
  Truck,
  UserCircle2,
} from "lucide-react";
import type { CheckinKind, LoadCheckin, LoadFull, AuditEvent } from "@shared/schema";
import { apiJson, ApiError } from "@/lib/queryClient";
import { formatMoney, formatDateFull, formatMiles, formatMc } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/dispatch/StatusBadge";

/**
 * /admin/loads/:id — full admin load detail.
 *
 * Backend: GET /api/admin/loads/:id (server/routes/admin.ts, PR #46) returns
 * { load (+clientName/driverName), checkins[], events[], scores[] }.
 *
 * Richer than the dispatcher view: adds the audit-event timeline and the
 * per-client score breakdown. Read-only (admin reassignment endpoints are
 * not part of this surface).
 */

type AdminLoad = LoadFull & {
  clientId?: string | null;
  driverId?: string | null;
  bookedAt?: string | null;
  clientName?: string | null;
  driverName?: string | null;
};

interface ScoreRow {
  clientId: string;
  clientName: string;
  dispatchScore: number;
  verdict: string;
  estimatedNet: number;
  breakdown: unknown;
  computedAt: string;
}

interface AdminLoadResponse {
  load: AdminLoad;
  checkins: LoadCheckin[];
  events: AuditEvent[];
  scores: ScoreRow[];
}

const CHECKIN_LABELS: Record<CheckinKind, string> = {
  pickup_arrived: "Прибыл на pickup",
  loaded: "Загружен",
  in_transit: "В пути",
  delivery_arrived: "Прибыл на delivery",
  delivered: "Доставлен",
  note: "Заметка",
};

// Map a verdict string to a StatusBadge variant.
function verdictVariant(v: string): "book" | "negotiate" | "skip" | "info" {
  if (v === "book") return "book";
  if (v === "negotiate") return "negotiate";
  if (v === "skip") return "skip";
  return "info";
}

export default function AdminLoadDetailPage() {
  const [match, params] = useRoute("/loads/:id");
  const [, setLocation] = useLocation();
  const loadId = match ? params?.id : null;

  const { data, isLoading, error } = useQuery<AdminLoadResponse>({
    queryKey: ["/api/admin/loads", loadId],
    queryFn: () => apiJson<AdminLoadResponse>("GET", `/api/admin/loads/${loadId}`),
    enabled: Boolean(loadId),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <BackBar onClick={() => setLocation("/loads")} />
        <Card className="flex h-32 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </Card>
      </div>
    );
  }

  if (error || !data) {
    const is404 = error instanceof ApiError && error.status === 404;
    return (
      <div className="space-y-4">
        <BackBar onClick={() => setLocation("/loads")} />
        <Card className="border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium">{is404 ? "Рейс не найден." : "Не удалось загрузить рейс."}</p>
        </Card>
      </div>
    );
  }

  const { load, checkins, events, scores } = data;
  const isBooked = Boolean(load.driverId && load.bookedAt);

  return (
    <div className="space-y-4">
      <BackBar onClick={() => setLocation("/loads")} />

      {/* Headline */}
      <Card className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Маршрут
            </p>
            <p className="mt-1 text-lg font-semibold tracking-tight">
              {load.originCity}, {load.originState}
              <span className="mx-2 text-muted-foreground">→</span>
              {load.destinationCity}, {load.destinationState}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {formatMiles(load.loadedMiles)} mi · {load.equipment.replace(/_/g, " ")}
              {load.source && <> · {load.source}</>}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="font-mono text-xl font-semibold">{formatMoney(load.rate)}</p>
            <div className="mt-2">
              <StatusBadge variant={isBooked ? "active" : "info"}>
                {isBooked ? "В работе" : "Доступен"}
              </StatusBadge>
            </div>
          </div>
        </div>
      </Card>

      {/* Stops */}
      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <StopBlock label="Pickup" city={load.originCity} state={load.originState} iso={load.pickupAt} />
          <StopBlock
            label="Delivery"
            city={load.destinationCity}
            state={load.destinationState}
            iso={load.deliveryAt}
          />
        </div>
      </Card>

      {/* Client + Broker + Driver */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="p-4">
          <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Truck className="h-3.5 w-3.5" /> Клиент
          </p>
          <p className="mt-2 text-sm font-medium">{load.clientName ?? "—"}</p>
          {load.clientId && (
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">{load.clientId}</p>
          )}
        </Card>

        <Card className="p-4">
          <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Building2 className="h-3.5 w-3.5" /> Брокер
          </p>
          <p className="mt-2 text-sm font-medium">{load.brokerName}</p>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">{formatMc(load.brokerMc)}</p>
          <div className="mt-2">
            <TrustBadge brokerMc={load.brokerMc} />
          </div>
        </Card>
      </div>

      {/* Driver assignment (read-only) */}
      <Card className="p-4">
        <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <UserCircle2 className="h-3.5 w-3.5" /> Назначение
        </p>
        {load.driverId ? (
          <>
            <p className="mt-2 text-sm font-medium">{load.driverName ?? "Водитель"}</p>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">{load.driverId}</p>
            {load.bookedAt && (
              <p className="mt-1 text-xs text-muted-foreground">Booked: {load.bookedAt}</p>
            )}
          </>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">Водитель не назначен</p>
        )}
      </Card>

      {load.notes && (
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Заметки</p>
          <p className="mt-2 rounded-md border border-border bg-muted/30 p-3 text-xs">{load.notes}</p>
        </Card>
      )}

      {/* Score breakdown (admin-only richness) */}
      {scores.length > 0 && (
        <Card className="p-4">
          <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Gauge className="h-3.5 w-3.5" /> Скоринг по клиентам
          </p>
          <ul className="mt-3 space-y-2">
            {scores.map((s) => (
              <li
                key={s.clientId}
                className="flex items-center justify-between gap-3 rounded-md border border-border p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{s.clientName}</p>
                  <p className="text-[11px] text-muted-foreground">
                    net {formatMoney(s.estimatedNet)} · {formatDateFull(s.computedAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="font-mono text-sm font-semibold tabular-nums">
                    {s.dispatchScore}
                  </span>
                  <StatusBadge variant={verdictVariant(s.verdict)}>{s.verdict}</StatusBadge>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Checkins timeline */}
      {checkins.length > 0 && (
        <Card className="p-4">
          <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Clock className="h-3.5 w-3.5" /> Хронология чекинов
          </p>
          <ul className="mt-3 space-y-2">
            {checkins.map((c) => (
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

      {/* Audit events timeline (admin-only) */}
      <Card className="p-4">
        <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <History className="h-3.5 w-3.5" /> Журнал событий
        </p>
        {events.length === 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">Событий пока нет.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {events.map((e) => (
              <li key={e.id} className="flex items-start gap-2 text-xs">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground" />
                <div className="flex-1">
                  <p className="font-mono font-medium">{e.eventType}</p>
                  <p className="text-muted-foreground">{formatDateFull(e.createdAt)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="px-1 pb-2 text-center text-[11px] text-muted-foreground">
        ID: <span className="font-mono">{load.id}</span>
      </p>
    </div>
  );
}

function BackBar({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" /> Назад к грузам
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
        <MapPin className="h-3 w-3" /> {label}
      </p>
      <p className="mt-1 text-sm font-medium">
        {city}, {state}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{formatDateFull(iso)}</p>
    </div>
  );
}
