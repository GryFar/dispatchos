import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import { useLocation, Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AlertCircle, CheckCircle2, Copy, Loader2, ShieldCheck } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type { SignupResponse } from "@shared/schema";
import { ApiError, apiJson } from "@/lib/queryClient";
import { refreshAuth, useAuth } from "@/lib/use-auth";
import { defaultRouteForRole } from "@/components/role-gate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useT } from "@/lib/i18n";
import { AuthShell } from "./login";

/**
 * Signup — регистрация по invite-коду.
 *
 * Flow:
 *   1. Пользователь вводит invite-код (можно с дефисами или без), email, ФИО, пароль 10+
 *   2. На submit POST /api/auth/signup
 *   3. Backend автоматически логинит пользователя (ставит session cookie)
 *   4. Если ответ содержит totpSecret/otpauthUrl — показываем экран "Сохрани QR"
 *   5. Пользователь кликает "Продолжить" → редирект в его портал
 *
 * URL params: ?code=DOS-XXXX-... — пред-заполнение поля инвайт-кода (из admin-сгенерированной ссылки)
 *
 * 2026-05-27 hotfix: i18n-ified after Vlad's RU/EN coverage report.
 */

const buildSchema = (t: (key: string) => string) =>
  z.object({
    inviteCode: z.string()
      .min(1, t("signup.validation.inviteRequired"))
      .transform((s) => s.toUpperCase().trim()),
    email: z.string().email(t("signup.validation.emailInvalid")),
    fullName: z.string().min(2, t("signup.validation.fullNameRequired")),
    password: z.string()
      .min(10, t("signup.validation.passwordMin"))
      .max(128, t("signup.validation.passwordMax")),
  });

