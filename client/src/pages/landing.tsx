import { useEffect } from "react";
import { useLocation } from "wouter";
import {
  ArrowRight,
  CheckCircle2,
  Gauge,
  MapPin,
  Mail,
  Shield,
  Truck,
  Zap,
} from "lucide-react";
import { useAuth } from "@/lib/use-auth";
import { defaultRouteForRole } from "@/components/role-gate";

/**
 * Public landing page rendered at "/" for unauthenticated visitors.
 *
 * Logged-in users get auto-redirected to their portal — keeps the URL clean
 * (`https://dispatchos.co/` always shows the right thing for whoever is on it).
 *
 * Design notes:
 * - Same palette as the dispatchos-coming-soon page (deep navy + amber).
 *   We re-implement it with tailwind here so the React app is a single bundle
 *   and we don't have to keep the standalone HTML in sync.
 * - Above-the-fold has the prominent «Войти» CTA — main thing the user asked
 *   us to expose on the landing.
 */
export default function LandingPage() {
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  // If the visitor is already authenticated, bounce them into their portal
  // straight from "/". This preserves the prior RootRedirect behaviour for
  // returning users while exposing a public landing to everyone else.
  useEffect(() => {
    if (isLoading) return;
    if (user) setLocation(defaultRouteForRole(user.role));
  }, [user, isLoading, setLocation]);

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[#0a0e1a] text-[#e8ecf5]">
      {/* Background grid + ambient glow blobs (mirrors coming-soon page) */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage:
            "radial-gradient(ellipse at center, black 30%, transparent 80%)",
          WebkitMaskImage:
            "radial-gradient(ellipse at center, black 30%, transparent 80%)",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed left-[-100px] top-[-150px] z-0 h-[500px] w-[500px] rounded-full opacity-50"
        style={{
          background:
            "radial-gradient(circle, rgba(245,158,11,0.25), transparent 70%)",
          filter: "blur(100px)",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed bottom-[-200px] right-[-150px] z-0 h-[600px] w-[600px] rounded-full opacity-50"
        style={{
          background:
            "radial-gradient(circle, rgba(99,102,241,0.18), transparent 70%)",
          filter: "blur(100px)",
        }}
      />

      <div className="relative z-10 mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-8">
        {/* Header */}
        <header className="flex items-center justify-between">
          <a href="/" className="flex items-center gap-3 font-bold tracking-tight text-white">
            <svg width="36" height="36" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="6" fill="#0a0e1a" />
              <path
                d="M8 9h7c4 0 6 3 6 7s-2 7-6 7H8z"
                fill="none"
                stroke="#f59e0b"
                strokeWidth={3}
                strokeLinejoin="round"
              />
              <line x1="6" y1="16" x2="26" y2="16" stroke="#f59e0b" strokeWidth={2} />
            </svg>
            <span className="text-lg">DispatchOS</span>
          </a>

          <div className="flex items-center gap-3">
            <a
              href="#features"
              className="hidden text-sm text-[#9aa3ba] transition-colors hover:text-white sm:block"
            >
              Возможности
            </a>
            <a
              href="mailto:hello@dispatchos.co"
              className="hidden text-sm text-[#9aa3ba] transition-colors hover:text-white sm:block"
            >
              Связаться
            </a>
            <button
              type="button"
              onClick={() => setLocation("/login")}
              className="inline-flex items-center gap-2 rounded-lg bg-[#f59e0b] px-4 py-2 text-sm font-semibold text-[#0a0e1a] transition-all hover:bg-[#fbbf24] hover:shadow-[0_0_24px_rgba(245,158,11,0.4)]"
            >
              Войти
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </header>

        {/* Hero */}
        <section className="mt-16 flex flex-col items-start gap-6 md:mt-24">
          <span className="inline-flex items-center gap-2 rounded-full border border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.08)] px-3 py-1 text-xs font-medium text-[#f59e0b]">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#f59e0b]" />
            В работе с реальными перевозчиками
          </span>

          <h1 className="max-w-3xl text-4xl font-bold leading-[1.1] tracking-tight text-white md:text-6xl">
            Операционная система для{" "}
            <span className="text-[#f59e0b]">диспатчера грузов</span>
          </h1>

          <p className="max-w-2xl text-base leading-relaxed text-[#9aa3ba] md:text-lg">
            DispatchOS объединяет inbound-загрузки, скоринг брокеров, GPS-трекинг
            водителей и compliance в один экран. Создано для car-hauler, hotshot
            и owner-operator команд — без enterprise-ценника.
          </p>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => setLocation("/login")}
              className="inline-flex items-center gap-2 rounded-lg bg-[#f59e0b] px-6 py-3 text-base font-semibold text-[#0a0e1a] transition-all hover:bg-[#fbbf24] hover:shadow-[0_0_32px_rgba(245,158,11,0.45)]"
            >
              Войти в систему
              <ArrowRight className="h-5 w-5" />
            </button>
            <a
              href="mailto:hello@dispatchos.co?subject=DispatchOS%20demo"
              className="inline-flex items-center gap-2 rounded-lg border border-[rgba(255,255,255,0.14)] bg-[#161c2e] px-6 py-3 text-base font-semibold text-white transition-colors hover:border-[#f59e0b] hover:text-[#f59e0b]"
            >
              <Mail className="h-5 w-5" />
              Запросить демо
            </a>
          </div>
        </section>

        {/* Feature grid */}
        <section id="features" className="mt-24 grid gap-4 md:grid-cols-3">
          <FeatureCard
            icon={<Mail className="h-5 w-5" />}
            title="Inbound из всех источников"
            text="Email-парсер ловит грузы из Sylectus, Hempstead и брокерских ratecon'ов. Telegram-бот водителя в комплекте."
          />
          <FeatureCard
            icon={<Shield className="h-5 w-5" />}
            title="Broker Trust Score"
            text="FMCSA SAFER + история платежей + сигналы от диспетчеров. Один экран — решение по тендеру."
          />
          <FeatureCard
            icon={<MapPin className="h-5 w-5" />}
            title="GPS и геофенсинг"
            text="Traccar и OwnTracks ингест, авто-чекин в pickup/delivery, online-индикатор водителя."
          />
          <FeatureCard
            icon={<Gauge className="h-5 w-5" />}
            title="Топливо и MPG"
            text="GasBuddy + EIA + crowdsource. Алерты на переплаты, реальный MPG, прогноз на маршруте."
          />
          <FeatureCard
            icon={<Truck className="h-5 w-5" />}
            title="IFTA и compliance"
            text="Квартальная отчётность по штатам, страховки, MCS-150, DQ-файлы — напоминалки по желанию клиента."
          />
          <FeatureCard
            icon={<Zap className="h-5 w-5" />}
            title="AI-помощник"
            text="Claude разбирает чеки, классифицирует BOL/POD, помогает в переговорах с брокером по email."
          />
        </section>

        {/* Mini "what's new" / trust strip */}
        <section className="mt-20 rounded-xl border border-[rgba(255,255,255,0.08)] bg-gradient-to-b from-[#161c2e] to-[#0f1424] p-6 md:p-8">
          <div className="grid gap-4 md:grid-cols-3">
            <TrustItem
              label="Свежие апдейты"
              value="IFTA, Geofence, Insurance monitor"
              hint="Май 2026"
            />
            <TrustItem
              label="Под Montgomery v. Caribe"
              value="Carrier Safety Profile"
              hint="paid add-on $50–100/мес"
            />
            <TrustItem
              label="Для малых перевозчиков"
              value="1–50 trucks"
              hint="без per-user тарифов"
            />
          </div>
        </section>

        {/* Footer */}
        <footer className="mt-auto flex flex-col items-start justify-between gap-3 border-t border-[rgba(255,255,255,0.08)] pt-8 text-xs text-[#6b7390] md:flex-row md:items-center">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-[#34d399]" />
            <span>© {new Date().getFullYear()} DispatchOS. Создано для дальнобойщиков, дисптчеров и owner-operators в US.</span>
          </div>
          <div className="flex items-center gap-4">
            <a href="mailto:hello@dispatchos.co" className="hover:text-white">hello@dispatchos.co</a>
            <button
              type="button"
              onClick={() => setLocation("/login")}
              className="hover:text-white"
            >
              Войти
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function FeatureCard({
  icon, title, text,
}: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="group rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#161c2e]/60 p-5 transition-all hover:border-[rgba(245,158,11,0.25)] hover:bg-[#161c2e]">
      <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[rgba(245,158,11,0.12)] text-[#f59e0b]">
        {icon}
      </div>
      <h3 className="text-base font-semibold text-white">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-[#9aa3ba]">{text}</p>
    </div>
  );
}

function TrustItem({
  label, value, hint,
}: { label: string; value: string; hint: string }) {
  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-wider text-[#6b7390]">{label}</p>
      <p className="mt-1 text-base font-semibold text-white">{value}</p>
      <p className="mt-0.5 text-xs text-[#9aa3ba]">{hint}</p>
    </div>
  );
}
