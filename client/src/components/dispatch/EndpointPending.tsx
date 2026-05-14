import { Clock, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * EndpointPending — баннер для экранов, чей backend будет реализован в Phase 3.
 *
 * Показывается, когда useQuery вернул 404 на endpoint из списка `/api/admin/*`.
 * Никакой ошибки, никаких toast'ов — просто аккуратный hero с пояснением.
 */
export function EndpointPending({
  endpoint,
  className,
  description,
}: {
  endpoint: string;
  description?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-border bg-card shadow-card",
        className,
      )}
    >
      <div
        className="absolute inset-0 opacity-50"
        aria-hidden
        style={{
          backgroundImage:
            "radial-gradient(ellipse at 25% 30%, hsl(var(--primary) / 0.10), transparent 55%), radial-gradient(ellipse at 75% 70%, hsl(var(--chart-2) / 0.07), transparent 55%)",
        }}
      />
      <div className="relative flex flex-col items-center gap-4 px-6 py-14 text-center">
        <div className="relative">
          <div className="absolute inset-0 -m-3 rounded-full bg-primary/15 blur-xl" aria-hidden />
          <div className="relative flex h-14 w-14 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-primary">
            <Clock className="h-6 w-6" />
          </div>
        </div>
        <div className="space-y-1.5">
          <p className="text-sm font-semibold">Раздел будет доступен после Phase 3</p>
          <p className="mx-auto max-w-md text-xs leading-relaxed text-muted-foreground">
            {description ??
              "Endpoint ещё не реализован на сервере. UI готов и подключён — как только бэкендер выкатит, данные появятся автоматически."}
          </p>
          <p className="pt-1 font-mono text-[11px] text-muted-foreground">
            <ExternalLink className="mr-1 inline-block h-3 w-3" />
            {endpoint}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Helper: returns true if the React Query error indicates a not-yet-implemented endpoint.
 *
 * Backend should return 404 JSON for unknown /api/* paths. In dev with Vite,
 * however, requests to unknown /api/* fall through Express и попадают в Vite SPA-fallback,
 * который возвращает index.html со статусом 200. `apiJson` пытается распарсить HTML
 * как JSON и ловит SyntaxError. Признак — текст ошибки начинается с "Unexpected token '<'".
 *
 * Также детектим явный 404 (когда backend всё-таки настроен правильно — после Phase 3).
 */
import { ApiError } from "@/lib/queryClient";
export function isEndpointMissing(error: unknown): boolean {
  if (error instanceof ApiError && error.status === 404) return true;
  if (error instanceof SyntaxError && /Unexpected token '<'/.test(error.message)) return true;
  if (error instanceof Error && /Unexpected token '<'/.test(error.message)) return true;
  return false;
}
