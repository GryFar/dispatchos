import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { CheckCircle2, KeyRound, Loader2 } from "lucide-react";
import { ApiError, apiJson } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useT } from "@/lib/i18n";
import { AuthShell } from "./login";
import { passwordStrength } from "./signup";

/**
 * Reset password — завершение self-serve сброса по email-токену.
 *
 * Токен приходит в hash-фрагменте (#/reset-password?token=...), так что он не
 * попадает в серверные логи. Пароль валидируется той же схемой, что и signup
 * (min 10 / max 128 + strength-метр). POST /api/auth/reset-password; на
 * invalid/expired/used токен сервер отвечает одним generic 400 — показываем
 * дружелюбную ошибку со ссылкой на повторный запрос.
 */

const buildSchema = (t: (key: string) => string) =>
  z
    .object({
      password: z.string()
        .min(10, t("signup.validation.passwordMin"))
        .max(128, t("signup.validation.passwordMax")),
      confirm: z.string(),
    })
    .refine((v) => v.password === v.confirm, {
      path: ["confirm"],
      message: t("reset.mismatch"),
    });

export default function ResetPasswordPage() {
  const { t } = useT();
  const token = useMemo(() => parseHashSearch().get("token") || "", []);
  const [done, setDone] = useState(false);
  const [invalidToken, setInvalidToken] = useState(!token);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const schema = useMemo(() => buildSchema(t), [t]);
  type FormValues = z.infer<typeof schema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { password: "", confirm: "" },
  });
  const password = form.watch("password");
  const strength = passwordStrength(password, t);

  async function onSubmit(values: FormValues) {
    setGlobalError(null);
    try {
      await apiJson("POST", "/api/auth/reset-password", {
        token,
        newPassword: values.password,
      });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setGlobalError(t("login.errorRateLimit"));
          return;
        }
        if (err.status === 400) {
          // Generic server 400 = missing/expired/used token (never says which).
          setInvalidToken(true);
          return;
        }
        setGlobalError(err.message);
        return;
      }
      setGlobalError(t("login.errorNetwork"));
    }
  }

  if (done) {
    return (
      <AuthShell>
        <div className="space-y-4 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-success" />
          <h1 className="text-xl font-semibold tracking-tight">{t("reset.successTitle")}</h1>
          <p className="text-sm text-muted-foreground">{t("reset.successBody")}</p>
          <Link href="/login">
            <Button className="w-full">{t("reset.goToLogin")}</Button>
          </Link>
        </div>
      </AuthShell>
    );
  }

  if (invalidToken) {
    return (
      <AuthShell>
        <div className="space-y-4 text-center">
          <KeyRound className="mx-auto h-10 w-10 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight">{t("reset.invalidTitle")}</h1>
          <p className="text-sm text-muted-foreground">{t("reset.invalidBody")}</p>
          <Link href="/forgot-password">
            <Button className="w-full">{t("reset.requestNew")}</Button>
          </Link>
          <Link href="/login">
            <Button variant="ghost" className="w-full text-xs">{t("forgot.backToLogin")}</Button>
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="space-y-4">
        <div className="space-y-2 text-center">
          <KeyRound className="mx-auto h-10 w-10 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight">{t("reset.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("reset.body")}</p>
        </div>

        {globalError && (
          <Alert variant="destructive">
            <AlertDescription>{globalError}</AlertDescription>
          </Alert>
        )}

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="password">{t("reset.password")}</Label>
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

          <div className="space-y-1.5">
            <Label htmlFor="confirm">{t("reset.confirm")}</Label>
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              {...form.register("confirm")}
            />
            {form.formState.errors.confirm && (
              <p className="text-xs text-destructive">{form.formState.errors.confirm.message}</p>
            )}
          </div>

          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("reset.submit")}
          </Button>
        </form>
      </div>
    </AuthShell>
  );
}

function parseHashSearch(): URLSearchParams {
  const hash = window.location.hash || "";
  const qIndex = hash.indexOf("?");
  return new URLSearchParams(qIndex >= 0 ? hash.slice(qIndex) : "");
}
