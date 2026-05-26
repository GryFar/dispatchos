import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AlertTriangle, Loader2, Truck } from "lucide-react";
import type { LoginResponse } from "@shared/schema";
import { ApiError, apiJson } from "@/lib/queryClient";
import { refreshAuth, useAuth } from "@/lib/use-auth";
import { defaultRouteForRole } from "@/components/role-gate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * Login страница — единая для всех ролей.
 *
 * UX:
 *   1) email + password → submit
 *   2) если backend ответил 401 "Invalid 2FA token" → показать TOTP поле,
 *      пользователь вводит код и подаёт повторно
 *   3) на успех → refreshAuth + редирект по role
 *
 * URL params:
 *   ?reason=blocked → показать алерт (юзер пришёл после автоматического
 *      редиректа из RoleGate когда его заблокировали)
 *   ?reason=expired → "сессия истекла, войдите снова"
 *   ?redirect=/admin/users → куда после логина (вместо дефолтного)
 */

const schema = z.object({
  email: z.string().email("Введите корректный email"),
  password: z.string().min(1, "Введите пароль"),
  token: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

export default function LoginPage() {
  const [, setLocation] = useLocation();
  const { user, isLoading: authLoading } = useAuth();
  const [needsTotp, setNeedsTotp] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "", token: "" },
  });

  // Read query params from hash (after `?`).
  const params = parseHashSearch();
  const reason = params.get("reason");
  // Audit High #18 — open-redirect hardening: redirect must be a local app
  // path (starts with `/`, NOT `//` or `/\` which are protocol-relative).
  // Any non-conforming value is silently dropped to default-for-role.
  const redirectTo = sanitizeRedirect(params.get("redirect"));

  // If user is already authenticated, send them to their default portal.
  useEffect(() => {
    if (!authLoading && user) {
      setLocation(redirectTo || defaultRouteForRole(user.role));
    }
  }, [user, authLoading, setLocation, redirectTo]);

  async function onSubmit(values: FormValues) {
    setGlobalError(null);
    try {
      const data = await apiJson<LoginResponse>("POST", "/api/auth/login", {
        email: values.email,
        password: values.password,
        token: values.token || undefined,
      });
      await refreshAuth();
      setLocation(redirectTo || data.redirect || defaultRouteForRole(data.role));
    } catch (err) {
      if (err instanceof ApiError) {
        // TOTP fork.
        if (err.status === 401 && /2fa|token/i.test(err.message)) {
          setNeedsTotp(true);
          setGlobalError("Введите 6-значный код из приложения-аутентификатора.");
          return;
        }
        if (err.status === 401) {
          setGlobalError("Неверный email или пароль.");
          return;
        }
        if (err.status === 403) {
          setGlobalError("Учётная запись заблокирована. Свяжитесь с администратором.");
          return;
        }
        setGlobalError(err.message);
        return;
      }
      setGlobalError("Не удалось подключиться к серверу.");
    }
  }

  return (
    <AuthShell>
      <div className="mb-6 space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight">Вход в DispatchOS</h1>
        <p className="text-sm text-muted-foreground">
          Используйте email и пароль. Если включён 2FA — также код из аутентификатора.
        </p>
      </div>

      {reason === "blocked" && (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>Доступ к учётной записи приостановлен.</AlertDescription>
        </Alert>
      )}
      {reason === "expired" && (
        <Alert className="mb-4">
          <AlertDescription>Сессия истекла. Войдите снова.</AlertDescription>
        </Alert>
      )}
      {globalError && (
        <Alert variant={needsTotp ? "default" : "destructive"} className="mb-4">
          <AlertDescription>{globalError}</AlertDescription>
        </Alert>
      )}

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            autoFocus={!needsTotp}
            placeholder="you@example.com"
            readOnly={needsTotp}
            {...form.register("email")}
          />
          {form.formState.errors.email && (
            <p className="text-xs text-destructive">{form.formState.errors.email.message}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Пароль</Label>
            <Link href="/forgot-password" className="text-xs text-muted-foreground hover:text-foreground">
              Забыли пароль?
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            readOnly={needsTotp}
            {...form.register("password")}
          />
          {form.formState.errors.password && (
            <p className="text-xs text-destructive">{form.formState.errors.password.message}</p>
          )}
        </div>

        {needsTotp && (
          <div className="space-y-1.5">
            <Label htmlFor="token">Код из аутентификатора</Label>
            <Input
              id="token"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              autoFocus
              className="font-mono tracking-widest text-center text-lg"
              {...form.register("token")}
            />
            <p className="text-xs text-muted-foreground">
              6 цифр из Google Authenticator / 1Password / Authy.
            </p>
          </div>
        )}

        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Войти
        </Button>
      </form>

      <div className="mt-6 text-center text-xs text-muted-foreground">
        Нет аккаунта? <Link href="/signup" className="text-foreground underline-offset-4 hover:underline">Войти по invite-коду</Link>
      </div>
    </AuthShell>
  );
}

/** Shared wrapper for /login, /signup, /forgot-password — centered card on slate bg. */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-12">
      {/* Aurora background — emerald + blue radial spots, very subtle. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-60 dark:opacity-40"
        style={{
          backgroundImage:
            "radial-gradient(ellipse 60% 50% at 30% 30%, hsl(var(--primary) / 0.10), transparent 60%), radial-gradient(ellipse 50% 50% at 70% 70%, hsl(var(--chart-2) / 0.08), transparent 60%)",
        }}
      />
      <div className="relative w-full max-w-sm page-enter">
        <div className="mb-6 flex items-center justify-center gap-2 text-foreground">
          <span className="relative flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-md">
            <span className="absolute inset-0 rounded-lg bg-primary/40 blur-md" aria-hidden />
            <Truck className="relative h-5 w-5" />
          </span>
          <span className="text-lg font-semibold tracking-tight">DispatchOS</span>
        </div>
        <Card className="shadow-pop">
          <CardContent className="p-6">{children}</CardContent>
        </Card>
        <p className="mt-6 text-center text-xs text-muted-foreground">
          DispatchOS — внутренний диспетчерский сервис. Доступ только по приглашениям.
        </p>
      </div>
    </div>
  );
}

function parseHashSearch(): URLSearchParams {
  const hash = window.location.hash || "";
  const qIndex = hash.indexOf("?");
  return new URLSearchParams(qIndex >= 0 ? hash.slice(qIndex) : "");
}

/**
 * Validate `?redirect=...` query against an allowlist (Audit High #18).
 *
 * Acceptable: local absolute paths starting with `/`, optionally followed by
 * any non-backslash character. We reject:
 *  - `//evil.com/...`              — protocol-relative external URL
 *  - `/\\evil.com/...`             — backslash-prefixed (browser quirks)
 *  - `http://...`, `https://...`   — absolute external URL
 *  - empty / null
 * Returns the path verbatim on success, or null on rejection.
 */
function sanitizeRedirect(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  // Disallow any whitespace / control chars (HTTP header injection paranoia).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\s]/.test(raw)) return null;
  return raw;
}
