import { useEffect, useMemo, useState } from "react";
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
import { useT } from "@/lib/i18n";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
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
 *
 * 2026-05-27 hotfix (Vlad report):
 *  - Bug 1: rate-limit responses (HTTP 429) were swallowed by the catch-all
 *    branch and surfaced as "Неверный email или пароль", which is exactly
 *    the wrong UX when password-manager autofill happens to mis-fire a few
 *    times in a row (the user thinks the password is wrong and tries
 *    harder, locking themselves out further). We now branch on
 *    err.status === 429 and show the dedicated "too many attempts" copy
 *    (text comes from i18n so EN switch covers it too).
 *  - Bug 2: every visible string on this page (titles, alerts, buttons,
 *    AuthShell tagline) was hardcoded in Russian — switching to EN left
 *    the form Russian, which is what the screenshot showed. All strings
 *    now go through `useT()`.
 */

const buildSchema = (t: (key: string) => string) =>
  z.object({
    email: z.string().email(t("signup.validation.emailRequired")),
    password: z.string().min(1, t("signup.validation.passwordRequired")),
    token: z.string().optional(),
  });

export default function LoginPage() {
  const { t } = useT();
  const [, setLocation] = useLocation();
  const { user, isLoading: authLoading } = useAuth();
  const [needsTotp, setNeedsTotp] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  // Recompute schema when language changes so validation messages localize too.
  const schema = useMemo(() => buildSchema(t), [t]);
  type FormValues = z.infer<typeof schema>;

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
        // Audit Critical #4 rate-limit (15-min window, 10 attempts). The
        // limiter answers 429 BEFORE the handler runs, so we MUST surface a
        // distinct message — otherwise the user sees "Invalid credentials"
        // and keeps trying, which deepens the lockout.
        if (err.status === 429) {
          setGlobalError(t("login.errorRateLimit"));
          return;
        }
        // TOTP fork — backend signals 2FA required via
        // `body.code === 'totp_required'` (server hotfix 2026-05-27).
        // The legacy substring match on the message is kept as a fallback
        // for any in-flight deploys that haven't picked up the new code
        // yet, so we don't strand a user on a half-rolled-out version.
        const errBody = err.body as { code?: string } | null;
        const isTotpRequired =
          err.status === 401 &&
          (errBody?.code === "totp_required" ||
            errBody?.code === "totp_invalid" ||
            /2fa|token/i.test(err.message));
        if (isTotpRequired) {
          setNeedsTotp(true);
          setGlobalError(
            errBody?.code === "totp_invalid"
              ? t("login.errorInvalidTotp")
              : t("login.totpAlert"),
          );
          return;
        }
        if (err.status === 401) {
          setGlobalError(t("login.errorInvalid"));
          return;
        }
        if (err.status === 403) {
          setGlobalError(t("login.errorBlocked"));
          return;
        }
        setGlobalError(err.message);
        return;
      }
      setGlobalError(t("login.errorNetwork"));
    }
  }

  return (
    <AuthShell>
      <div className="mb-6 space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight">{t("login.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("login.subtitle")}</p>
      </div>

      {reason === "blocked" && (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{t("login.reasonBlocked")}</AlertDescription>
        </Alert>
      )}
      {reason === "expired" && (
        <Alert className="mb-4">
          <AlertDescription>{t("login.reasonExpired")}</AlertDescription>
        </Alert>
      )}
      {globalError && (
        <Alert variant={needsTotp ? "default" : "destructive"} className="mb-4">
          <AlertDescription>{globalError}</AlertDescription>
        </Alert>
      )}

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="email">{t("login.email")}</Label>
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
            <Label htmlFor="password">{t("login.password")}</Label>
            <Link href="/forgot-password" className="text-xs text-muted-foreground hover:text-foreground">
              {t("login.forgot")}
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
            <Label htmlFor="token">{t("login.totp")}</Label>
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
            <p className="text-xs text-muted-foreground">{t("login.totpHint")}</p>
          </div>
        )}

        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t("login.submit")}
        </Button>
      </form>

      <div className="mt-6 text-center text-xs text-muted-foreground">
        {t("login.noAccount")} <Link href="/signup" className="text-foreground underline-offset-4 hover:underline">{t("login.signupLink")}</Link>
      </div>
    </AuthShell>
  );
}

/** Shared wrapper for /login, /signup, /forgot-password — centered card on slate bg. */
export function AuthShell({ children }: { children: React.ReactNode }) {
  const { t } = useT();
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
        <div className="mb-4 flex justify-center">
          <LanguageSwitcher variant="inline" />
        </div>
        <Card className="shadow-pop">
          <CardContent className="p-6">{children}</CardContent>
        </Card>
        <p className="mt-6 text-center text-xs text-muted-foreground">
          {t("auth.shell.tagline")}
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
