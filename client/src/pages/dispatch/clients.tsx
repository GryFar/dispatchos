import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Briefcase, Loader2 } from "lucide-react";
import { apiJson } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/dispatch/EmptyState";

interface AssignedClient {
  id: string;
  name: string;
  activeDriversCount: number;
  activeLoadsCount: number;
}

/**
 * /dispatch/clients — list of clients assigned to the current dispatcher.
 * Read-only in P0. Tapping a client deep-links to /loads?clientId= so the
 * dispatcher can see its loads.
 */
export default function DispatchClientsPage() {
  const { data, isLoading } = useQuery<{ items: AssignedClient[] }>({
    queryKey: ["/api/dispatch/clients"],
    queryFn: () => apiJson("GET", "/api/dispatch/clients"),
  });

  return (
    <div className="space-y-5">
      <header>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          dispatcher / клиенты
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Мои клиенты</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Клиенты, которыми вы управляете. Назначения — у админа.
        </p>
      </header>

      {isLoading ? (
        <Card className="flex h-32 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </Card>
      ) : !data || data.items.length === 0 ? (
        <Card className="p-2">
          <EmptyState
            icon={<Briefcase className="h-6 w-6" />}
            title="Нет назначений"
            description="Свяжитесь с админом — он привяжет к вам клиентов."
          />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.items.map((c) => (
            <Link key={c.id} href={`/loads?clientId=${c.id}`}>
              <Card className="p-4 transition-colors hover:bg-muted/50">
                <div className="flex items-center gap-2">
                  <Briefcase className="h-4 w-4 text-primary" />
                  <p className="font-semibold">{c.name}</p>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-2xl font-semibold tabular-nums">
                      {c.activeDriversCount}
                    </p>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      водителей
                    </p>
                  </div>
                  <div>
                    <p className="text-2xl font-semibold tabular-nums">
                      {c.activeLoadsCount}
                    </p>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      активных рейсов
                    </p>
                  </div>
                </div>
                <p className="mt-3 font-mono text-[10px] text-muted-foreground">
                  ID: {c.id}
                </p>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
