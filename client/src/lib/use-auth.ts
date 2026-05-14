import { useQuery } from "@tanstack/react-query";
import type { UserPublic } from "@shared/schema";
import { apiJson, ApiError, queryClient } from "@/lib/queryClient";

/**
 * useAuth — единый источник правды для текущего пользователя на фронте.
 *
 * Загружает GET /api/me. Если 401 — возвращает `user: null` (не залогинен).
 * Если 200 — возвращает UserPublic. Сетевые ошибки бросает.
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
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  return {
    user: query.data ?? null,
    isAuthenticated: Boolean(query.data),
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

/** Force-refresh the cached /api/me (call after login/logout/profile update). */
export async function refreshAuth() {
  await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
}
