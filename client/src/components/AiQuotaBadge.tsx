import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "@/lib/queryClient";
import { useAuth } from "@/lib/use-auth";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/i18n";

interface AiQuota {
  usedToday: number;
  dailyFree: number;
  remainingToday: number;
  credits: number;
}

/**
 * Header badge: today's remaining AI requests for the logged-in user (driver
 * receipt-OCR + dispatcher AI-recommend share one per-user DAILY quota).
 *
 * Credits are per-carrier (scoped to the carrier a pack was bought for), so:
 *   - driver     -> has exactly one carrier (linkedClientId); we scope the query
 *                   to it so the credit number + buy affordance match the spend
 *                   gate. Buy tops up that carrier (POST /api/me/ai-credits/purchase).
 *   - dispatcher -> serves many carriers and the global header has no "active"
 *                   one, so a summed credit total would mislead (the gate spends a
 *                   per-carrier bucket). Here we show ONLY the per-user daily
 *                   quota; per-carrier credits + buy live in the cockpit carrier
 *                   panel, where the clientId is known.
 */
export function AiQuotaBadge() {
  const { user } = useAuth();
  const { t } = useT();
  const { toast } = useToast();
  const qc = useQueryClient();

  const isDriver = user?.role === "driver";
  // Scope to the driver's single carrier; dispatcher stays unscoped (daily only).
  const clientId = isDriver ? (user?.linkedClientId ?? undefined) : undefined;
  const path = clientId
    ? `/api/ai-quota?clientId=${encodeURIComponent(clientId)}`
    : "/api/ai-quota";

  const q = useQuery<AiQuota>({
    queryKey: ["/api/ai-quota", clientId ?? null],
    queryFn: () => apiJson<AiQuota>("GET", path),
    staleTime: 30_000,
    retry: false,
  });

  const buy = useMutation({
    mutationFn: () =>
      apiJson<{ ok: boolean; pack: number }>("POST", "/api/me/ai-credits/purchase"),
    onSuccess: (r) => {
      toast({ title: t("aiQuota.bought"), description: t("aiQuota.boughtDesc", { pack: r.pack }) });
      qc.invalidateQueries({ queryKey: ["/api/ai-quota"] });
    },
    onError: () => toast({ title: t("aiQuota.buyError"), variant: "destructive" }),
  });

  const data = q.data;
  if (!data) return null;

  // Only the driver (single carrier) can show a truthful credit number here.
  const showCredits = isDriver;
  const left = data.remainingToday + (showCredits ? data.credits : 0);
  const low = left <= 5;
  const cls = low
    ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
    : "bg-primary/10 text-primary";
  const tip =
    t("aiQuota.tooltip", { remaining: data.remainingToday, free: data.dailyFree }) +
    (showCredits && data.credits > 0 ? ` (+${data.credits})` : "");
  const buyCls =
    "whitespace-nowrap rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground disabled:opacity-50";

  return (
    <span className="flex items-center gap-1">
      <span
        className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}
        title={tip}
      >
        AI {data.remainingToday}/{data.dailyFree}
        {showCredits && data.credits > 0 ? ` +${data.credits}` : ""}
      </span>
      {low && isDriver && (
        <button
          type="button"
          className={buyCls}
          disabled={buy.isPending}
          onClick={() => buy.mutate()}
        >
          {buy.isPending ? "…" : t("aiQuota.buy")}
        </button>
      )}
    </span>
  );
}
