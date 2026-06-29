import { useState } from "react";
import { Link } from "wouter";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronRight, Package } from "lucide-react";
import type { LoadFull, MeLoadsResponse } from "@shared/schema";
import { apiJson } from "@/lib/queryClient";
import { formatMoney, formatRelativeAgo } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/dispatch/EmptyState";
import { StatusBadge } from "@/components/dispatch/StatusBadge";
import { useT } from "@/lib/i18n";

/**
 * Driver loads list (`/d/loads`).
 *
 * Cursor pagination over GET /api/me/loads. Backend already sorts by
 * created_at DESC, so we can render rows in arrival order. Page-size 20.
 *
 * Filter (status=available|booked) wired up via small tabs at the top.
 * P0: статус выводится по эвристике "booked если driverId + bookedAt"
 * (см. deriveLoadStatus в server/routes/me.ts) — реальный статус в БД нет.
 */
export default function DriverLoadsListPage() {
  const { t } = useT();
  const [statusFilter, setStatusFilter] = useState<"all" | "available" | "booked">("all");

  const buildUrl = (cursor: string | null) => {
    const base =
      statusFilter === "all"
        ? `/api/me/loads?limit=20`
        : `/api/me/loads?limit=20&status=${statusFilter}`;
    return cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base;
  };

  // Cursor pagination via useInfiniteQuery so page accumulation lives in the
  // query cache (not component state). Refetch re-fetches every loaded page in
  // place, so rows never duplicate or churn — unlike the previous queryFn that
  // called setState as a side effect on each fetch.
  const { data, isLoading, isFetchingNextPage, fetchNextPage, hasNextPage, error } =
    useInfiniteQuery<MeLoadsResponse>({
      queryKey: ["me", "loads", statusFilter],
      queryFn: ({ pageParam }) =>
        apiJson<MeLoadsResponse>("GET", buildUrl((pageParam as string | null) ?? null)),
      initialPageParam: null as string | null,
      getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
      // No polling — list is read on visit, refresh via pull or filter change.
    });

  const allLoads: LoadFull[] = (data?.pages ?? []).flatMap((p) => p.items);
  const total = data?.pages[0]?.total ?? 0;
  const hasMore = hasNextPage;

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t("driver.loads_list.title")}</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {total === 0 ? t("driver.loads_list.no_loads") : t("driver.loads_list.total", { total })}
          </p>
        </div>
      </header>

      {/* Status filter pills. Phase 4 P0 only has two real statuses. */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        <FilterPill
          active={statusFilter === "all"}
          onClick={() => setStatusFilter("all")}
        >
          {t("driver.loads_list.filter.all")}
        </FilterPill>
        <FilterPill
          active={statusFilter === "booked"}
          onClick={() => setStatusFilter("booked")}
        >
          {t("driver.loads_list.filter.booked")}
        </FilterPill>
        <FilterPill
          active={statusFilter === "available"}
          onClick={() => setStatusFilter("available")}
        >
          {t("driver.loads_list.filter.available")}
        </FilterPill>
      </div>

      {isLoading && !data ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
      ) : error ? (
        <Card className="border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium">{t("driver.loads_list.load_error")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {(error as Error).message}
          </p>
        </Card>
      ) : allLoads.length === 0 ? (
        <EmptyState
          icon={<Package className="h-6 w-6" />}
          title={t("driver.loads_list.empty_title")}
          description={t("driver.loads_list.empty_desc")}
        />
      ) : (
        <ul className="space-y-3">
          {allLoads.map((load) => (
            <li key={load.id}>
              <LoadRow load={load} />
            </li>
          ))}
        </ul>
      )}

      {hasMore && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="lg"
            disabled={isFetchingNextPage}
            onClick={() => fetchNextPage()}
          >
            {isFetchingNextPage ? t("common.loading") : t("driver.loads_list.show_more")}
          </Button>
        </div>
      )}
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
        active
          ? "border-primary bg-primary/15 text-primary"
          : "border-border bg-card text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function LoadRow({ load }: { load: LoadFull }) {
  const { t } = useT();
  const isBooked = Boolean(load.driverId && load.bookedAt);
  return (
    <Link
      href={`/loads/${load.id}`}
      className="block rounded-lg border border-border bg-card p-4 transition-colors hover:bg-muted/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {load.originCity}, {load.originState} → {load.destinationCity},{" "}
            {load.destinationState}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {load.brokerName} · {formatRelativeAgo(load.pickupAt)}
          </p>
          <div className="mt-2">
            <StatusBadge variant={isBooked ? "active" : "info"}>
              {isBooked ? t("driver.loads_list.status.booked") : t("driver.loads_list.status.available")}
            </StatusBadge>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-base font-semibold">{formatMoney(load.rate)}</p>
          <p className="mt-2 inline-flex items-center text-xs text-muted-foreground">
            {t("driver.loads_list.open")} <ChevronRight className="ml-0.5 h-3 w-3" />
          </p>
        </div>
      </div>
    </Link>
  );
}
