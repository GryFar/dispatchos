import { useQuery } from "@tanstack/react-query";
import { Timer } from "lucide-react";
import { apiJson } from "@/lib/queryClient";
import { formatMoneyCents, formatRelativeAgo } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/dispatch/StatusBadge";
import { EmptyState } from "@/components/dispatch/EmptyState";
import { useT } from "@/lib/i18n";

// ---------------------------------------------------------------------------
// WAVE B — owner detention tracker. GET /api/me/detention wraps the pure
// computeDetentionForLoad over the owner's OWN carrier loads. Figures are the
// PREVIEW (opportunity-to-chase) total, clearly labelled "potential" — this is
// a read-only view and never bills.
// ---------------------------------------------------------------------------

interface DetentionEvent {
  loadId: string;
  leg: "pickup" | "delivery";
  arrivedAt: string;
  completedAt: string;
  totalHours: number;
  freeHours: number;
  billableHours: number;
  ratePerHourCents: number;
  amountCents: number;
  source: "verified" | "auto" | "unverified" | "estimated";
  pingCount?: number;
}
interface DetentionRow {
  loadId: string;
  lane: string;
  events: DetentionEvent[];
  totalCents: number;
}
interface DetentionResponse {
  rows: DetentionRow[];
  generatedAt: string;
}

function sourceVariant(source: DetentionEvent["source"]): "book" | "negotiate" | "skip" | "info" {
  if (source === "verified") return "book";
  if (source === "auto") return "negotiate";
  if (source === "unverified") return "skip";
  return "info";
}

export default function OwnerDetentionPage() {
  const { t } = useT();
  const { data, isLoading, error } = useQuery<DetentionResponse>({
    queryKey: ["me", "detention"],
    queryFn: () => apiJson<DetentionResponse>("GET", "/api/me/detention"),
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-5">
      <header>
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Timer className="h-5 w-5 text-primary" />
          {t("driver.owner.detention.title")}
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {t("driver.owner.detention.subtitle")}
        </p>
      </header>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : error ? (
        <Card className="border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium">{t("common.error")}</p>
        </Card>
      ) : !data || data.rows.length === 0 ? (
        <EmptyState
          icon={<Timer />}
          title={t("driver.owner.detention.emptyTitle")}
          description={t("driver.owner.detention.emptyDesc")}
        />
      ) : (
        <ul className="space-y-3">
          {data.rows.map((row) => (
            <li key={row.loadId}>
              <Card className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 text-sm font-medium">{row.lane}</p>
                  <span className="shrink-0 text-right">
                    <span className="font-mono text-sm font-semibold">
                      {formatMoneyCents(row.totalCents)}
                    </span>
                    <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">
                      {t("driver.owner.detention.potential")}
                    </span>
                  </span>
                </div>
                <ul className="mt-2 space-y-1.5">
                  {row.events.map((ev, i) => (
                    <li
                      key={i}
                      className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-2.5 py-1.5 text-[11px]"
                    >
                      <span className="flex items-center gap-2">
                        <StatusBadge variant={sourceVariant(ev.source)} dot>
                          {t(`driver.owner.detention.source.${ev.source}`)}
                        </StatusBadge>
                        <span className="text-muted-foreground">
                          {t(`driver.owner.detention.leg.${ev.leg}`)} ·{" "}
                          {ev.billableHours}h · {formatRelativeAgo(ev.arrivedAt)}
                        </span>
                      </span>
                      <span className="font-mono">{formatMoneyCents(ev.amountCents)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
