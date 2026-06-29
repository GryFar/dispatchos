import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "@/lib/queryClient";
import { useAuth } from "@/lib/use-auth";
import { useToast } from "@/hooks/use-toast";

interface AiQuota {
  usedToday: number;
  dailyFree: number;
  remainingToday: number;
  credits: number;
}

/**
 * Header badge: today's remaining AI requests for the logged-in user
 * (driver receipt-OCR + dispatcher AI-recommend share one per-user daily quota).
 * When a DRIVER is nearly out, shows a "докупить" button — charges their carrier's
 * Stripe customer; credits land via the invoice.payment_succeeded webhook.
 */
export function AiQuotaBadge() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const q = useQuery<AiQuota>({
    queryKey: ["/api/ai-quota"],
    queryFn: () => apiJson<AiQuota>("GET", "/api/ai-quota"),
    staleTime: 30_000,
    retry: false,
  });
  const buy = useMutation({
    mutationFn: () =>
      apiJson<{ ok: boolean; pack: number; priceCents: number }>(
        "POST",
        "/api/me/ai-credits/purchase",
      ),
    onSuccess: (r) => {
      toast({
        title: "Оплата оформлена",
        description: `+${r.pack} AI-запросов появятся после подтверждения оплаты.`,
      });
      qc.invalidateQueries({ queryKey: ["/api/ai-quota"] });
    },
    onError: () =>
      toast({ title: "Не удалось оформить докупку", variant: "destructive" }),
  });

  const data = q.data;
  if (!data) return null;
  const left = data.remainingToday + data.credits;
  const low = left <= 5;
  const cls = low
    ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
    : "bg-primary/10 text-primary";

  return (
    <span className="flex items-center gap-1">
      <span
        className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}
        title={`AI-запросы сегодня: осталось ${data.remainingToday} из ${data.dailyFree}${data.credits > 0 ? `, докуплено ${data.credits}` : ""}`}
      >
        AI {data.remainingToday}/{data.dailyFree}
        {data.credits > 0 ? ` +${data.credits}` : ""}
      </span>
      {low && user?.role === "driver" && (
        <button
          type="button"
          onClick={() => buy.mutate()}
          disabled={buy.isPending}
          className="whitespace-nowrap rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {buy.isPending ? "…" : "докупить"}
        </button>
      )}
    </span>
  );
}
