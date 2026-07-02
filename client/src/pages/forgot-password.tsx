import { useState } from "react";
import { Link } from "wouter";
import { Loader2, Mail, MailCheck } from "lucide-react";
import { ApiError, apiJson } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useT } from "@/lib/i18n";
import { AuthShell } from "./login";

/**
 * Forgot password — self-serve email reset.
 *
 * POST /api/auth/forgot-password { email } → всегда 200 { ok:true } (сервер
 * не раскрывает существование аккаунта), поэтому после отправки показываем
 * один и тот же нейтральный success-текст для любого email.
 */
export default function ForgotPasswordPage() {
  const { t } = useT();
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || sending) return;
    setError(null);
    setSending(true);
    try {
      await apiJson("POST", "/api/auth/forgot-password", { email: email.trim() });
      setSent(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError(t("login.errorRateLimit"));
      } else if (err instanceof ApiError && err.status === 400) {
        setError(t("forgot.errorInvalidEmail"));
      } else {
        setError(t("login.errorNetwork"));
      }
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <AuthShell>
        <div className="space-y-4 text-center">
          <MailCheck className="mx-auto h-10 w-10 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight">{t("forgot.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("forgot.sent")}</p>
          <Link href="/login">
            <Button variant="outline" className="w-full">{t("forgot.backToLogin")}</Button>
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="space-y-4">
        <div className="space-y-2 text-center">
          <Mail className="mx-auto h-10 w-10 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight">{t("forgot.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("forgot.body")}</p>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">{t("forgot.email")}</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder={t("forgot.emailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={sending}>
            {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("forgot.submit")}
          </Button>
        </form>

        <Link href="/login">
          <Button variant="ghost" className="w-full text-xs">{t("forgot.backToLogin")}</Button>
        </Link>
      </div>
    </AuthShell>
  );
}
