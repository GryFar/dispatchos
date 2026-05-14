import { Link } from "wouter";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AuthShell } from "./login";

/**
 * Forgot password — заглушка для Phase 2.
 *
 * Полноценный сброс пароля (POST /api/auth/request-password-reset с email-токеном)
 * — Phase 5, когда подключим SMTP/Telegram-нотификации. Пока — пользователь должен
 * связаться с admin'ом, тот сделает POST /api/admin/users/:id/reset-password
 * (вернёт временный пароль) и передаст пользователю.
 */
export default function ForgotPasswordPage() {
  return (
    <AuthShell>
      <div className="space-y-4 text-center">
        <Mail className="mx-auto h-10 w-10 text-muted-foreground" />
        <h1 className="text-xl font-semibold tracking-tight">Сброс пароля</h1>
        <p className="text-sm text-muted-foreground">
          Свяжитесь с администратором DispatchOS — он сбросит ваш пароль и выдаст временный.
          После входа с временным паролем смените его в настройках.
        </p>
        <p className="text-sm text-muted-foreground">
          Самостоятельный сброс по email появится в следующем релизе.
        </p>
        <Link href="/login">
          <Button variant="outline" className="w-full">Вернуться к входу</Button>
        </Link>
      </div>
    </AuthShell>
  );
}
