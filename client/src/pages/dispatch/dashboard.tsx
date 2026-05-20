import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertTriangle,
  ArrowRight,
  Briefcase,
  Inbox,
  Loader2,
  Package,
  Users,
} from "lucide-react";
import type { DispatchDashboard } from "@shared/schema";
import { apiJson } from "@/lib/queryClient";
import { formatMoney, formatRelativeAgo } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/dispatch/EmptyState";

/**
 * Dispatcher dashboard (`/dispatch`).
 *
 * Single round-trip via /api/dispatch/me/dashboard. Three stat cards on top,
 * peek at recent open queue tasks + peek at recent loads + assigned clients
 * list. No actions here — each peek tile deep-links into its own page.
 */
export default function DispatchDashboardPage() {
  const { data, isLoading } = useQuery<DispatchDashboard>({
    queryKey: ["/api/dispatch/me/dashboard"],
    queryFn: () => apiJson("GET", "/api/dispatch/me/dashboard"),
  });

  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          dispatcher
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Добрый день, {data.dispatcher.fullName.split(" ")[0]}!
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Ваши клиенты, активные рейсы и очередь задач.
        </p>
      </header>

      {/* Stat cards */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          icon={<Users className="h-5 w-5" />}
          label="Клиенты"
          value={data.stats.assignedClientsCount}
          href="/clients"
        />
        <StatCard
          icon={<Package className="h-5 w-5" />}
          label="Активные рейсы"
          value={data.stats.activeLoadsCount}
          href="/loads?status=booked"
        />
        <StatCard
          icon={<Inbox className="h-5 w-5" />}
          label="Открытых задач"
          value={data.stats.openTasksCount}
          href="/queue"
          urgent={data.stats.openTasksCount > 0}
        />
      </div>

      {/* Recent open tasks */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Очередь задач
          </h2>
          <Link
            href="/queue"
            className="text-xs text-primary hover:underline"
          >
            Все →
          </Link>
        </div>
        {data.recentOpenTasks.length === 0 ? (
          <Card className="p-2">
            <EmptyState
              icon={<Inbox className="h-6 w-6" />}
              title="Пусто"
              description="Когда водители сообщат о проблемах, они появятся здесь."
            />
          </Card>
        ) : (
          <div className="space-y-2">
            {data.recentOpenTasks.map((task) => {
              const p = task.payload as {
                severity?: string;
                title?: string;
              };
              const isUrgent = p.severity === "urgent";
              return (
                <Link
                  key={task.id}
                  href="/queue"
                  className="block"
                >
                  <Card className="flex items-center gap-3 p-3 transition-colors hover:bg-muted/50">
                    <AlertTriangle
                      className={`h-4 w-4 shrink-0 ${
                        isUrgent ? "text-destructive" : "text-yellow-500"
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {p.title || "Без названия"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatRelativeAgo(task.createdAt)}
                      </p>
                    </div>
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* Assigned clients */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Мои клиенты
          </h2>
          <Link
            href="/clients"
            className="text-xs text-primary hover:underline"
          >
            Все →
          </Link>
        </div>
        {data.assignedClients.length === 0 ? (
          <Card className="p-2">
            <EmptyState
              icon={<Briefcase className="h-6 w-6" />}
              title="Нет назначений"
              description="Свяжитесь с админом — он назначит вам клиентов."
            />
          </Card>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {data.assignedClients.map((c) => (
              <Card key={c.id} className="p-3">
                <p className="text-sm font-semibold">{c.name}</p>
                <div className="mt-1 flex gap-4 text-xs text-muted-foreground">
                  <span>{c.activeDriversCount} води­тел{c.activeDriversCount === 1 ? "ь" : c.activeDriversCount < 5 ? "я" : "ей"}</span>
                  <span>{c.activeLoadsCount} активн. рейс{c.activeLoadsCount === 1 ? "" : c.activeLoadsCount < 5 ? "а" : "ов"}</span>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Recent loads */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Недавние рейсы
          </h2>
          <Link
            href="/loads"
            className="text-xs text-primary hover:underline"
          >
            Все →
          </Link>
        </div>
        {data.recentLoads.length === 0 ? (
          <Card className="p-2">
            <EmptyState
              icon={<Package className="h-6 w-6" />}
              title="Пока нет рейсов"
              description="Рейсы появляются, как только админ создаёт их для ваших клиентов."
            />
          </Card>
        ) : (
          <div className="space-y-2">
            {data.recentLoads.map((load) => (
              <Link key={load.id} href={`/loads/${load.id}`} className="block">
                <Card className="flex items-center gap-3 p-3 transition-colors hover:bg-muted/50">
                  <Package className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {load.originCity}, {load.originState} → {load.destinationCity},{" "}
                      {load.destinationState}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {load.brokerName} · {formatMoney(load.rate)}
                    </p>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  href,
  urgent,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  href: string;
  urgent?: boolean;
}) {
  return (
    <Link href={href}>
      <Card
        className={`flex items-center gap-3 p-4 transition-colors hover:bg-muted/50 ${
          urgent ? "border-destructive/40 bg-destructive/5" : ""
        }`}
      >
        <div
          className={`flex h-9 w-9 items-center justify-center rounded-lg ${
            urgent ? "bg-destructive/15 text-destructive" : "bg-primary/15 text-primary"
          }`}
        >
          {icon}
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-2xl font-semibold tabular-nums">{value}</p>
        </div>
      </Card>
    </Link>
  );
}
