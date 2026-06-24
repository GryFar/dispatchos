import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertTriangle,
  Loader2,
  LogOut,
  MapPin,
  RefreshCw,
  Sparkles,
  Truck,
  Package,
} from "lucide-react";
import type { Load } from "@shared/schema";
import { apiJson } from "@/lib/queryClient";
import { formatMoney, formatMiles, formatMc } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/dispatch/StatusBadge";
import { EmptyState } from "@/components/dispatch/EmptyState";
import { useT } from "@/lib/i18n";

// ---------------------------------------------------------------------------
// Killer #6 — Multi-Driver Cockpit. Single-screen terminal: every assigned
// carrier (location/HOS/alerts), the top available loads, and scored
// carrier→load pairings. Auto-refreshes every 30s. Read-only for now;
// drag-and-drop assign is a later iteration.
// ---------------------------------------------------------------------------

const REFRESH_MS = 30_000;

interface CockpitCarrier {
  id: string;
  name: string;
  mc: string;
  equipment: string;
  status: string | null;
  locationCity: string | null;
  locationState: string | null;
  locationUpdatedAt: string | null;
  hoursAvailable: number | null;
  activeLoadsCount: number;
  activeDriversCount: number;
  alerts: string[];
  driverId: string | null;
  driverName: string | null;
  driverStatus: string | null;
}

interface CockpitSuggestion {
  clientId: string;
  clientName: string;
  loadId: string;
  score: number;
  verdict: string;
  estimatedNet: number;
  lane: string;
  // Outbound-market strength at the destination (0..100). Low = the load
  // delivers into a soft freight market (likely deadhead / wait for next load).
  backhaulScore: number;
}

interface CockpitResponse {
  generatedAt: string;
  carriers: CockpitCarrier[];
  topLoads: Load[];
  suggestions: CockpitSuggestion[];
}
interface AiRecommendation {
  recommendedLoadId: string | null;
  reasoning: string;
  watchOuts: string[];
  confidence: number;
}
export default function DispatchCockpitPage() {
  const { t } = useT();
  const { data, isLoading, isFetching, dataUpdatedAt, refetch } =
    useQuery<CockpitResponse>({
      queryKey: ["/api/dispatch/cockpit"],
      queryFn: () => apiJson("GET", "/api/dispatch/cockpit"),
      refetchInterval: REFRESH_MS,
    });

  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("dispatch.cockpit.header_sub")}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("dispatch.cockpit.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("dispatch.cockpit.subtitle")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">
            Updated <RelativeClock since={dataUpdatedAt} />
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            Refresh
          </Button>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Column 1 — Carriers */}
        <section className="space-y-2">
          <ColumnHeader
            icon={<Truck className="h-4 w-4" />}
            label={t("dispatch.cockpit.carrier.title")}
            count={data.carriers.length}
          />
          {data.carriers.length === 0 ? (
            <EmptyState
              icon={<Truck className="h-5 w-5" />}
              title={t("dispatch.cockpit.empty")}
              description={t("dispatch.cockpit.empty_desc")}
            />
          ) : (
            data.carriers.map((c) => (
              <CarrierCard key={`${c.id}-${c.driverId ?? "none"}`} carrier={c} />
            ))
          )}
        </section>

        {/* Column 2 — Top loads */}
        <section className="space-y-2">
          <ColumnHeader
            icon={<Package className="h-4 w-4" />}
            label={t("dispatch.loads.title")}
            count={data.topLoads.length}
          />
          {data.topLoads.length === 0 ? (
            <EmptyState
              icon={<Package className="h-5 w-5" />}
              title={t("dispatch.loads.empty")}
              description={t("dispatch.loads.empty_desc")}
            />
          ) : (
            data.topLoads.map((l) => <TopLoadCard key={l.id} load={l} />)
          )}
        </section>

        {/* Column 3 — AI suggestions */}
        <section className="space-y-2">
          <ColumnHeader
            icon={<Sparkles className="h-4 w-4" />}
            label="Suggestions"
            count={data.suggestions.length}
          />
          {data.suggestions.length === 0 ? (
            <EmptyState
              icon={<Sparkles className="h-5 w-5" />}
              title={t("dispatch.cockpit.empty")}
              description={t("dispatch.cockpit.empty_desc")}
            />
          ) : (
            data.suggestions.map((s) => (
              <SuggestionCard key={`${s.clientId}-${s.loadId}`} suggestion={s} />
            ))
          )}
        </section>
      </div>

      <p className="px-1 pb-2 text-center text-[11px] text-muted-foreground">
        Auto-refresh every 30 seconds
      </p>
    </div>
  );
}

function ColumnHeader({
  icon,
  label,
  count,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <div className="flex items-center gap-2 px-1 pb-1">
      <span className="text-muted-foreground">{icon}</span>
      <h2 className="text-sm font-semibold tracking-tight">{label}</h2>
      <span className="rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground">
        {count}
      </span>
    </div>
  );
}

function statusVariant(status: string | null) {
  if (status === "empty") return "pending" as const;
  if (status === "loaded") return "active" as const;
  return "info" as const;
}