export default function SignupPage() {
  const { t } = useT();
  const [, setLocation] = useLocation();
  const { user, isLoading: authLoading } = useAuth();
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [successData, setSuccessData] = useState<SignupResponse | null>(null);

  const params = parseHashSearch();
  const prefilledCode = params.get("code") || "";

  // Recompute schema when language changes so validation messages localize too.
  const schema = useMemo(() => buildSchema(t), [t]);
  type FormValues = z.infer<typeof schema>;

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { inviteCode: prefilledCode, email: "", fullName: "", password: "" },
  });

  // If user already logged in — send to their portal (unless they just signed up).
  useEffect(() => {
    if (!authLoading && user && !successData) {
      setLocation(defaultRouteForRole(user.role));
    }
  }, [user, authLoading, setLocation, successData]);

  async function onSubmit(values: FormValues) {
    setGlobalError(null);
    try {
      const data = await apiJson<SignupResponse>("POST", "/api/auth/signup", {
        inviteCode: values.inviteCode,
        email: values.email,
        fullName: values.fullName,
        password: values.password,
      });
      // fix/totp-onboarding-verify: do NOT call refreshAuth() here.
      // The user is NOT logged in yet — the backend returns a pendingConfirmationToken
      // instead of a session. refreshAuth() will be called by PostSignupTotp after
      // the TOTP code is successfully verified.
      setSuccessData(data);
    } catch (err) {
      if (err instanceof ApiError) {
        // Same rate-limit branch as /login (Audit Critical #4 covers both).
        if (err.status === 429) {
          setGlobalError(t("login.errorRateLimit"));
          return;
        }
        if (err.status === 400 && /invite/i.test(err.message)) {
          setGlobalError(t("signup.errorInvite"));
          return;
        }
        if (err.status === 409) {
          setGlobalError(t("signup.errorEmailTaken"));
          return;
        }
        setGlobalError(err.message);
        return;
      }
      setGlobalError(t("login.errorNetwork"));
    }
  }

  // Post-signup success screen with TOTP setup
  if (successData) {
    return (
      <AuthShell>
        <PostSignupTotp data={successData} onContinue={() => setLocation("/onboarding")} />
      </AuthShell>
    );
  }

  const password = form.watch("password");
  const strength = passwordStrength(password, t);

  return (
    <AuthShell>
      <div className="mb-6 space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight">{t("signup.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("signup.subtitle")}</p>
      </div>

      {globalError && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{globalError}</AlertDescription>
        </Alert>
      )}

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="inviteCode">{t("signup.inviteCode")}</Label>
          <Input
            id="inviteCode"
            type="text"
            autoFocus
            autoComplete="off"
            placeholder="DOS-XXXX-XXXX-XXXX"
            className="font-mono uppercase tracking-wider"
            {...form.register("inviteCode")}
          />
          {form.formState.errors.inviteCode && (
            <p className="text-xs text-destructive">{form.formState.errors.inviteCode.message}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="email">{t("login.email")}</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            {...form.register("email")}
          />
          {form.formState.errors.email && (
            <p className="text-xs text-destructive">{form.formState.errors.email.message}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="fullName">{t("signup.fullName")}</Label>
          <Input
            id="fullName"
            type="text"
            autoComplete="name"
            placeholder={t("signup.fullNamePlaceholder")}
            {...form.register("fullName")}
          />
          {form.formState.errors.fullName && (
            <p className="text-xs text-destructive">{form.formState.errors.fullName.message}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password">{t("signup.password")}</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            {...form.register("password")}
          />
          {password.length > 0 && (
            <div className="flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={
                    strength.score >= 3 ? "h-full bg-success" :
                    strength.score === 2 ? "h-full bg-warning" :
                    "h-full bg-destructive"
                  }
                  style={{ width: `${(strength.score / 4) * 100}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground w-20 text-right">{strength.label}</span>
            </div>
          )}
          {form.formState.errors.password && (
            <p className="text-xs text-destructive">{form.formState.errors.password.message}</p>
          )}
        </div>

        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t("signup.submit")}
        </Button>
      </form>

      <div className="mt-6 text-center text-xs text-muted-foreground">
        {t("signup.haveAccount")} <Link href="/login" className="text-foreground underline-offset-4 hover:underline">{t("signup.loginLink")}</Link>
      </div>
    </AuthShell>
  );
}

/**
 * Post-signup TOTP setup — show QR + secret, then require a 6-digit code
 * before the account is considered fully set up.
 *
 * fix/totp-onboarding-verify: this component now calls
 * POST /api/auth/totp/confirm-signup with the pendingConfirmationToken from
 * the signup response. Only after a valid code is entered does the server
 * create a real session and stamp totp_confirmed_at. If the user had skipped
 * this step before (Henry's QA scenario) they would have been permanently
 * locked out on next login.
 */
function PostSignupTotp({ data, onContinue }: { data: SignupResponse; onContinue: () => void }) {
  const { t } = useT();
  const hasTotp = Boolean(data.totpSecret && data.otpauthUrl);
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState("");
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  if (!hasTotp) {
    return (
      <div className="space-y-4 text-center">
        <CheckCircle2 className="mx-auto h-12 w-12 text-success" />
        <h1 className="text-xl font-semibold tracking-tight">{t("signup.createdTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("signup.createdBody")}</p>
        <Button onClick={onContinue} className="w-full">{t("signup.createdContinue")}</Button>
      </div>
    );
  }

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(data.totpSecret!);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — пользователь скопирует руками
    }
  }

  async function handleVerify() {
    if (code.length !== 6) return;
    setVerifyError(null);
    setVerifying(true);
    try {
      await apiJson("POST", "/api/auth/totp/confirm-signup", {
        pendingConfirmationToken: data.pendingConfirmationToken,
        token: code,
      });
      // Session is now created server-side — sync auth state then continue.
      await refreshAuth();
      onContinue();
    } catch (err) {
      if (err instanceof ApiError) {
        const errBody = err.body as { code?: string } | null;
        if (errBody?.code === "token_expired") {
          setVerifyError(t("totp.setup.tokenExpired"));
        } else {
          setVerifyError(t("totp.setup.invalidCode"));
        }
      } else {
        setVerifyError(t("totp.setup.invalidCode"));
      }
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <ShieldCheck className="h-10 w-10 text-success" />
        <h1 className="text-xl font-semibold tracking-tight">{t("signup.totpTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("signup.totpSubtitle")}</p>
      </div>

      <div className="flex justify-center rounded-md border border-border bg-card p-3">
        <QRCodeSVG value={data.otpauthUrl!} size={176} level="M" aria-label="TOTP QR" />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">{t("signup.totpManual")}</Label>
        <div className="flex items-center gap-2">
          <Input readOnly value={data.totpSecret} className="font-mono text-xs" />
          <Button type="button" variant="outline" size="icon" onClick={copySecret} aria-label={t("signup.copyAria")}>
            {copied ? <CheckCircle2 className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <Alert>
        <AlertDescription className="text-xs">{t("signup.totpWarning")}</AlertDescription>
      </Alert>

      {/* Verification step — required before account is activated */}
      <div className="space-y-1.5">
        <Label htmlFor="totp-verify-code">{t("totp.setup.enterCode")}</Label>
        <Input
          id="totp-verify-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="000000"
          className="font-mono tracking-widest text-center text-lg"
          value={code}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
          }
        />
      </div>

      {verifyError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="text-xs">{verifyError}</AlertDescription>
        </Alert>
      )}

      <Button
        onClick={handleVerify}
        className="w-full"
        disabled={code.length !== 6 || verifying}
      >
        {verifying && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {t("totp.setup.verify")}
      </Button>
    </div>
  );
}

function passwordStrength(pw: string, t: (key: string) => string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (pw.length === 0) return { score: 0, label: "" };
  let score = 0;
  if (pw.length >= 10) score++;
  if (pw.length >= 14) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  const label =
    score >= 4 ? t("signup.strengthStrong") :
    score === 3 ? t("signup.strengthGood") :
    score === 2 ? t("signup.strengthMedium") :
    t("signup.strengthWeak");
  return { score: Math.min(score, 4) as 0 | 1 | 2 | 3 | 4, label };
}

function parseHashSearch(): URLSearchParams {
  const hash = window.location.hash || "";
  const qIndex = hash.indexOf("?");
  return new URLSearchParams(qIndex >= 0 ? hash.slice(qIndex) : "");
}
