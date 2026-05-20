import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Mail,
  XCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiJson } from "@/lib/queryClient";

/**
 * Admin / Входящая почта
 *
 * Лента последних 20 писем, прилетевших на loads@dispatchos.co через
 * Cloudflare Email Worker → POST /api/inbound/email → storage.saveEmailIngest.
 *
 * Каждое письмо несёт raw поля (from / subject / body) + parsed результат
 * (`parsed.possibleLoad`, `parsed.extracted`). Админ видит на странице,
 * какие письма распарсились в груз, какие — нет, и может кликнуть в любое,
 * чтобы увидеть полный body + JSON parsed (полезно при расширении парсера
 * под новых брокеров).
 */

interface EmailIngestItem {
  id: string;
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  parsed?: {
    possibleLoad?: boolean;
    extracted?: Record<string, unknown>;
    [key: string]: unknown;
  } | null;
  createdAt: string;
}

interface EmailIngestResponse {
  items: EmailIngestItem[];
  limit: number;
}

export default function EmailInboxPage() {
  const [selected, setSelected] = useState<EmailIngestItem | null>(null);

  const { data, isLoading, isError } = useQuery<EmailIngestResponse>({
    queryKey: ["/api/admin/email-ingest", 20],
    queryFn: () => apiJson("GET", "/api/admin/email-ingest?limit=20"),
    refetchInterval: 30_000,
  });

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          Admin / Платформа
        </p>
        <h1 className="text-2xl font-semibold">Входящая почта</h1>
        <p className="text-sm text-muted-foreground">
          Последние 20 писем, прилетевших на{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            loads@dispatchos.co
          </code>
          . Парсер пытается выделить груз; если у письма нет «✓ Распарсено» —
          стоит расширить шаблон под отправителя.
        </p>
      </header>

      {isLoading && (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-md border border-border bg-muted/40"
            />
          ))}
        </div>
      )}

      {isError && (
        <Card>
          <CardContent className="flex items-center gap-2 py-6 text-sm text-rose-500">
            <AlertTriangle className="h-4 w-4" />
            Не удалось загрузить ленту входящих.
          </CardContent>
        </Card>
      )}

      {data && data.items.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground">
            <Mail className="h-8 w-8 opacity-50" />
            <p>Пока ни одного входящего письма.</p>
            <p className="text-xs">
              Когда брокер отправит rate confirmation, оно появится здесь.
            </p>
          </CardContent>
        </Card>
      )}

      {data && data.items.length > 0 && (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Получено</th>
                <th className="px-3 py-2 text-left font-medium">От</th>
                <th className="px-3 py-2 text-left font-medium">Тема</th>
                <th className="px-3 py-2 text-left font-medium">Парсер</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => {
                const parsedOk = item.parsed?.possibleLoad === true;
                return (
                  <tr
                    key={item.id}
                    onClick={() => setSelected(item)}
                    className="cursor-pointer border-t border-border transition-colors hover:bg-muted/40"
                  >
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {new Date(item.createdAt).toLocaleString("ru-RU", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </td>
                    <td className="max-w-[200px] truncate px-3 py-2 font-mono text-xs">
                      {item.from || "—"}
                    </td>
                    <td className="max-w-[400px] truncate px-3 py-2">
                      {item.subject || (
                        <span className="text-muted-foreground">(без темы)</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {parsedOk ? (
                        <Badge
                          variant="outline"
                          className="border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                        >
                          <CheckCircle2 className="mr-1 h-3 w-3" />
                          Распарсено
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground">
                          <XCircle className="mr-1 h-3 w-3" />
                          Не распарсено
                        </Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-h-[80vh] max-w-3xl overflow-y-auto">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="text-base">
                  {selected.subject || "(без темы)"}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <DetailRow label="ID" value={selected.id} mono />
                <DetailRow label="От" value={selected.from || "—"} mono />
                <DetailRow label="Кому" value={selected.to || "—"} mono />
                <DetailRow
                  label="Получено"
                  value={new Date(selected.createdAt).toLocaleString("ru-RU")}
                />

                <div>
                  <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">
                    Тело письма
                  </p>
                  <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 text-xs">
                    {selected.body || "(пусто)"}
                  </pre>
                </div>

                <div>
                  <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">
                    Результат парсера
                  </p>
                  <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 text-xs font-mono">
                    {selected.parsed
                      ? JSON.stringify(selected.parsed, null, 2)
                      : "(парсер не отработал)"}
                  </pre>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2">
      <div className="text-xs font-medium uppercase text-muted-foreground">
        {label}
      </div>
      <div className={mono ? "font-mono text-xs break-all" : "text-sm"}>
        {value}
      </div>
    </div>
  );
}