function CarrierCard({ carrier }: { carrier: CockpitCarrier }) {
  const hasAlerts = carrier.alerts.length > 0;
  return (
    <Card className="p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {carrier.driverName ?? carrier.name}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {carrier.driverName ? `${carrier.name} - ` : ""}
            <span className="font-mono">{formatMc(carrier.mc)}</span>
          </p>
        </div>
        <StatusBadge variant={statusVariant(carrier.status)} className="shrink-0">
          {carrier.status === "empty"
            ? "Empty"
            : carrier.status === "loaded"
              ? "Loaded"
              : "—"}
        </StatusBadge>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {(carrier.locationCity || carrier.locationState) && (
          <span className="inline-flex items-center gap-1">
            <MapPin className="h-3 w-3" />
            {[carrier.locationCity, carrier.locationState].filter(Boolean).join(", ")}
          </span>
        )}
        {typeof carrier.hoursAvailable === "number" && (
          <span>HOS: {carrier.hoursAvailable}h</span>
        )}
        {carrier.equipment && <span>{carrier.equipment.replace(/_/g, " ")}</span>}
      </div>

      <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
        <span>Loads: {carrier.activeLoadsCount}</span>
        <span>Drivers: {carrier.activeDriversCount}</span>
      </div>

      {hasAlerts && (
        <ul className="mt-2 space-y-1">
          {carrier.alerts.map((a, i) => (
            <li
              key={i}
              className="flex items-center gap-1.5 rounded-md bg-warning/10 px-2 py-1 text-[11px] font-medium text-warning"
            >
              <AlertTriangle className="h-3 w-3 shrink-0" />
              {a}
            </li>
          ))}
        </ul>
      )}
      <CarrierAiPanel clientId={carrier.id} />
    </Card>
  );
}
function CarrierAiPanel({ clientId }: { clientId: string }) {
  const { t } = useT();
  const [state, setState] = useState<{
    loading: boolean;
    rec?: AiRecommendation;
    failed?: boolean;
  }>({ loading: false });

  async function runAi() {
    setState({ loading: true });
    try {
      const rec = await apiJson<AiRecommendation>("POST", "/api/dispatch/ai-recommend", {
        clientId,
      });
      setState({ loading: false, rec });
    } catch {
      setState({ loading: false, failed: true });
    }
  }

  return (
    <div className="mt-2 border-t border-border/60 pt-2">
      <Button
        variant="outline"
        size="sm"
        className="h-7 w-full text-[11px]"
        onClick={runAi}
        disabled={state.loading}
      >
        {state.loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Sparkles className="h-3.5 w-3.5" />
        )}
        AI analysis
      </Button>
      {state.rec && (
        <div className="mt-2 space-y-1.5 rounded-md bg-primary/5 p-2 text-[11px]">
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
            Confidence: {Math.round(state.rec.confidence * 100)}%
          </p>
        </div>
      )}
      {state.failed && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {t("dispatch.cockpit.ai.error")}
        </p>
      )}
    </div>
  );
}
function TopLoadCard({ load }: { load: Load }) {
  return (
    <Link href={`/loads/${load.id}`}>
      <Card className="cursor-pointer p-3 transition-colors hover:bg-muted/40">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 text-sm font-medium">
            {load.originCity}, {load.originState}
            <span className="mx-1 text-muted-foreground">→</span>
            {load.destinationCity}, {load.destinationState}
          </p>
          <p className="shrink-0 font-mono text-sm font-semibold">
            {formatMoney(load.rate)}
          </p>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {load.brokerName} · {formatMiles(load.loadedMiles)} mi ·{" "}
          {load.equipment.replace(/_/g, " ")}
        </p>
      </Card>
    </Link>
  );
}

function verdictVariant(verdict: string) {
  if (verdict === "book") return "book" as const;
  if (verdict === "negotiate") return "negotiate" as const;
  if (verdict === "skip") return "skip" as const;
  return "info" as const;
}

function SuggestionCard({ suggestion }: { suggestion: CockpitSuggestion }) {
  return (
    <Link href={`/loads/${suggestion.loadId}`}>
      <Card className="cursor-pointer p-3 transition-colors hover:bg-muted/40">
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-sm font-medium">
            {suggestion.clientName}
          </p>
          <span className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-primary">
            {suggestion.score}
          </span>
        </div>
        <p className="mt-1 truncate text-[11px] text-muted-foreground">
          {suggestion.lane}
        </p>
        <div className="mt-2 flex items-center justify-between gap-2">
          <StatusBadge variant={verdictVariant(suggestion.verdict)} dot>
            {suggestion.verdict}
          </StatusBadge>
          <div className="flex items-center gap-2">
            <span
              className={`flex items-center gap-0.5 text-[11px] tabular-nums ${
                suggestion.backhaulScore < 55 ? "text-amber-600" : "text-muted-foreground"
              }`}
              title="Outbound freight market at destination (higher is easier to get the next load)"
            >
              <LogOut className="h-3 w-3" />
              {suggestion.backhaulScore}
            </span>
            <span className="text-[11px] text-muted-foreground">
              ≈ {formatMoney(suggestion.estimatedNet)}
            </span>
          </div>
        </div>
      </Card>
    </Link>
  );
}

function RelativeClock({ since }: { since: number }) {
  const { t } = useT();
  const sec = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (sec < 5) return <>{t("dispatch.cockpit.just_now")}</>;
  if (sec < 60) return <>{t("dispatch.cockpit.sec_ago", { n: sec })}</>;
  const min = Math.round(sec / 60);
  return <>{t("dispatch.cockpit.min_ago", { n: min })}</>;
}
