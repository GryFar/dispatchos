import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sparkles, Loader2, AlertTriangle, LogOut, LayoutGrid } from "lucide-react";
import { apiJson, ApiError } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatMoney, formatMiles } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/dispatch/StatusBadge";
import { EmptyState } from "@/components/dispatch/EmptyState";
import { useT } from "@/lib/i18n";

// ---------------------------------------------------------------------------
// WAVE B — owner-only scored load board + AI advisor.
// Read-only views over GET /api/me/loads/scored (persist=false scoring) and
// POST /api/me/loads/ai-recommend (quota/rate-guarded). Mirrors the dispatcher
// cockpit's SuggestionCard / CarrierAiPanel patterns but scoped to the owner's
// own carrier (no clientId in any request — derived server-side from session).
// ---------------------------------------------------------------------------

interface ScoredItem {
  id: string;
  originCity: string;
  originState: string;
  destinationCity: string;
  destinationState: string;
  rate: number;
  loadedMiles: number;
  equipment: string;
  pickupAt: string;
  deliveryAt: string;
  brokerName: string | null;
  dispatchScore: number;
  verdict: string;
  estimatedNet: number;
  netPpmTotal: number;
  deadheadMiles: number;
  backhaulScore: number;
  counterOffer: number | null;
  warnings: string[];
}
interface ScoredResponse {
  generatedAt: string;
  items: ScoredItem[];
}
interface AiRecommendation {
  recommendedLoadId: string | null;
  reasoning: string;
  watchOuts: string[];
  confidence: number;
}

function verdictVariant(verdict: string) {
  if (verdict === "book") return "book" as const;
  if (verdict === "negotiate") return "negotiate" as const;
  if (verdict === "skip") return "skip" as const;
  return "info" as const;
}

