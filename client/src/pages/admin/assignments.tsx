import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Briefcase, Headset, Link2, Network, Trash2, X } from "lucide-react";
import type { Assignment, Client, UserPublic } from "@shared/schema";
import { apiJson } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { EndpointPending, isEndpointMissing } from "@/components/dispatch/EndpointPending";
import { EmptyState } from "@/components/dispatch/EmptyState";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { McCell } from "@/components/dispatch/cells";
import { cn } from "@/lib/utils";

type AssignmentListResponse = {
  items: Assignment[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number | null;
};
type UserListResponse = {
  items: UserPublic[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number | null;
};

/**
 * Assignments board — drag-n-drop связи клиент ↔ диспетчер.
 *
 * Три колонки:
 *   - Клиенты (источник перетаскивания)
 *   - Диспетчеры (drop zones)
 *   - Активные назначения (third pane: M:N карточки с X для удаления)
 *
 * GET/POST/DELETE /api/admin/assignments — Phase 3 (P1).
 * При 404 показываем EndpointPending. Клиенты загружаем live (есть в v1.2.7).
 * Диспетчеров можно получить только из /api/admin/users (тоже Phase 3) — если нет,
 * показываем заглушку для колонки.
 */
export default function AssignmentsPage() {
  const qc = useQueryClient();
  const { toast } = useToast();

  // Live в v1.2.7
  const clientsQuery = useQuery<Client[]>({
    queryKey: ["/api/clients"],
    queryFn: () => apiJson<Client[]>("GET", "/api/clients"),
    staleTime: 60_000,
  });

  // Phase 3 P0 — список диспетчеров
  const dispatchersQuery = useQuery<UserListResponse>({
    queryKey: ["/api/admin/users?role=dispatcher&blocked=false&limit=200"],
    queryFn: () =>
      apiJson<UserListResponse>("GET", "/api/admin/users?role=dispatcher&blocked=false&limit=200"),
    staleTime: 30_000,
  });

  // Phase 3 P1 — список assignments
  const assignmentsQuery = useQuery<AssignmentListResponse>({
    queryKey: ["/api/admin/assignments?limit=200"],
    queryFn: () => apiJson<AssignmentListResponse>("GET", "/api/admin/assignments?limit=200"),
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: (body: { clientId: string; dispatcherUserId: string }) =>
      apiJson<Assignment>("POST", "/api/admin/assignments", body),
    onSuccess: () => {
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/admin/assignments") });
      toast({ title: "Назначение создано" });
    },
    onError: (err: Error) => {
      if (isEndpointMissing(err)) {
        toast({
          variant: "destructive",
          title: "Endpoint не реализован",
          description: "POST /api/admin/assignments — Phase 3 (P1).",
        });
      } else {
        toast({ variant: "destructive", title: "Ошибка", description: err.message });
      }
    },
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => apiJson("DELETE", `/api/admin/assignments/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/admin/assignments") });
      toast({ title: "Назначение удалено" });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Ошибка", description: err.message });
    },
  });

  // DnD state
  const [draggingClient, setDraggingClient] = useState<Client | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function handleDragStart(e: DragStartEvent) {
    const id = String(e.active.id);
    if (id.startsWith("client:")) {
      const cid = id.slice("client:".length);
      const c = clientsQuery.data?.find((x) => x.id === cid) ?? null;
      setDraggingClient(c);
    }
  }

  function handleDragEnd(e: DragEndEvent) {
    setDraggingClient(null);
    if (!e.over) return;
    const activeId = String(e.active.id);
    const overId = String(e.over.id);
    if (!activeId.startsWith("client:") || !overId.startsWith("dispatcher:")) return;
    const clientId = activeId.slice("client:".length);
    const dispatcherUserId = overId.slice("dispatcher:".length);
    const exists = (assignmentsQuery.data?.items ?? []).some(
      (a) => a.clientId === clientId && a.dispatcherUserId === dispatcherUserId && !a.removedAt,
    );
    if (exists) {
      toast({ title: "Уже назначено", description: "Эта пара уже активна." });
      return;
    }
    createMutation.mutate({ clientId, dispatcherUserId });
  }

  // If both Phase 3 endpoints are missing, show one unified banner.
  const usersMissing = isEndpointMissing(dispatchersQuery.error);
  const asgMissing = isEndpointMissing(assignmentsQuery.error);
  if (usersMissing && asgMissing) {
    return (
      <div className="space-y-6">
        <Header />
        <EndpointPending
          endpoint="GET /api/admin/assignments + GET /api/admin/users"
          description="Drag-n-drop board ждёт реализации управления пользователями и назначениями (Phase 3, P0/P1)."
        />
      </div>
    );
  }

  const clients = clientsQuery.data ?? [];
  const dispatchers = dispatchersQuery.data?.items ?? [];
  const assignments = (assignmentsQuery.data?.items ?? []).filter((a) => !a.removedAt);
  const clientsById = new Map(clients.map((c) => [c.id, c]));
  const dispatchersById = new Map(dispatchers.map((d) => [d.id, d]));

  return (
    <div className="space-y-6">
      <Header />

      <Alert>
        <Link2 className="h-4 w-4" />
        <AlertDescription className="text-xs">
          Перетащите клиента из левой колонки на карточку диспетчера справа. Один клиент может
          быть назначен на нескольких диспетчеров — это нормально для 24/7 ротации.
        </AlertDescription>
      </Alert>

      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Column 1: Clients */}
          <Card className="shadow-card">
            <CardContent className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <Briefcase className="h-4 w-4 text-primary" />
                  Клиенты
                </h3>
                <span className="text-xs text-muted-foreground">{clients.length}</span>
              </div>
              {clientsQuery.isLoading ? (
                <div className="space-y-2">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-12 animate-skeleton rounded-md" />
                  ))}
                </div>
              ) : clients.length === 0 ? (
                <EmptyState icon={<Briefcase />} title="Нет клиентов" />
              ) : (
                <div className="space-y-1.5">
                  {clients.map((c) => (
                    <DraggableClient key={c.id} client={c} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Column 2: Dispatchers (drop zones) */}
          <Card className="shadow-card">
            <CardContent className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <Headset className="h-4 w-4 text-primary" />
                  Диспетчеры
                </h3>
                <span className="text-xs text-muted-foreground">{dispatchers.length}</span>
              </div>
              {usersMissing ? (
                <Alert>
                  <AlertDescription className="text-xs">
                    Список диспетчеров появится после Phase 3 (P0).
                  </AlertDescription>
                </Alert>
              ) : dispatchersQuery.isLoading ? (
                <div className="space-y-2">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-16 animate-skeleton rounded-md" />
                  ))}
                </div>
              ) : dispatchers.length === 0 ? (
                <EmptyState icon={<Headset />} title="Нет диспетчеров" description="Создайте через invite." />
              ) : (
                <div className="space-y-2">
                  {dispatchers.map((d) => {
                    const myAssignments = assignments.filter((a) => a.dispatcherUserId === d.id);
                    return (
                      <DispatcherDropZone
                        key={d.id}
                        dispatcher={d}
                        assignmentCount={myAssignments.length}
                      />
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Column 3: Active assignments */}
          <Card className="shadow-card">
            <CardContent className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <Network className="h-4 w-4 text-primary" />
                  Активные назначения
                </h3>
                <span className="text-xs text-muted-foreground">{assignments.length}</span>
              </div>
              {asgMissing ? (
                <Alert>
                  <AlertDescription className="text-xs">
                    Назначения появятся после Phase 3 (P1).
                  </AlertDescription>
                </Alert>
              ) : assignmentsQuery.isLoading ? (
                <div className="space-y-2">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-10 animate-skeleton rounded-md" />
                  ))}
                </div>
              ) : assignments.length === 0 ? (
                <EmptyState
                  icon={<Network />}
                  title="Нет назначений"
                  description="Перетащите клиента на диспетчера, чтобы создать связь."
                />
              ) : (
                <div className="space-y-1.5">
                  {assignments.map((a) => {
                    const c = clientsById.get(a.clientId);
                    const d = dispatchersById.get(a.dispatcherUserId);
                    return (
                      <div
                        key={a.id}
                        className="group flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 p-2"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium">{c?.name ?? a.clientId}</p>
                          <p className="truncate text-[10px] text-muted-foreground">
                            → {d?.fullName ?? a.dispatcherUserId}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0 text-destructive opacity-0 transition-opacity group-hover:opacity-100"
                          onClick={() => removeMutation.mutate(a.id)}
                          disabled={removeMutation.isPending}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <DragOverlay>
          {draggingClient ? (
            <div className="cursor-grabbing rounded-md border border-primary/40 bg-card p-2 shadow-pop">
              <p className="text-xs font-medium">{draggingClient.name}</p>
              <p className="text-[10px] text-muted-foreground">
                <McCell value={draggingClient.mc} />
              </p>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function Header() {
  return (
    <header className="border-b border-border pb-5">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Admin / Назначения
      </p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Назначения</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">
        Связи клиент ↔ диспетчер. Drag-n-drop. Many-to-many для 24/7 ротации.
      </p>
    </header>
  );
}

function DraggableClient({ client }: { client: Client }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `client:${client.id}` });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cn(
        "cursor-grab rounded-md border border-border bg-card p-2 transition-all hover:border-primary/30 hover:shadow-card-hover active:cursor-grabbing",
        isDragging && "opacity-30",
      )}
    >
      <p className="text-xs font-medium">{client.name}</p>
      {(client as any).contactPersonName && (
        <p className="text-[10px] text-muted-foreground">{(client as any).contactPersonName}</p>
      )}
      <p className="text-[10px] text-muted-foreground">
        <McCell value={client.mc} />
      </p>
    </div>
  );
}

function DispatcherDropZone({
  dispatcher,
  assignmentCount,
}: {
  dispatcher: UserPublic;
  assignmentCount: number;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `dispatcher:${dispatcher.id}` });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex items-center gap-2.5 rounded-md border-2 border-dashed p-2.5 transition-all",
        isOver
          ? "border-primary bg-primary/5"
          : "border-border bg-card hover:border-primary/30",
      )}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
        {dispatcher.fullName?.[0]?.toUpperCase() ?? "?"}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{dispatcher.fullName}</p>
        <p className="truncate text-[10px] text-muted-foreground">{dispatcher.email}</p>
      </div>
      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
        {assignmentCount}
      </span>
    </div>
  );
}

void X;
