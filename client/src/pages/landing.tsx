import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  ArrowRight,
  CheckCircle2,
  Gauge,
  Loader2,
  Mail,
  MapPin,
  Shield,
  Truck,
  X,
  Zap,
} from "lucide-react";
import { useAuth } from "@/lib/use-auth";
import { defaultRouteForRole } from "@/components/role-gate";
import { useT } from "@/lib/i18n";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";

/**
 * Public landing page rendered at "/" for unauthenticated visitors.
 *
 * Notes:
 * - Logged-in visitors are auto-redirected to their portal — keeps "/" doing
 *   the right thing for whoever is on it.
 * - The router is hash-based (see App.tsx + main.tsx). That means `<a href="#features">`
 *   would change the route, NOT scroll — so all in-page navigation uses
 *   scrollIntoView via refs.
 * - "Связаться" + "Подписаться на рассылку" both POST to /api/public/subscribe,
 *   the difference is just whether we attach name/note (Contact) or only
 *   email (Subscribe). Backend dedupes by pending-email and upgrades the
 *   existing lead row with the new note/name.
 */
export default function LandingPage() {
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { t } = useT();

  // Scroll targets — refs instead of #anchors because we use hash routing.
  const featuresRef = useRef<HTMLDivElement | null>(null);
  const contactRef = useRef<HTMLDivElement | null>(null);

  // Contact-form modal state
  const [contactOpen, setContactOpen] = useState(false);

  useEffect(() => {
    if (isLoading) return;
    if (user) setLocation(defaultRouteForRole(user.role));
  }, [user, isLoading, setLocation]);

  const scrollTo = (ref: React.RefObject<HTMLDivElement | null>) => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

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
          <button
            type="button"
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            className="flex items-center gap-3 font-bold tracking-tight text-white"
            aria-label={t("landing.nav.toHome")}
          >
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
          </button>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => scrollTo(featuresRef)}
              className="hidden text-sm text-[#9aa3ba] transition-colors hover:text-white sm:block"
            >
              {t("landing.nav.features")}
            </button>
            <button
              type="button"
              onClick={() => scrollTo(contactRef)}
              className="hidden text-sm text-[#9aa3ba] transition-colors hover:text-white sm:block"
            >
              {t("landing.nav.contact")}
            </button>
            <LanguageSwitcher variant="ghost" />
            <button
              type="button"
              onClick={() => setLocation("/login")}
              className="inline-flex items-center gap-2 rounded-lg bg-[#f59e0b] px-4 py-2 text-sm font-semibold text-[#0a0e1a] transition-all hover:bg-[#fbbf24] hover:shadow-[0_0_24px_rgba(245,158,11,0.4)]"
            >
              {t("common.login")}
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </header>

        {/* Hero */}
        <section className="mt-16 flex flex-col items-start gap-6 md:mt-24">
          <span className="inline-flex items-center gap-2 rounded-full border border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.08)] px-3 py-1 text-xs font-medium text-[#f59e0b]">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#f59e0b]" />
            {t("landing.hero.badge")}
          </span>

          <h1 className="max-w-3xl text-4xl font-bold leading-[1.1] tracking-tight text-white md:text-6xl">
            {t("landing.hero.titleA")}{" "}
            <span className="text-[#f59e0b]">{t("landing.hero.titleB")}</span>
          </h1>

          <p className="max-w-2xl text-base leading-relaxed text-[#9aa3ba] md:text-lg">
            {t("landing.hero.subtitle")}
          </p>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => setLocation("/signup")}
              className="inline-flex items-center gap-2 rounded-lg bg-[#f59e0b] px-6 py-3 text-base font-semibold text-[#0a0e1a] transition-all hover:bg-[#fbbf24] hover:shadow-[0_0_32px_rgba(245,158,11,0.45)]"
            >
              {t("landing.hero.ctaStart")}
              <ArrowRight className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => setLocation("/login")}
              className="inline-flex items-center gap-2 rounded-lg border border-[rgba(245,158,11,0.4)] px-6 py-3 text-base font-semibold text-[#f59e0b] transition-all hover:bg-[rgba(245,158,11,0.08)]"
            >
              {t("landing.hero.ctaLogin")}
              <ArrowRight className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => setContactOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-[rgba(255,255,255,0.14)] bg-[#161c2e] px-6 py-3 text-base font-semibold text-white transition-colors hover:border-[#f59e0b] hover:text-[#f59e0b]"
            >
              <Mail className="h-5 w-5" />
              {t("landing.hero.ctaDemo")}
            </button>
          </div>
        </section>

        {/* Feature grid */}
        <section ref={featuresRef} className="mt-24 grid scroll-mt-8 gap-4 md:grid-cols-3">
          <FeatureCard
            icon={<Mail className="h-5 w-5" />}
            title={t("landing.feature.inbound.title")}
            text={t("landing.feature.inbound.text")}
          />
          <FeatureCard
            icon={<Shield className="h-5 w-5" />}
            title={t("landing.feature.broker.title")}
            text={t("landing.feature.broker.text")}
          />
          <FeatureCard
            icon={<MapPin className="h-5 w-5" />}
            title={t("landing.feature.gps.title")}
            text={t("landing.feature.gps.text")}
          />
          <FeatureCard
            icon={<Gauge className="h-5 w-5" />}
            title={t("landing.feature.fuel.title")}
            text={t("landing.feature.fuel.text")}
          />
          <FeatureCard
            icon={<Truck className="h-5 w-5" />}
            title={t("landing.feature.ifta.title")}
            text={t("landing.feature.ifta.text")}
          />
          <FeatureCard
            icon={<Zap className="h-5 w-5" />}
            title={t("landing.feature.ai.title")}
            text={t("landing.feature.ai.text")}
          />
        </section>

        {/* Trust strip */}
        <section className="mt-20 rounded-xl border border-[rgba(255,255,255,0.08)] bg-gradient-to-b from-[#161c2e] to-[#0f1424] p-6 md:p-8">
          <div className="grid gap-4 md:grid-cols-3">
            <TrustItem
              label={t("landing.trust.updates.label")}
              value={t("landing.trust.updates.value")}
              hint={t("landing.trust.updates.hint")}
            />
            <TrustItem
              label={t("landing.trust.montgomery.label")}
              value={t("landing.trust.montgomery.value")}
              hint={t("landing.trust.montgomery.hint")}
            />
            <TrustItem
              label={t("landing.trust.small.label")}
              value={t("landing.trust.small.value")}
              hint={t("landing.trust.small.hint")}
            />
          </div>
        </section>

        {/* Newsletter + Contact */}
        <section ref={contactRef} className="mt-20 grid scroll-mt-8 gap-6 md:grid-cols-2">
          <SubscribeForm />
          <ContactInline onOpenFullForm={() => setContactOpen(true)} />
        </section>

        {/* Footer */}
        <footer className="mt-auto flex flex-col items-start justify-between gap-3 border-t border-[rgba(255,255,255,0.08)] pt-8 text-xs text-[#6b7390] md:flex-row md:items-center">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-[#34d399]" />
            <span>{t("landing.footer.copy", { year: new Date().getFullYear() })}</span>
          </div>
          <div className="flex items-center gap-4">
            <button type="button" onClick={() => setContactOpen(true)} className="hover:text-white">{t("common.contact")}</button>
            <button type="button" onClick={() => setLocation("/login")} className="hover:text-white">{t("common.login")}</button>
          </div>
        </footer>
      </div>

      {contactOpen && <ContactModal onClose={() => setContactOpen(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable bits
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Newsletter / subscribe form (email-only)
// ---------------------------------------------------------------------------

function SubscribeForm() {
  const { t } = useT();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "submitting" }
    | { kind: "ok"; duplicate: boolean }
    | { kind: "err"; message: string }
  >({ kind: "idle" });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || state.kind === "submitting") return;
    setState({ kind: "submitting" });
    try {
      const res = await fetch("/api/public/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          lang: typeof navigator !== "undefined" ? navigator.language?.slice(0, 8) : undefined,
          referer: typeof document !== "undefined" ? document.referrer?.slice(0, 500) || undefined : undefined,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null;
        setState({
          kind: "err",
          message: data?.message || `${t("landing.subscribe.errorPrefix")} ${res.status}`,
        });
        return;
      }
      const data = (await res.json()) as { duplicate?: boolean };
      setState({ kind: "ok", duplicate: !!data.duplicate });
    } catch (err) {
      setState({ kind: "err", message: (err as Error).message });
    }
  }

  return (
    <div className="rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#161c2e]/60 p-6">
      <h3 className="text-base font-semibold text-white">{t("landing.subscribe.title")}</h3>
      <p className="mt-1 text-sm text-[#9aa3ba]">{t("landing.subscribe.subtitle")}</p>

      {state.kind === "ok" ? (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-[rgba(52,211,153,0.25)] bg-[rgba(52,211,153,0.06)] p-3 text-sm text-[#34d399]">
          <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div>
            {state.duplicate
              ? t("landing.subscribe.duplicateShort")
              : t("landing.subscribe.okShort")}
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            type="email"
            required
            autoComplete="email"
            placeholder={t("landing.subscribe.placeholder")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={state.kind === "submitting"}
            className="flex-1 rounded-lg border border-[rgba(255,255,255,0.14)] bg-[#0a0e1a] px-4 py-2.5 text-sm text-white placeholder:text-[#6b7390] outline-none transition-colors focus:border-[#f59e0b] disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={state.kind === "submitting" || !email}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#f59e0b] px-4 py-2.5 text-sm font-semibold text-[#0a0e1a] transition-all hover:bg-[#fbbf24] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state.kind === "submitting" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> {t("landing.subscribe.submitting")}
              </>
            ) : (
              <>{t("landing.subscribe.cta")} <ArrowRight className="h-4 w-4" /></>
            )}
          </button>
        </form>
      )}

      {state.kind === "err" && (
        <p className="mt-3 text-xs text-[#f87171]">{state.message}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contact inline block (CTA) — opens full modal
// ---------------------------------------------------------------------------

function ContactInline({ onOpenFullForm }: { onOpenFullForm: () => void }) {
  const { t } = useT();
  return (
    <div className="rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#161c2e]/60 p-6">
      <h3 className="text-base font-semibold text-white">{t("landing.contact.title")}</h3>
      <p className="mt-1 text-sm text-[#9aa3ba]">{t("landing.contact.subtitle")}</p>
      <button
        type="button"
        onClick={onOpenFullForm}
        className="mt-4 inline-flex items-center gap-2 rounded-lg border border-[rgba(255,255,255,0.14)] bg-[#0a0e1a] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:border-[#f59e0b] hover:text-[#f59e0b]"
      >
        <Mail className="h-4 w-4" />
        {t("landing.contact.cta")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contact modal (full form: name + email + note)
// ---------------------------------------------------------------------------

function ContactModal({ onClose }: { onClose: () => void }) {
  const { t, lang } = useT();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "submitting" }
    | { kind: "ok"; duplicate: boolean }
    | { kind: "err"; message: string }
  >({ kind: "idle" });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (state.kind === "submitting") return;
    setState({ kind: "submitting" });
    try {
      const res = await fetch("/api/public/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          name: name || undefined,
          note: note || undefined,
          lang: typeof navigator !== "undefined" ? navigator.language?.slice(0, 8) : undefined,
          referer: typeof document !== "undefined" ? document.referrer?.slice(0, 500) || undefined : undefined,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null;
        setState({
          kind: "err",
          message: data?.message || `${t("landing.subscribe.errorPrefix")} ${res.status}`,
        });
        return;
      }
      const data = (await res.json()) as { duplicate?: boolean };
      setState({ kind: "ok", duplicate: !!data.duplicate });
    } catch (err) {
      setState({ kind: "err", message: (err as Error).message });
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(10,14,26,0.85)] p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-md rounded-xl border border-[rgba(255,255,255,0.12)] bg-[#161c2e] p-6 shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          aria-label={t("landing.contact.closeAria")}
          className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-md text-[#9aa3ba] hover:bg-[#0f1424] hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>

        <h3 className="text-lg font-semibold text-white">{t("landing.contact.modalTitle")}</h3>
        <p className="mt-1 text-sm text-[#9aa3ba]">{t("landing.contact.modalSubtitle")}</p>

        {state.kind === "ok" ? (
          <div className="mt-5 flex flex-col items-start gap-3 rounded-lg border border-[rgba(52,211,153,0.25)] bg-[rgba(52,211,153,0.06)] p-4 text-sm text-[#34d399]">
            <CheckCircle2 className="h-5 w-5" />
            <div>
              {state.duplicate
                ? t("landing.subscribe.duplicate")
                : t("landing.contact.ok")}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="ml-auto inline-flex items-center gap-2 rounded-md border border-[rgba(52,211,153,0.3)] px-3 py-1.5 text-xs font-medium text-[#34d399] hover:bg-[rgba(52,211,153,0.1)]"
            >
              {t("common.close")}
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-5 space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-[#9aa3ba]">{t("landing.contact.nameLabel")}</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                placeholder={t("landing.contact.namePlaceholder")}
                disabled={state.kind === "submitting"}
                className="w-full rounded-lg border border-[rgba(255,255,255,0.14)] bg-[#0a0e1a] px-3 py-2 text-sm text-white placeholder:text-[#6b7390] outline-none focus:border-[#f59e0b]"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[#9aa3ba]">{t("landing.contact.emailLabel")}</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                placeholder="you@trucking.co"
                disabled={state.kind === "submitting"}
                className="w-full rounded-lg border border-[rgba(255,255,255,0.14)] bg-[#0a0e1a] px-3 py-2 text-sm text-white placeholder:text-[#6b7390] outline-none focus:border-[#f59e0b]"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[#9aa3ba]">{t("landing.contact.noteLabel")}</label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={4}
                maxLength={2000}
                placeholder={t("landing.contact.notePlaceholder2")}
                disabled={state.kind === "submitting"}
                className="w-full resize-none rounded-lg border border-[rgba(255,255,255,0.14)] bg-[#0a0e1a] px-3 py-2 text-sm text-white placeholder:text-[#6b7390] outline-none focus:border-[#f59e0b]"
              />
            </div>

            {state.kind === "err" && (
              <p className="text-xs text-[#f87171]">{state.message}</p>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                disabled={state.kind === "submitting"}
                className="rounded-lg border border-[rgba(255,255,255,0.14)] bg-transparent px-4 py-2 text-sm font-medium text-[#9aa3ba] hover:text-white"
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                disabled={state.kind === "submitting" || !email}
                className="inline-flex items-center gap-2 rounded-lg bg-[#f59e0b] px-4 py-2 text-sm font-semibold text-[#0a0e1a] transition-all hover:bg-[#fbbf24] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {state.kind === "submitting" ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> {t("common.sending")}
                  </>
                ) : (
                  <>{t("common.send")} <ArrowRight className="h-4 w-4" /></>
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
