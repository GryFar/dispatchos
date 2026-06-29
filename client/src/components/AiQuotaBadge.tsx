import { useState } from "react";
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
interface AssignedClient {
  id: string;
  name: string;
}

/**
 * Header badge: today's remaining AI requests for the logged-in user
 * (driver receipt-OCR + dispatcher AI-recommend share one per-user daily quota).
 * When nearly out, offers a buy-more action:
 *   - driver     -> charges their own carrier (POST /api/me/ai-credits/purchase)
 *   - dispatcher -> picks which assigned carrier to bill (POST /api/dispatch/ai-credits/purchase)
 * Credits land asynchronously via the invoice.payment_succeeded webhook.
 */
export function AiQuotaBadge() {
  const { user } = useAuth();
  const { t } = useT();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [picking, setPicking] = useState(false);

  const q = useQuery<AiQuota>({
    queryKey: ["/api/ai-quota"],
    queryFn: () => apiJson<AiQuota>("GET", "/api/ai-quota"),
    staleTime: 30_000,
    retry: false,
  });

  const isDriver = user?.role === "driver";
  const isDispatcher = user?.role === "dispatcher";

  // Dispatcher only: which assigned carrier to bill. Lazy — fetched once the
  // dispatcher opens the picker, never for drivers.
  const carriers = useQuery<{ items: AssignedClient[] }>({
    queryKey: ["/api/dispatch/clients"],
    queryFn: () => apiJson<{ items: AssignedClient[] }>("GET", "/api/dispatch/clients"),
    enabled: isDispatcher && picking,
    staleTime: 60_000,
    retry: false,
  });

  const buy = useMutation({
    mutationFn: (clientId?: string) =>
      isDispatcher
        ? apiJson<{ ok: boolean; pack: number }>("POST", "/api/dispatch/ai-credits/purchase", { clientId })
        : apiJson<{ ok: boolean; pack: number }>("POST", "/api/me/ai-credits/purchase"),
    onSuccess: (r) => {
      toast({ title: t("aiQuota.bought"), description: t("aiQuota.boughtDesc", { pack: r.pack }) });
      setPicking(false);
      qc.invalidateQueries({ queryKey: ["/api/ai-quota"] });
    },
    onError: () => toast({ title: t("aiQuota.buyError"), variant: "destructive" }),
  });

  const data = q.data;
  if (!data) return null;
  const left = data.remainingToday + data.credits;
  const low = left <= 5;
  const cls = low
    ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
    : "bg-primary/10 text-primary";
  const tip =
    t("aiQuota.tooltip", { remaining: data.remainingToday, free: data.dailyFree }) +
    (data.credits > 0 ? ` (+${data.credits})` : "");
  const buyCls =
    "whitespace-nowrap rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground disabled:opacity-50";

  return (
    <span className="flex items-center gap-1">
      <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`} title={tip}>
        AI {data.remainingToday}/{data.dailyFree}
        {data.credits > 0 ? ` +${data.credits}` : ""}
      </span>

      {low && isDriver && (
        <button type="button" className={buyCls} disabled={buy.isPending} onClick={() => buy.mutate(undefined)}>
          {buy.isPending ? "…" : t("aiQuota.buy")}
        </button>
      )}

      {low && isDispatcher && !picking && (
        <button type="button" className={buyCls} disabled={buy.isPending} onClick={() => setPicking(true)}>
          {t("aiQuota.buy")}
        </button>
      )}

      {low && isDispatcher && picking &&
        (carriers.isLoading || buy.isPending ? (
          <span className="text-xs text-muted-foreground">…</span>
        ) : (
          <select
            className="rounded-full border border-border bg-background px-2 py-0.5 text-xs"
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) buy.mutate(e.target.value);
            }}
          >
            <option value="" disabled>
              {t("aiQuota.pickCarrier")}
            </option>
            {(carriers.data?.items ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        ))}
    </span>
  );
}
