import { FileText } from "lucide-react";
import { EmptyState } from "@/components/dispatch/EmptyState";
import { Card } from "@/components/ui/card";

/**
 * Driver documents (`/d/documents`) — Phase 4 P0 stub.
 *
 * Реальная страница придёт в P1 (см. handoff §3.2): CDL, medical, COI, W9
 * с expiration warnings и upload через POST /api/me/documents. Здесь мы
 * показываем заглушку, чтобы bottom-nav tab «Доки» вёл на осмысленный экран.
 */
export default function DriverDocumentsPage() {
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Документы</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">
          CDL · Medical · COI · W9
        </p>
      </header>
      <Card className="p-2">
        <EmptyState
          icon={<FileText className="h-6 w-6" />}
          title="Скоро в P1"
          description="Загрузка и проверка документов появится в следующем PR (phase4-driver-p1). До этого админ может попросить вас прислать сканы через Telegram."
        />
      </Card>
    </div>
  );
}