export default function OwnerBoardPage() {
  const { t } = useT();
  const { data, isLoading, error } = useQuery<ScoredResponse>({
    queryKey: ["me", "loads", "scored"],
    queryFn: () => apiJson<ScoredResponse>("GET", "/api/me/loads/scored"),
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-5">
      <header>
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <LayoutGrid className="h-5 w-5 text-primary" />
          {t("driver.owner.board.title")}
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {t("driver.owner.board.subtitle")}
        </p>
      </header>

      <OwnerAiPanel hasLoads={Boolean(data?.items.length)} />

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : error ? (
        <Card className="border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium">{t("common.error")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {(error as Error).message}
          </p>
        </Card>
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          icon={<LayoutGrid />}
          title={t("driver.owner.board.emptyTitle")}
          description={t("driver.owner.board.emptyDesc")}
        />
      ) : (
        <ul className="space-y-3">
          {data.items.map((load) => (
            <li key={load.id}>
              <ScoredLoadCard load={load} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ScoredLoadCard({ load }: { load: ScoredItem }) {
  const { t } = useT();
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-sm font-medium">
          {load.originCity}, {load.originState}
          <span className="mx-1 text-muted-foreground">→</span>
          {load.destinationCity}, {load.destinationState}
        </p>
        <span className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-primary">
          {load.dispatchScore}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {load.brokerName ?? "—"} · {formatMiles(load.loadedMiles)} mi ·{" "}
        {load.equipment.replace(/_/g, " ")}
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <StatusBadge variant={verdictVariant(load.verdict)} dot>
          {t(`driver.owner.verdict.${load.verdict}`)}
        </StatusBadge>
        <div className="flex items-center gap-3">
          <span
            className={`flex items-center gap-0.5 text-[11px] tabular-nums ${
              load.backhaulScore < 55 ? "text-amber-600" : "text-muted-foreground"
            }`}
            title={t("driver.owner.board.backhaulTooltip")}
          >
            <LogOut className="h-3 w-3" />
            {load.backhaulScore}
          </span>
          <span className="font-mono text-sm font-semibold">
            {formatMoney(load.rate)}
          </span>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>
          {t("driver.owner.board.estNet")}:{" "}
          <span className="font-mono text-foreground">≈ {formatMoney(load.estimatedNet)}</span>
        </span>
        <span>
          {t("driver.owner.board.netPpm")}:{" "}
          <span className="font-mono text-foreground">{load.netPpmTotal.toFixed(2)}</span>
        </span>
        {load.counterOffer != null && (
          <span>
            {t("driver.owner.board.counter")}:{" "}
            <span className="font-mono text-foreground">{formatMoney(load.counterOffer)}</span>
          </span>
        )}
      </div>
      {load.warnings.length > 0 && (
        <ul className="mt-2 space-y-1">
          {load.warnings.map((w, i) => (
            <li
              key={i}
              className="flex items-center gap-1.5 rounded-md bg-warning/10 px-2 py-1 text-[11px] font-medium text-warning"
            >
              <AlertTriangle className="h-3 w-3 shrink-0" />
              {w}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// AI advisor — mirrors the cockpit CarrierAiPanel, but POSTs to
// /api/me/loads/ai-recommend (no clientId body) and tops up via
// /api/me/ai-credits/purchase. Explicit tap → spends AI quota (never auto).
// ---------------------------------------------------------------------------
function OwnerAiPanel({ hasLoads }: { hasLoads: boolean }) {
  const { t } = useT();
  const { toast } = useToast();
  const [state, setState] = useState<{
    loading: boolean;
    rec?: AiRecommendation;
    failed?: boolean;
    quotaExhausted?: boolean;
    quotaMsg?: string;
  }>({ loading: false });
  const [buying, setBuying] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function runAi() {
    setState({ loading: true });
    try {
      const rec = await apiJson<AiRecommendation>("POST", "/api/me/loads/ai-recommend", {});
      if (mountedRef.current) setState({ loading: false, rec });
    } catch (err) {
      const code =
        err instanceof ApiError && err.body && typeof err.body === "object" && "code" in err.body
          ? (err.body as { code?: unknown }).code
          : undefined;
      const quotaExhausted =
        err instanceof ApiError && err.status === 429 && code === "ai_quota_exceeded";
      if (mountedRef.current) {
        setState({
          loading: false,
          failed: !quotaExhausted,
          quotaExhausted,
          quotaMsg: quotaExhausted && err instanceof ApiError ? err.message : undefined,
        });
      }
    }
  }

  async function buyCredits() {
    setBuying(true);
    try {
      const r = await apiJson<{ ok: boolean; pack: number }>(
        "POST",
        "/api/me/ai-credits/purchase",
        {},
      );
      toast({ title: t("aiQuota.bought"), description: t("aiQuota.boughtDesc", { pack: r.pack }) });
      if (mountedRef.current) setState((s) => ({ ...s, quotaExhausted: false, quotaMsg: undefined }));
    } catch {
      toast({ title: t("aiQuota.buyError"), variant: "destructive" });
    } finally {
      if (mountedRef.current) setBuying(false);
    }
  }

  return (
    <Card className="p-4">
      <p className="flex items-center gap-2 text-sm font-medium">
        <Sparkles className="h-4 w-4 text-primary" />
        {t("driver.owner.advisor.title")}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {t("driver.owner.advisor.subtitle")}
      </p>
      <Button
        variant="outline"
        size="sm"
        className="mt-3 w-full gap-1.5"
        onClick={runAi}
        disabled={state.loading || !hasLoads}
      >
        {state.loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Sparkles className="h-4 w-4" />
        )}
        {t("driver.owner.advisor.run")}
      </Button>
      {!hasLoads && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {t("driver.owner.advisor.needLoads")}
        </p>
      )}
      {state.rec && (
        <div className="mt-3 space-y-1.5 rounded-md bg-primary/5 p-3 text-xs">
          <p className="leading-snug text-foreground">🤖 {state.rec.reasoning}</p>
          {state.rec.watchOuts.length > 0 && (
            <ul className="space-y-0.5 text-muted-foreground">
              {state.rec.watchOuts.map((w, i) => (
                <li key={i} className="flex gap-1">
                  <span className="shrink-0">•</span>
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[10px] text-muted-foreground">
            {t("driver.owner.advisor.confidence")}: {Math.round(state.rec.confidence * 100)}%
          </p>
        </div>
      )}
      {state.quotaExhausted && (
        <div className="mt-3 space-y-1.5 rounded-md bg-rose-500/10 p-3 text-xs">
          <p className="leading-snug text-rose-600 dark:text-rose-400">
            {state.quotaMsg ?? t("driver.owner.advisor.error")}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={buyCredits}
            disabled={buying}
          >
            {buying ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            {t("aiQuota.buy")}
          </Button>
        </div>
      )}
      {state.failed && (
        <p className="mt-3 text-xs text-muted-foreground">
          {t("driver.owner.advisor.error")}
        </p>
      )}
    </Card>
  );
}
