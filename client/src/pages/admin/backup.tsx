import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Database, Download, ShieldAlert, ShieldCheck } from "lucide-react";
import { apiJson } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatDateFull } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * Backup page — экспорт БД одним кликом.
 *
 * GET /api/backup/export?redacted=true → JSON download (live, v1.2.7).
 * Опции:
 *   - redacted=true  → пароли/токены замаскированы (рекомендуется для шаринга)
 *   - redacted=false → полный дамп (для миграции на другой инстанс)
 */
export default function BackupPage() {
  const [downloading, setDownloading] = useState<"redacted" | "full" | null>(null);
  const { toast } = useToast();

  const systemQuery = useQuery<{ version?: string; uptimeSeconds?: number; dbSize?: number }>({
    queryKey: ["/api/system/status"],
    queryFn: () => apiJson("GET", "/api/system/status"),
    staleTime: 60_000,
  });

  async function handleDownload(mode: "redacted" | "full") {
    setDownloading(mode);
    try {
      const url = `/api/backup/export?redacted=${mode === "redacted"}`;
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
      const blob = await res.blob();
      const dl = document.createElement("a");
      dl.href = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      dl.download = `dispatchos-backup-${mode}-${stamp}.json`;
      document.body.appendChild(dl);
      dl.click();
      document.body.removeChild(dl);
      URL.revokeObjectURL(dl.href);
      toast({ title: "Backup скачан", description: dl.download });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Ошибка экспорта",
        description: (err as Error).message,
      });
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="space-y-6">
      <header className="border-b border-border pb-5">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Admin / Backup
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Backup</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Экспорт всей БД в JSON. Скачайте файл и сохраните в безопасном месте.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card className="card-hover shadow-card">
          <CardContent className="space-y-4 p-6">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/15">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">Безопасный экспорт</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Пароли, TOTP-секреты, OAuth-токены замаскированы. Безопасно отправить
                  партнёру или сохранить в Google Drive.
                </p>
              </div>
            </div>
            <Button
              className="w-full"
              onClick={() => handleDownload("redacted")}
              disabled={downloading !== null}
            >
              <Download className="h-4 w-4" />
              {downloading === "redacted" ? "Скачивание..." : "Скачать redacted backup"}
            </Button>
          </CardContent>
        </Card>

        <Card className="card-hover shadow-card">
          <CardContent className="space-y-4 p-6">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-warning/10 text-warning ring-1 ring-warning/15">
                <ShieldAlert className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">Полный экспорт</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Содержит password hashes, TOTP secrets, OAuth tokens. Хранить ТОЛЬКО
                  в зашифрованном виде (1Password, Bitwarden, encrypted disk).
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => handleDownload("full")}
              disabled={downloading !== null}
            >
              <Download className="h-4 w-4" />
              {downloading === "full" ? "Скачивание..." : "Скачать полный backup"}
            </Button>
          </CardContent>
        </Card>
      </div>

      <Alert>
        <Database className="h-4 w-4" />
        <AlertDescription className="text-xs">
          <strong>Рекомендация:</strong> делайте redacted backup еженедельно перед миграциями
          или крупными изменениями. Полный backup — только когда планируете перенос на другой
          сервер.
        </AlertDescription>
      </Alert>

      {systemQuery.data && (
        <Card className="shadow-card">
          <CardContent className="p-5">
            <h3 className="mb-3 text-sm font-semibold">Состояние системы</h3>
            <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {systemQuery.data.version && (
                <div>
                  <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Версия
                  </dt>
                  <dd className="font-mono text-sm">{systemQuery.data.version}</dd>
                </div>
              )}
              {typeof systemQuery.data.uptimeSeconds === "number" && (
                <div>
                  <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Uptime
                  </dt>
                  <dd className="font-mono text-sm">
                    {formatUptime(systemQuery.data.uptimeSeconds)}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Текущее время
                </dt>
                <dd className="text-sm">{formatDateFull(new Date())}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return `${days}d ${hours}h`;
}
