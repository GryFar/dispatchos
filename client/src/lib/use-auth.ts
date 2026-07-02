import { useQuery, keepPreviousData } from "@tanstack/react-query";
import type { UserPublic } from "@shared/schema";
import { apiJson, ApiError, queryClient } from "@/lib/queryClient";

/**
 * useAuth — единый источник правды для текущего пользователя на фронте.
 *
 * Загружает GET /api/me.
 *   - 401/403  → пользователь действительно не залогинен → `user: null`.
 *   - 200      → UserPublic.
 *   - 5xx / network / CORS → ТРАНЗИЕНТНАЯ ошибка. НЕ считаем юзера разлогиненным:
 *     удерживаем последнего известного user (`keepPreviousData`) и ретраим,
 *     чтобы кратковременный сбой /api/me не вышвыривал авторизованного юзера
 *     на /login. `isError` отдаётся наружу, чтобы гард мог показать retry-UI.
 *
 * Используется:
 *   - в App.tsx — для роутинга и role guards
 *   - в Topbar — для отображения имени и роли
 *   - в guards — для редиректа на /login при отсутствии user
 */
export function useAuth() {
  const query = useQuery<UserPublic | null>({
    queryKey: ["auth", "me"],
    queryFn: async () => {
      try {
        return await apiJson<UserPublic>("GET", "/api/me");
      } catch (err) {
        // Только настоящий auth-denied (401/403) означает «не залогинен».
        // Всё остальное (5xx/сеть/CORS) — транзиентно, пробрасываем как ошибку,
        // чтобы query ушёл в error-state, а не в «успешно вернул null».
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          return null;
        }
        throw err;
      }
    },
    staleTime: 60_000,
    // Удерживаем предыдущего user'а во время транзиентной ошибки, чтобы
    // query.data не схлопывался в undefined и гард не редиректил на /login.
    placeholderData: keepPreviousData,
    // Авто-восстановление после кратковременного сбоя. 401/403 пришли как
    // `null` (а не throw), так что сюда попадают только транзиентные ошибки.
    retry: (failureCount) => failureCount < 2,
  });

  return {
    user: query.data ?? null,
    isAuthenticated: Boolean(query.data),
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

/** Force-refresh the cached /api/me (call after a profile update for the SAME user). */
export async function refreshAuth() {
  await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
}

/**
 * Wipe the entire react-query cache, then refetch /api/me.
 *
 * MUST be called on logout AND after a successful login, so that no tenant-scoped
 * data cached by a previous session (loads/clients/users/documents/billing/PII)
 * can be served to the next user on the same SPA tab. `refreshAuth()` alone only
 * invalidates ['auth','me'] and leaves every other cached query in memory.
 */
export async function clearAuthCache() {
  // Drop all cached queries/mutations from the previous session.
  queryClient.clear();
  // Re-establish the current auth state for the new (or absent) session.
  await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
}
