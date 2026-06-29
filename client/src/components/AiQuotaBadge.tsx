import { useQuery } from "@tanstack/react-query";
import { apiJson } from "@/lib/queryClient";

interface AiQuota {
  usedToday: number;
  dailyFree: number;
  remainingToday: number;
  credits: number;
}

/**
 * Header badge: today's remaining AI requests for the logged-in user.
 * Driver (receipt OCR) + dispatcher (AI recommend) share one per-user daily
 * quota. Renders nothing until loaded / for roles the endpoint doesn't serve.
 */
export function AiQuotaBadge() {
  const q = useQuery<AiQuota>({
    queryKey: ["/api/ai-quota"],
    queryFn: () => apiJson<AiQuota>("GET", "/api/ai-quota"),
    staleTime: 30_000,
    retry: false,
  });
  const data = q.data;
  if (!data) return null;
  const left = data.remainingToday + data.credits;
  const cls =
    left <= 5
      ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
      : "bg-primary/10 text-primary";
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}
      title={`AI-запросы сегодня: осталось ${data.remainingToday} из ${data.dailyFree}${data.credits > 0 ? `, докуплено ${data.credits}` : ""}`}
    >
      AI {data.remainingToday}/{data.dailyFree}
      {data.credits > 0 ? ` +${data.credits}` : ""}
    </span>
  );
}
