import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldQuestion, Search, Loader2 } from "lucide-react";
import { apiJson } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/dispatch/StatusBadge";
import { EmptyState } from "@/components/dispatch/EmptyState";
import { formatRelativeAgo } from "@/lib/format";
import { useT } from "@/lib/i18n";

// ---------------------------------------------------------------------------
// WAVE B — owner broker-trust lookup. GET /api/me/broker-trust/:mc returns the
// aggregate score + the PUBLIC signal projection only (signalType/positive/
// reportedAt — never notes/clientId/reporter). Cross-tenant-safe by design.
// ---------------------------------------------------------------------------

interface PublicSignal {
  signalType: string;
  positive: boolean;
  reportedAt: string;
}
interface TrustResponse {
  mc: string;
  totalSignals: number;
  positiveCount: number;
  negativeCount: number;
  score: number;
  tier: "good" | "caution" | "avoid";
  breakdown: Record<string, unknown>;
  recentSignals: PublicSignal[];
}

function tierVariant(tier: TrustResponse["tier"]): "book" | "negotiate" | "skip" {
  if (tier === "good") return "book";
  if (tier === "caution") return "negotiate";
  return "skip";
}

export default function OwnerBrokerCheckPage() {
  const { t } = useT();
  const [input, setInput] = useState("");
  const [mc, setMc] = useState("");

  const { data, isLoading, isError } = useQuery<TrustResponse>({
    queryKey: ["me", "broker-trust", mc],
    queryFn: () => apiJson<TrustResponse>("GET", `/api/me/broker-trust/${encodeURIComponent(mc)}`),
    enabled: mc.length > 0,
    staleTime: 60_000,
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setMc(input.trim());
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <ShieldQuestion className="h-5 w-5 text-primary" />
          {t("driver.owner.broker.title")}
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {t("driver.owner.broker.subtitle")}
        </p>
      </header>

      <form onSubmit={submit} className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("driver.owner.broker.mcPlaceholder")}
          inputMode="numeric"
          className="flex-1"
        />
        <Button type="submit" disabled={!input.trim()} className="gap-1.5">
          <Search className="h-4 w-4" />
          {t("driver.owner.broker.check")}
        </Button>
      </form>

      {mc.length === 0 ? (
        <EmptyState
          icon={<ShieldQuestion />}
          title={t("driver.owner.broker.idleTitle")}
          description={t("driver.owner.broker.idleDesc")}
        />
      ) : isLoading ? (
        <Card className="flex items-center justify-center p-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </Card>
      ) : isError ? (
        <Card className="border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium">{t("driver.owner.broker.errorTitle")}</p>
        </Card>
      ) : !data || data.totalSignals === 0 || !Number.isFinite(data.score) ? (
        <EmptyState
          icon={<ShieldQuestion />}
          title={t("driver.owner.broker.noDataTitle", { mc })}
          description={t("driver.owner.broker.noDataDesc")}
        />
      ) : (
        <div className="space-y-4">
          <Card className="p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  MC #{data.mc}
                </p>
                <p className="mt-1 font-mono text-3xl font-semibold">
                  {Math.round(Math.min(100, Math.max(0, data.score)))}
                  <span className="text-base text-muted-foreground">/100</span>
                </p>
              </div>
              <StatusBadge variant={tierVariant(data.tier)} dot>
                {t(`driver.owner.broker.tier.${data.tier}`)}
              </StatusBadge>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
              <div className="rounded-md bg-muted/40 py-2">
                <p className="font-mono text-base font-semibold">{data.totalSignals}</p>
                <p className="text-muted-foreground">{t("driver.owner.broker.total")}</p>
              </div>
              <div className="rounded-md bg-success/10 py-2">
                <p className="font-mono text-base font-semibold text-success">
                  {data.positiveCount}
                </p>
                <p className="text-muted-foreground">{t("driver.owner.broker.positive")}</p>
              </div>
              <div className="rounded-md bg-destructive/10 py-2">
                <p className="font-mono text-base font-semibold text-destructive">
                  {data.negativeCount}
                </p>
                <p className="text-muted-foreground">{t("driver.owner.broker.negative")}</p>
              </div>
            </div>
          </Card>

          {data.recentSignals.length > 0 && (
            <Card className="p-4">
              <p className="text-sm font-medium">{t("driver.owner.broker.recent")}</p>
              <ul className="mt-2 divide-y divide-border">
                {data.recentSignals.map((s, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 py-2 text-xs">
                    <span className="flex items-center gap-2">
                      <span
                        className={`inline-block h-2 w-2 rounded-full ${
                          s.positive ? "bg-success" : "bg-destructive"
                        }`}
                        aria-hidden
                      />
                      {s.signalType.replace(/_/g, " ")}
                    </span>
                    <span className="text-muted-foreground">
                      {formatRelativeAgo(s.reportedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
