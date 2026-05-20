import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { ArrowRight, Loader2, Package } from "lucide-react";
import type { LoadFull } from "@shared/schema";
import { apiJson } from "@/lib/queryClient";
import { formatMoney, formatDateFull, formatMiles } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/dispatch/StatusBadge";
import { EmptyState } from "@/components/dispatch/EmptyState";

type Status = "all" | "available" | "booked";

interface ListResponse {
  items: LoadFull[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number;
}

/**
 * /dispatch/loads — loads across the dispatcher's assigned clients.
 *
 * Filter: status tabs (Все / Доступные / В работе). clientId is read from
 * the URL query (?clientId=...) to support deep-linking from /clients page.
 * P0 read-only — no booking flow yet.
 */
export default function DispatchLoadsPage() {
  const [location, setLocation] = useLocation();

  // Parse status + clientId from the URL search part.
  const { status, clientId } = useMemo(() => {
    // wouter location doesn't carry search by default; pull from window.location.hash.
    const hash = window.location.hash; // e.g. #/dispatch/loads?status=booked
    const qIdx = hash.indexOf("?");
    const params = new URLSearchParams(qIdx >= 0 ? hash.slice(qIdx + 1) : "");
    const s = params.get("status");
    const valid: Status[] = ["all", "available", "booked"];
    return {
      status: (valid.includes(s as Status) ? s : "all") as Status,
      clientId: params.get("clientId") || undefined,
    };
  }, [location]);

  const queryStr = useMemo(() => {
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
    if (clientId) params.set("clientId", clientId);
    params.set("limit", "100");
    return `/api/dispatch/loads?${params.toString()}`;
  }, [status, clientId]);

  const { data, isLoading } = useQuery<ListResponse>({
    queryKey: [queryStr],
    queryFn: () => apiJson("GET", queryStr),
  });

  function setStatus(next: Status) {
    const params = new URLSearchParams();
    if (next !== "all") params.set("status", next);
    if (clientId) params.set("clientId", clientId);
    const qs = params.toString();
    setLocation(`/loads${qs ? `?${qs}` : ""}`);
  }

  return (
    <div className="space-y-5">
      <header>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          dispatcher / грузы
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Грузы</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Все рейсы по вашим клиентам.
          {clientId && (
            <>
              {" Фильтр: client "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                {clientId}
              </code>
            </>
          )}
        </p>
      </header>

      <Tabs value={status} onValueChange={(v) => setStatus(v as Status)}>
        <TabsList>
          <TabsTrigger value="all">Все</TabsTrigger>
          <TabsTrigger value="available">Доступные</TabsTrigger>
          <TabsTrigger value="booked">В работе</TabsTrigger>
        </TabsList>
      </Tabs>

      {isLoading ? (
        <Card className="flex h-32 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </Card>
      ) : !data || data.items.length === 0 ? (
        <Card className="p-2">
          <EmptyState
            icon={<Package className="h-6 w-6" />}
            title="Нет рейсов"
            description={
              status === "booked"
                ? "Нет активных рейсов."
                : status === "available"
                ? "Нет свободных рейсов."
                : "По этому фильтру пусто."
            }
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {data.items.map((load) => {
            const isBooked = Boolean(load.driverId && load.bookedAt);
            return (
              <Link key={load.id} href={`/loads/${load.id}`} className="block">
                <Card className="p-4 transition-colors hover:bg-muted/50">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate font-semibold">
                          {load.originCity}, {load.originState}{" "}
                          <span className="text-muted-foreground">→</span>{" "}
                          {load.destinationCity}, {load.destinationState}
                        </p>
                        <StatusBadge variant={isBooked ? "active" : "info"}>
                          {isBooked ? "В работе" : "Доступен"}
                        </StatusBadge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {load.brokerName} · {formatMiles(load.loadedMiles)} mi ·{" "}
                        {load.equipment.replace(/_/g, " ")}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Pickup: {formatDateFull(load.pickupAt)}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-mono text-base font-semibold">
                        {formatMoney(load.rate)}
                      </p>
                      <ArrowRight className="ml-auto mt-1 h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>
                </Card>
              </Link>
            );
          })}
          {data.total > data.items.length && (
            <p className="px-1 text-center text-xs text-muted-foreground">
              Показано {data.items.length} из {data.total}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
