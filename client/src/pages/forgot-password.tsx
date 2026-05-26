import { Link } from "wouter";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { AuthShell } from "./login";

/**
 * Forgot password — заглушка для Phase 2.
 *
 * Полноценный сброс пароля (POST /api/auth/request-password-reset с email-токеном)
 * — Phase 5, когда подключим SMTP/Telegram-нотификации. Пока — пользователь должен
 * связаться с admin'ом, тот сделает POST /api/admin/users/:id/reset-password
 * (вернёт временный пароль) и передаст пользователю.
 *
 * 2026-05-27 hotfix: i18n-ified after Vlad's RU/EN coverage report.
 */
export default function ForgotPasswordPage() {
  const { t } = useT();
  return (
    <AuthShell>
      <div className="space-y-4 text-center">
        <Mail className="mx-auto h-10 w-10 text-muted-foreground" />
        <h1 className="text-xl font-semibold tracking-tight">{t("forgot.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("forgot.body")}</p>
        <p className="text-sm text-muted-foreground">{t("forgot.note")}</p>
        <Link href="/login">
          <Button variant="outline" className="w-full">{t("forgot.backToLogin")}</Button>
        </Link>
      </div>
    </AuthShell>
  );
}
