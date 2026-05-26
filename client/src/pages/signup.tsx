import { useEffect, useState } from "react";
import { useLocation, Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { CheckCircle2, Copy, Loader2, ShieldCheck } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type { SignupResponse } from "@shared/schema";
import { ApiError, apiJson } from "@/lib/queryClient";
import { refreshAuth, useAuth } from "@/lib/use-auth";
import { defaultRouteForRole } from "@/components/role-gate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
 */

const schema = z.object({
  inviteCode: z.string()
    .min(1, "Введите invite-код")
    .transform((s) => s.toUpperCase().trim()),
  email: z.string().email("Введите корректный email"),
  fullName: z.string().min(2, "Введите ФИО"),
  password: z.string()
    .min(10, "Минимум 10 символов")
    .max(128, "Слишком длинный"),
});
type FormValues = z.infer<typeof schema>;

export default function SignupPage() {
  const [, setLocation] = useLocation();
  const { user, isLoading: authLoading } = useAuth();
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [successData, setSuccessData] = useState<SignupResponse | null>(null);

  const params = parseHashSearch();
  const prefilledCode = params.get("code") || "";

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
      await refreshAuth();
      setSuccessData(data);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 400 && /invite/i.test(err.message)) {
          setGlobalError("Invite-код не найден, истёк или уже использован.");
          return;
        }
        if (err.status === 409) {
          setGlobalError("Этот email уже зарегистрирован.");
          return;
        }
        setGlobalError(err.message);
        return;
      }
      setGlobalError("Не удалось подключиться к серверу.");
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
  const strength = passwordStrength(password);

  return (
    <AuthShell>
      <div className="mb-6 space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight">Регистрация</h1>
        <p className="text-sm text-muted-foreground">
          Введите invite-код, полученный от администратора.
        </p>
      </div>

      {globalError && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{globalError}</AlertDescription>
        </Alert>
      )}

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="inviteCode">Invite-код</Label>
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
          <Label htmlFor="email">Email</Label>
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
          <Label htmlFor="fullName">ФИО</Label>
          <Input
            id="fullName"
            type="text"
            autoComplete="name"
            placeholder="Иван Петров"
            {...form.register("fullName")}
          />
          {form.formState.errors.fullName && (
            <p className="text-xs text-destructive">{form.formState.errors.fullName.message}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password">Пароль (мин. 10 символов)</Label>
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
          Создать аккаунт
        </Button>
      </form>

      <div className="mt-6 text-center text-xs text-muted-foreground">
        Уже есть аккаунт? <Link href="/login" className="text-foreground underline-offset-4 hover:underline">Войти</Link>
      </div>
    </AuthShell>
  );
}

/** Post-signup TOTP setup — show QR + secret, ask user to scan before continuing. */
function PostSignupTotp({ data, onContinue }: { data: SignupResponse; onContinue: () => void }) {
  const hasTotp = Boolean(data.totpSecret && data.otpauthUrl);
  const [copied, setCopied] = useState(false);

  if (!hasTotp) {
    return (
      <div className="space-y-4 text-center">
        <CheckCircle2 className="mx-auto h-12 w-12 text-success" />
        <h1 className="text-xl font-semibold tracking-tight">Аккаунт создан</h1>
        <p className="text-sm text-muted-foreground">Сейчас вы будете перенаправлены в портал.</p>
        <Button onClick={onContinue} className="w-full">Продолжить</Button>
      </div>
    );
  }

  // QR code via Google Charts API (no extra deps). Simple, works offline if the
  // user has reached this point with internet. If we want a JS-side QR encoder
  // we can add `qrcode` to deps in Phase 5.
  async function copySecret() {
    try {
      await navigator.clipboard.writeText(data.totpSecret!);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — пользователь скопирует руками
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <ShieldCheck className="h-10 w-10 text-success" />
        <h1 className="text-xl font-semibold tracking-tight">Настройте 2FA</h1>
        <p className="text-sm text-muted-foreground">
          Отсканируйте QR-код в приложении Google Authenticator, 1Password или Authy.
        </p>
      </div>

      <div className="flex justify-center rounded-md border border-border bg-card p-3">
        <QRCodeSVG value={data.otpauthUrl!} size={176} level="M" aria-label="TOTP QR" />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Или введите секрет вручную:</Label>
        <div className="flex items-center gap-2">
          <Input readOnly value={data.totpSecret} className="font-mono text-xs" />
          <Button type="button" variant="outline" size="icon" onClick={copySecret} aria-label="Копировать">
            {copied ? <CheckCircle2 className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <Alert>
        <AlertDescription className="text-xs">
          <strong>Сохраните секрет!</strong> Без него вы не сможете войти при потере телефона.
          Запишите его в менеджере паролей.
        </AlertDescription>
      </Alert>

      <Button onClick={onContinue} className="w-full">
        Я отсканировал, продолжить
      </Button>
    </div>
  );
}

function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (pw.length === 0) return { score: 0, label: "" };
  let score = 0;
  if (pw.length >= 10) score++;
  if (pw.length >= 14) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  const label = score >= 4 ? "Сильный" : score === 3 ? "Хороший" : score === 2 ? "Средний" : "Слабый";
  return { score: Math.min(score, 4) as 0 | 1 | 2 | 3 | 4, label };
}

function parseHashSearch(): URLSearchParams {
  const hash = window.location.hash || "";
  const qIndex = hash.indexOf("?");
  return new URLSearchParams(qIndex >= 0 ? hash.slice(qIndex) : "");
}
