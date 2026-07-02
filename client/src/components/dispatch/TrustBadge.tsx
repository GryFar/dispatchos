import { useQuery } from "@tanstack/react-query";
import { ShieldAlert, ShieldQuestion } from "lucide-react";
import { apiJson } from "@/lib/queryClient";
import { StatusBadge } from "@/components/dispatch/StatusBadge";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/**
 * TrustBadge — Broker Trust Score indicator (Killer #1).
 *
 * Fetches GET /api/broker-trust/:mc (cached per MC by React Query) and renders
 * a traffic-light StatusBadge with the 0..100 score. Shown wherever a broker
 * MC# appears (dispatch loads cards, admin load detail).
 *
 * Important: an empty history returns score 50 with totalSignals 0. That is
 * "no data", NOT "average broker" — we render a muted "no data" chip so the
 * neutral 50 is never mistaken for a real middling score.
 */

interface TrustResponse {
  mc: string;
  totalSignals: number;
  positiveCount: number;
  negativeCount: number;
  score: number;
  tier: "good" | "caution" | "avoid";
  breakdown: unknown;
  recentSignals: unknown[];
}

function tierVariant(tier: TrustResponse["tier"]): "book" | "negotiate" | "skip" {
  if (tier === "good") return "book";
  if (tier === "caution") return "negotiate";
  return "skip";
}

export function TrustBadge({
  brokerMc,
  className,
  size = "default",
}: {
  brokerMc: string | null | undefined;
  className?: string;
  size?: "default" | "sm";
}) {
  const { t } = useT();
  const mc = (brokerMc ?? "").trim();
  const { data, isLoading, isError } = useQuery<TrustResponse>({
    queryKey: ["/api/broker-trust", mc],
    queryFn: () => apiJson<TrustResponse>("GET", `/api/broker-trust/${encodeURIComponent(mc)}`),
    enabled: mc.length > 0,
    staleTime: 60_000,
  });

  if (!mc) return null;

  const textSize = size === "sm" ? "text-[10px]" : "text-xs";

  if (isLoading) {
    return (
      <span
        className={cn(
          "inline-flex h-5 w-16 animate-pulse rounded-md bg-muted",
          className,
        )}
        aria-hidden
      />
    );
  }

  // A failed fetch is NOT "no data" — surface it distinctly so a load error
  // is never mistaken for a legitimately-empty broker history.
  if (isError) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-muted px-2 py-0.5 font-medium text-destructive",
          textSize,
          className,
        )}
        title={t("dispatch.TrustBadge.errorTooltip")}
      >
        <ShieldAlert className="h-3 w-3" />
        {t("dispatch.TrustBadge.errorLabel")}
      </span>
    );
  }

  // Successful fetch with no signals yet — show a muted "no data" chip.
  // A malformed score (NaN/null/non-numeric) is also treated as "no data" so a
  // bad payload never renders as e.g. "Trust: NaN".
  if (!data || data.totalSignals === 0 || !Number.isFinite(data.score)) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 font-medium text-muted-foreground",
          textSize,
          className,
        )}
        title={t("dispatch.TrustBadge.noDataTooltip")}
      >
        <ShieldQuestion className="h-3 w-3" />
        {t("dispatch.TrustBadge.trustLabel")}: —
      </span>
    );
  }

  return (
    <StatusBadge
      variant={tierVariant(data.tier)}
      dot
      className={cn(textSize, className)}
      title={t("dispatch.TrustBadge.signalsTooltip", {
        total: data.totalSignals,
        positive: data.positiveCount,
        negative: data.negativeCount,
      })}
    >
      {t("dispatch.TrustBadge.trustLabel")}: {Math.round(Math.min(100, Math.max(0, data.score)))}
    </StatusBadge>
  );
}
