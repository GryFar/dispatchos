import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FileText,
  Upload,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import { ApiError, apiJson } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { EmptyState } from "@/components/dispatch/EmptyState";
import type { DriverDocument, DriverDocumentType } from "@shared/schema";

/**
 * Driver documents (`/d/documents`) — Phase 4 P1.
 *
 * - GET /api/me/documents — list own docs.
 * - POST /api/me/documents (multipart) — upload one.
 * - DELETE /api/me/documents/:id — remove.
 */

interface DocumentsListResponse {
  items: DriverDocument[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number;
}

const DOC_TYPE_LABELS: Record<DriverDocumentType, string> = {
  cdl: "CDL",
  medical: "Medical card",
  coi: "COI (страховка)",
  w9: "W9",
  ifta: "IFTA",
  other: "Другое",
};

function fmtExpiry(expiresAt: string | null): { label: string; tone: "ok" | "soon" | "expired" } {
  if (!expiresAt) return { label: "Без срока", tone: "ok" };
  const exp = new Date(`${expiresAt}T00:00:00Z`);
  const days = Math.round((exp.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (days <= 0) return { label: `Просрочен (${expiresAt})`, tone: "expired" };
  if (days <= 30) return { label: `Истекает через ${days} дн.`, tone: "soon" };
  return { label: `До ${expiresAt}`, tone: "ok" };
}

export default function DriverDocumentsPage() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [docType, setDocType] = useState<DriverDocumentType>("cdl");
  const [expiresAt, setExpiresAt] = useState("");
  const [notes, setNotes] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useQuery<DocumentsListResponse>({
    queryKey: ["/api/me/documents"],
    queryFn: () => apiJson("GET", "/api/me/documents"),
  });

  const uploadMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const res = await fetch("/api/me/documents", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new ApiError(res.status, msg || "Upload failed", null);
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Документ загружен" });
      qc.invalidateQueries({ queryKey: ["/api/me/documents"] });
      qc.invalidateQueries({ queryKey: ["/api/me/dashboard"] });
      setExpiresAt("");
      setNotes("");
      if (fileRef.current) fileRef.current.value = "";
    },
    onError: (err: ApiError) => {
      toast({
        variant: "destructive",
        title: "Не удалось загрузить",
        description: err.message,
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiJson("DELETE", `/api/me/documents/${id}`),
    onSuccess: () => {
      toast({ title: "Документ удалён" });
      qc.invalidateQueries({ queryKey: ["/api/me/documents"] });
      qc.invalidateQueries({ queryKey: ["/api/me/dashboard"] });
    },
    onError: (err: ApiError) => {
      toast({
        variant: "destructive",
        title: "Не удалось удалить",
        description: err.message,
      });
    },
  });

  function onUpload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      toast({ variant: "destructive", title: "Выберите файл" });
      return;
    }
    const fd = new FormData();
    fd.append("file", file);
    fd.append("type", docType);
    if (expiresAt) fd.append("expiresAt", expiresAt);
    if (notes) fd.append("notes", notes);
    uploadMutation.mutate(fd);
  }

  const items = data?.items ?? [];

  return (
    <div className="space-y-4 pb-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Документы</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">
          CDL · Medical · COI · W9 · IFTA
        </p>
      </header>

      <Card className="space-y-3 p-4">
        <h2 className="text-sm font-medium">Добавить документ</h2>
        <form onSubmit={onUpload} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="doc-type">Тип</Label>
            <Select value={docType} onValueChange={(v) => setDocType(v as DriverDocumentType)}>
              <SelectTrigger id="doc-type" className="h-12">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(DOC_TYPE_LABELS) as DriverDocumentType[]).map((t) => (
                  <SelectItem key={t} value={t}>
                    {DOC_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="doc-expires">Срок действия (опц.)</Label>
            <Input
              id="doc-expires"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="h-12"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="doc-notes">Заметки (опц.)</Label>
            <Input
              id="doc-notes"
              type="text"
              maxLength={500}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Номер лицензии и т.п."
              className="h-12"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="doc-file">Файл (PDF / JPG / PNG, до 10MB)</Label>
            <Input
              id="doc-file"
              ref={fileRef}
              type="file"
              accept=".pdf,image/jpeg,image/png"
              className="h-12 py-2.5"
            />
          </div>

          <Button
            type="submit"
            disabled={uploadMutation.isPending}
            className="h-12 w-full"
          >
            {uploadMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            Загрузить
          </Button>
        </form>
      </Card>

      <div className="space-y-2">
        <h2 className="text-sm font-medium">Мои документы</h2>
        {isLoading ? (
          <Card className="flex h-24 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </Card>
        ) : items.length === 0 ? (
          <Card className="p-2">
            <EmptyState
              icon={<FileText className="h-6 w-6" />}
              title="Пока пусто"
              description="Загрузите CDL и medical card — они нужны для всех рейсов."
            />
          </Card>
        ) : (
          items.map((doc) => {
            const expiry = fmtExpiry(doc.expiresAt);
            return (
              <Card key={doc.id} className="space-y-2 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">
                        {DOC_TYPE_LABELS[doc.type]}
                      </span>
                      <ExpiryChip tone={expiry.tone} label={expiry.label} />
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {doc.fileName}
                    </p>
                    {doc.notes && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {doc.notes}
                      </p>
                    )}
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-10 w-10 shrink-0"
                    onClick={() => {
                      if (window.confirm(`Удалить ${DOC_TYPE_LABELS[doc.type]}?`)) {
                        deleteMutation.mutate(doc.id);
                      }
                    }}
                    disabled={deleteMutation.isPending}
                    aria-label="Удалить"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}

function ExpiryChip({ tone, label }: { tone: "ok" | "soon" | "expired"; label: string }) {
  const cls =
    tone === "expired"
      ? "bg-destructive/15 text-destructive"
      : tone === "soon"
      ? "bg-yellow-500/15 text-yellow-500"
      : "bg-muted text-muted-foreground";
  const Icon = tone === "ok" ? CheckCircle2 : AlertTriangle;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}
    >
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}
