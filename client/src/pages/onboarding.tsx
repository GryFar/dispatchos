// =============================================================================
// Onboarding wizard — invite → persona → credentials → company → docs → plan → done
// =============================================================================
//
// Per user request 2026-05-26: "когда тебе дали инвайт ссылку, надо сделать
// onboarding форму красивую типо, чтобы человек заполнял там данные-документы..
// если овнер оператор соответственно одни документы, если компания то другие..
// разница цен конечно должна быть в случае если ентерпрайс то дороже, если
// овнер то дешевле".
//
// Wizard lives at `/onboarding`. Users land here from /signup after invite is
// consumed (signup auto-creates user + auto-logins, then redirects here).
// Server tracks progress via /api/me/onboarding so refresh / different device
// resumes from the last completed step.
//
// Steps:
//   0 — Welcome (intro + "Continue")
//   1 — Persona (owner-operator | fleet | enterprise)
//   2 — Company info (MC#, DOT#, fleet size — varies by persona)
//   3 — Plan selection (filtered by persona — owner sees $19/$29, fleet sees $49/$79/$129)
//   4 — Done
//
// Document upload + Telegram connect are reused from existing screens
// (driver portal /me/documents, admin /clients/:id/documents). The wizard
// links to them rather than re-implementing.
// -----------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  CheckCircle2,
  Crown,
  Loader2,
  Sparkles,
  Truck,
} from "lucide-react";
import { useAuth } from "@/lib/use-auth";
import { apiJson, ApiError } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Persona = "owner_operator" | "fleet" | "enterprise";

interface PlanDto {
  tier: string;
  label: string;
  persona: Persona;
  monthlyCents: number;
  includedDriverSeats: number;
  additionalDriverCents: number;
  includedDispatcherSeats: number;
  maxMcCount: number | null;
  auditRetentionDays: number;
  features: {
    carrierSafetyProfile: boolean;
    counterpartyVettingPremium: boolean;
    priorityCron: boolean;
    apiAccess: boolean;
    ssoSaml: boolean;
  };
}

interface ProgressDto {
  userId: string;
  step: number;
  data: Record<string, unknown>;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
}

const STEP_KEYS = [
  "onboarding.steps.welcome",
  "onboarding.steps.accountType",
  "onboarding.steps.company",
  "onboarding.steps.plan",
  "onboarding.steps.done",
];

export default function OnboardingPage() {
  const { user, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { t } = useT();

  const [step, setStep] = useState(0);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [companyName, setCompanyName] = useState("");
  const [mc, setMc] = useState("");
  const [dot, setDot] = useState("");
  const [fleetSize, setFleetSize] = useState<string>("");
  const [planTier, setPlanTier] = useState<string>("");

  // MC lookup is lifted to the page so the footer Continue button can read its
  // hard-block result (claimedByOther / out-of-service) and gate advancement,
  // not just whether an MC string was typed.
  const { result: mcLookup, loading: mcLoading } = useMcLookup(mc);
  const mcHardBlocked = Boolean(
    mcLookup?.claimedByOther || (mcLookup?.found && mcLookup?.blocked),
  );

  // Auth gate — if not logged in, send to login. If onboarding already complete,
  // send to role-default route.
  useEffect(() => {
    if (authLoading) return;
    if (!user) setLocation("/login");
  }, [user, authLoading, setLocation]);

  // Pull existing progress on mount — resume from last step.
  const progressQ = useQuery<{ progress: ProgressDto; hasStarted: boolean; hasCompleted: boolean }>({
    queryKey: ["/api/me/onboarding"],
    enabled: Boolean(user),
  });

  useEffect(() => {
    const p = progressQ.data?.progress;
    if (!p) return;
    if (progressQ.data?.hasCompleted) {
      // Already done — bounce out.
      const role = user?.role;
      setLocation(
        role === "admin" ? "/admin" : role === "dispatcher" ? "/dispatch" : "/d",
      );
      return;
    }
    const d = p.data || {};
    // Steps 2+ (company / plan) depend on persona to filter plans and toggle
    // fleet-only fields. Older / partial records (or a goBack that persisted
    // only `step`) may land here past step 1 with no persona, which would
    // dead-end the user on an empty plan list. Clamp back to the persona step
    // so they re-pick rather than getting stuck.
    const resumeStep = p.step ?? 0;
    setStep(resumeStep >= 2 && typeof d.persona !== "string" ? 1 : resumeStep);
    if (typeof d.persona === "string") setPersona(d.persona as Persona);
    if (typeof d.companyName === "string") setCompanyName(d.companyName);
    if (typeof d.mc === "string") setMc(d.mc);
    if (typeof d.dot === "string") setDot(d.dot);
    if (typeof d.fleetSize === "string") setFleetSize(d.fleetSize);
    if (typeof d.planTier === "string") setPlanTier(d.planTier);
  }, [progressQ.data, user, setLocation]);

  // Pricing catalogue — public endpoint, no auth needed.
  const pricingQ = useQuery<{ plans: PlanDto[]; trialDays: number }>({
    queryKey: ["/api/public/pricing"],
  });

  const saveMutation = useMutation({
    mutationFn: (input: {
      step: number;
      data?: Record<string, unknown>;
      completed?: boolean;
    }) => apiJson("PATCH", "/api/me/onboarding", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/me/onboarding"] });
    },
  });

  async function goNext() {
    const dataPatch: Record<string, unknown> = {};
    if (persona) dataPatch.persona = persona;
    if (companyName) dataPatch.companyName = companyName;
    if (mc) dataPatch.mc = mc;
    if (dot) dataPatch.dot = dot;
    if (fleetSize) dataPatch.fleetSize = fleetSize;
    if (planTier) dataPatch.planTier = planTier;

    const next = step + 1;
    const isFinal = next === STEP_KEYS.length - 1;

    try {
      await saveMutation.mutateAsync({
        step: next,
        data: dataPatch,
        completed: isFinal || undefined,
      });
      setStep(next);
      if (isFinal) {
        toast({
          title: t("onboarding.toast.welcome.title"),
          description: t("onboarding.toast.welcome.description"),
        });
      }
    } catch (err) {
      // Hard gates (MC authority/uniqueness, persona, provision) return stable
      // machine `code`s — map them to localized copy instead of toasting the
      // raw server message at the exact moment the user is refused a trial.
      const code =
        err instanceof ApiError ? (err.body as { code?: string } | null)?.code : undefined;
      const codeKey =
        code === "mc_not_authorized"
          ? "onboarding.error.mcNotAuthorized"
          : code === "mc_already_claimed"
            ? "onboarding.error.mcAlreadyClaimed"
            : code === "mc_required_to_complete"
              ? "onboarding.error.mcRequired"
              : code === "persona_required_to_complete"
                ? "onboarding.error.personaRequired"
                : code === "provision_failed"
                  ? "onboarding.error.provisionFailed"
                  : null;
      toast({
        title: t("onboarding.toast.saveError.title"),
        description: codeKey ? t(codeKey) : (err as Error).message,
        variant: "destructive",
      });
    }
  }

  function goBack() {
    if (step <= 0) return;
    setStep(step - 1);
    // Persist the rewind so a refresh stays at the right step.
    void saveMutation.mutateAsync({ step: step - 1 });
  }

  function finishToPortal() {
    const role = user?.role;
    setLocation(
      role === "admin" ? "/admin" : role === "dispatcher" ? "/dispatch" : "/d",
    );
  }

  if (authLoading || progressQ.isLoading || !user) {
    // !user: the redirect to /login fires from an effect (post-render), so
    // hold the loader here to avoid flashing the wizard body for one frame
    // with a null user before the bounce lands.
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0e1a]">
        <Loader2 className="h-8 w-8 animate-spin text-[#f59e0b]" />
      </div>
    );
  }

  const canAdvance =
    step === 0 ||
    (step === 1 && Boolean(persona)) ||
    (step === 2 && Boolean(mc) && !mcHardBlocked) ||
    (step === 3 && Boolean(planTier));

  return (
    <div className="relative min-h-screen bg-[#0a0e1a] text-[#e8ecf5]">
      {/* Background grid */}
      <div
        aria-hidden
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

      <div className="relative z-10 mx-auto flex min-h-screen max-w-3xl flex-col px-6 py-12">
        {/* Header — progress dots */}
        <div className="mb-10 flex items-center gap-2">
          <div className="flex items-center gap-2 text-sm font-bold tracking-tight text-white">
            <svg width="28" height="28" viewBox="0 0 32 32">
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
            DispatchOS
          </div>
          <div className="ml-auto flex items-center gap-2">
            {STEP_KEYS.map((labelKey, idx) => (
              <div key={labelKey} className="flex items-center gap-1.5">
                <div
                  className={`h-2 w-2 rounded-full transition-colors ${
                    idx === step
                      ? "bg-[#f59e0b]"
                      : idx < step
                      ? "bg-[#34d399]"
                      : "bg-[rgba(255,255,255,0.12)]"
                  }`}
                />
                <span
                  className={`hidden text-xs sm:inline ${
                    idx === step ? "text-white" : "text-[#6b7390]"
                  }`}
                >
                  {t(labelKey)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Step content */}
        <div className="flex flex-1 items-center">
          <div className="w-full">
            {step === 0 && <WelcomeStep userName={user?.fullName ?? ""} />}
            {step === 1 && (
              <PersonaStep
                value={persona}
                onChange={setPersona}
              />
            )}
            {step === 2 && (
              <CompanyStep
                persona={persona}
                companyName={companyName}
                setCompanyName={setCompanyName}
                mc={mc}
                setMc={setMc}
                dot={dot}
                setDot={setDot}
                fleetSize={fleetSize}
                setFleetSize={setFleetSize}
                mcLookup={mcLookup}
                mcLoading={mcLoading}
              />
            )}
            {step === 3 && (
              <PlanStep
                persona={persona}
                plans={pricingQ.data?.plans ?? []}
                trialDays={pricingQ.data?.trialDays ?? 14}
                value={planTier}
                onChange={setPlanTier}
              />
            )}
            {step === 4 && <DoneStep onContinue={finishToPortal} />}
          </div>
        </div>

        {/* Footer — navigation */}
        {step < STEP_KEYS.length - 1 && (
          <div className="mt-10 flex items-center justify-between">
            <Button
              variant="ghost"
              onClick={goBack}
              disabled={step === 0 || saveMutation.isPending}
              className="text-[#9aa3ba] hover:text-white"
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              {t("onboarding.nav.back")}
            </Button>
            <Button
              onClick={goNext}
              disabled={!canAdvance || saveMutation.isPending}
              className="bg-[#f59e0b] text-[#0a0e1a] hover:bg-[#fbbf24]"
            >
              {saveMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              {step === STEP_KEYS.length - 2
                ? t("onboarding.nav.startTrial")
                : t("onboarding.nav.continue")}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Step components
// ============================================================================

function WelcomeStep({ userName }: { userName: string }) {
  const { t } = useT();
  return (
    <div className="space-y-6">
      <div className="inline-flex items-center gap-2 rounded-full border border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.08)] px-3 py-1 text-xs font-medium text-[#f59e0b]">
        <Sparkles className="h-3 w-3" />
        {t("onboarding.welcome.badge")}
      </div>
      <h1 className="text-4xl font-bold leading-tight tracking-tight text-white md:text-5xl">
        {userName
          ? t("onboarding.welcome.greetingNamed", { name: userName })
          : t("onboarding.welcome.greeting")}
        <br />
        <span className="text-[#f59e0b]">{t("onboarding.welcome.tagline")}</span>
      </h1>
      <p className="max-w-xl text-base leading-relaxed text-[#9aa3ba]">
        {t("onboarding.welcome.subtitle")}
      </p>
    </div>
  );
}

function PersonaStep({
  value,
  onChange,
}: {
  value: Persona | null;
  onChange: (p: Persona) => void;
}) {
  const { t } = useT();
  const tiles: Array<{
    id: Persona;
    icon: React.ReactNode;
    title: string;
    description: string;
    priceHint: string;
    bullets: string[];
  }> = [
    {
      id: "owner_operator",
      icon: <Truck className="h-7 w-7" />,
      title: t("onboarding.persona.owner.title"),
      description: t("onboarding.persona.owner.description"),
      priceHint: t("onboarding.persona.owner.priceHint"),
      bullets: [
        t("onboarding.persona.owner.bullet1"),
        t("onboarding.persona.owner.bullet2"),
        t("onboarding.persona.owner.bullet3"),
      ],
    },
    {
      id: "fleet",
      icon: <Building2 className="h-7 w-7" />,
      title: t("onboarding.persona.fleet.title"),
      description: t("onboarding.persona.fleet.description"),
      priceHint: t("onboarding.persona.fleet.priceHint"),
      bullets: [
        t("onboarding.persona.fleet.bullet1"),
        t("onboarding.persona.fleet.bullet2"),
        t("onboarding.persona.fleet.bullet3"),
      ],
    },
    {
      id: "enterprise",
      icon: <Crown className="h-7 w-7" />,
      title: t("onboarding.persona.enterprise.title"),
      description: t("onboarding.persona.enterprise.description"),
      priceHint: t("onboarding.persona.enterprise.priceHint"),
      bullets: [
        t("onboarding.persona.enterprise.bullet1"),
        t("onboarding.persona.enterprise.bullet2"),
        t("onboarding.persona.enterprise.bullet3"),
      ],
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold leading-tight tracking-tight text-white md:text-4xl">
        {t("onboarding.persona.heading")}
      </h1>
      <p className="text-[#9aa3ba]">{t("onboarding.persona.subtitle")}</p>
      <div className="grid gap-4 sm:grid-cols-3">
        {tiles.map((tile) => {
          const selected = value === tile.id;
          return (
            <button
              key={tile.id}
              type="button"
              onClick={() => onChange(tile.id)}
              className={`group relative flex flex-col gap-3 rounded-xl border p-5 text-left transition-all ${
                selected
                  ? "border-[#f59e0b] bg-[rgba(245,158,11,0.06)] shadow-[0_0_28px_rgba(245,158,11,0.18)]"
                  : "border-[rgba(255,255,255,0.1)] bg-[#161c2e]/60 hover:border-[rgba(245,158,11,0.4)]"
              }`}
            >
              <div
                className={`inline-flex h-12 w-12 items-center justify-center rounded-lg ${
                  selected
                    ? "bg-[#f59e0b] text-[#0a0e1a]"
                    : "bg-[rgba(245,158,11,0.12)] text-[#f59e0b]"
                }`}
              >
                {tile.icon}
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">{tile.title}</h3>
                <p className="text-sm text-[#9aa3ba]">{tile.description}</p>
              </div>
              <ul className="space-y-1 text-xs text-[#9aa3ba]">
                {tile.bullets.map((b) => (
                  <li key={b} className="flex items-start gap-1.5">
                    <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-[#34d399]" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-auto pt-2 text-xs font-semibold text-[#f59e0b]">
                {tile.priceHint}
              </div>
              {selected && (
                <CheckCircle2 className="absolute right-3 top-3 h-5 w-5 text-[#f59e0b]" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * MC lookup response shape (from GET /api/onboarding/mc-lookup).
 *
 * The endpoint is deliberately graceful — it always returns 200 with
 * `found: boolean` even when FMCSA is down or the docket doesn't exist.
 * That lets the UI surface a soft warning instead of erroring out, while
 * the hard `mc_already_claimed` gate still runs server-side on save.
 */
type McLookupResult = {
  mc: string;
  found: boolean;
  claimedByOther: boolean;
  fmcsaConfigured: boolean;
  blocked?: boolean;
  legalName?: string;
  dotNumber?: string | null;
  state?: string | null;
  operatingStatus?: string;
  authority?: string;
};

/**
 * Debounced MC lookup hook.
 *
 * Fires GET /api/onboarding/mc-lookup 500ms after the user stops typing,
 * and only when the input has at least 3 numeric chars (anything shorter
 * is guaranteed to be a partial entry). Aborts in-flight requests when
 * the input changes, so we never apply a stale autofill on top of a
 * newer one. Returns null while idle / loading-without-prior-result so
 * the caller can render a skeleton.
 */
function useMcLookup(mc: string): { result: McLookupResult | null; loading: boolean } {
  const [result, setResult] = useState<McLookupResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const digits = mc.replace(/\D/g, "");
    if (digits.length < 3) {
      setResult(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/onboarding/mc-lookup?mc=${encodeURIComponent(mc)}`, {
          credentials: "include",
          signal: controller.signal,
        });
        if (!res.ok) {
          setResult(null);
          return;
        }
        const data = (await res.json()) as McLookupResult;
        setResult(data);
      } catch (err) {
        // AbortError on re-typing is expected; everything else is silent
        // (uniqueness check still happens server-side on save).
        if ((err as Error).name !== "AbortError") setResult(null);
      } finally {
        setLoading(false);
      }
    }, 500);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [mc]);

  return { result, loading };
}

function CompanyStep({
  persona,
  companyName,
  setCompanyName,
  mc,
  setMc,
  dot,
  setDot,
  fleetSize,
  setFleetSize,
  mcLookup,
  mcLoading,
}: {
  persona: Persona | null;
  companyName: string;
  setCompanyName: (s: string) => void;
  mc: string;
  setMc: (s: string) => void;
  dot: string;
  setDot: (s: string) => void;
  fleetSize: string;
  setFleetSize: (s: string) => void;
  mcLookup: McLookupResult | null;
  mcLoading: boolean;
}) {
  const { t } = useT();
  const isFleet = persona === "fleet" || persona === "enterprise";

  // Auto-fill empty companyName + DOT once a SAFER hit arrives; never
  // overwrite something the user already typed (they could be correcting
  // a discrepancy with the docket).
  useEffect(() => {
    if (!mcLookup?.found) return;
    if (!companyName && mcLookup.legalName) {
      setCompanyName(mcLookup.legalName);
    }
    if (!dot && mcLookup.dotNumber) {
      setDot(mcLookup.dotNumber);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcLookup?.found, mcLookup?.legalName, mcLookup?.dotNumber]);

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold leading-tight tracking-tight text-white md:text-4xl">
        {isFleet
          ? t("onboarding.company.heading.fleet")
          : t("onboarding.company.heading.owner")}
      </h1>
      <p className="text-[#9aa3ba]">{t("onboarding.company.subtitle")}</p>

      <div className="space-y-4 rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#161c2e]/40 p-5">
        <div className="space-y-1.5">
          <Label className="text-xs text-[#9aa3ba]">{t("onboarding.company.name.label")}</Label>
          <Input
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder={t("onboarding.company.name.placeholder")}
            className="border-[rgba(255,255,255,0.14)] bg-[#0a0e1a] text-white placeholder:text-[#6b7390]"
          />
          <p className="text-[10px] text-[#6b7390]">
            {persona === "owner_operator"
              ? t("onboarding.company.name.hint.owner")
              : t("onboarding.company.name.hint.fleet")}
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs text-[#9aa3ba]">{t("onboarding.company.mc.label")}</Label>
            <Input
              value={mc}
              onChange={(e) => setMc(e.target.value.toUpperCase())}
              placeholder="MC-123456"
              className="border-[rgba(255,255,255,0.14)] bg-[#0a0e1a] text-white placeholder:text-[#6b7390]"
            />
            <p className="flex items-center gap-1.5 text-[10px] text-[#6b7390]">
              {mcLoading ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>{t("onboarding.company.mc.checking")}</span>
                </>
              ) : (
                <span>{t("onboarding.company.mc.hint")}</span>
              )}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-[#9aa3ba]">{t("onboarding.company.dot.label")}</Label>
            <Input
              value={dot}
              inputMode="numeric"
              onChange={(e) => setDot(e.target.value.replace(/\D/g, ""))}
              placeholder="3456789"
              className="border-[rgba(255,255,255,0.14)] bg-[#0a0e1a] text-white placeholder:text-[#6b7390]"
            />
          </div>
        </div>

        {/* SAFER feedback panels — stacked, hardest signal first. */}
        <McLookupFeedback result={mcLookup} loading={mcLoading} mc={mc} />

        {isFleet && (
          <div className="space-y-1.5">
            <Label className="text-xs text-[#9aa3ba]">{t("onboarding.company.fleetSize.label")}</Label>
            <select
              value={fleetSize}
              onChange={(e) => setFleetSize(e.target.value)}
              className="h-10 w-full rounded-md border border-[rgba(255,255,255,0.14)] bg-[#0a0e1a] px-3 text-sm text-white"
            >
              <option value="">{t("onboarding.company.fleetSize.placeholder")}</option>
              <option value="2-5">{t("onboarding.company.fleetSize.opt.2to5")}</option>
              <option value="6-20">{t("onboarding.company.fleetSize.opt.6to20")}</option>
              <option value="21-50">{t("onboarding.company.fleetSize.opt.21to50")}</option>
              <option value="50+">{t("onboarding.company.fleetSize.opt.50plus")}</option>
            </select>
          </div>
        )}

        {!isFleet && (
          <p className="rounded-md border border-[rgba(52,211,153,0.2)] bg-[rgba(52,211,153,0.05)] p-3 text-xs text-[#34d399]">
            {t("onboarding.company.ownerNote")}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Render the result of the MC lookup as a tiered set of alerts.
 *
 * Severity order (hardest gate first — the user should see the show-stopper
 * before they read about the autofill that just happened):
 *   1. claimedByOther    → hard red: server WILL 409 on save
 *   2. blocked           → hard red: OUT_OF_SERVICE / NOT_AUTHORIZED at FMCSA
 *   3. found + clean     → soft green: autofill succeeded, here's the legal name
 *   4. not found         → soft amber: docket not in SAFER (typo? brand-new auth?)
 *
 * `fmcsaConfigured=false` means we have no FMCSA_WEBKEY in env, so we skip
 * the network entirely and only the uniqueness check ran — don't pretend we
 * verified the docket.
 */
function McLookupFeedback({
  result,
  loading,
  mc,
}: {
  result: McLookupResult | null;
  loading: boolean;
  mc: string;
}) {
  const { t } = useT();
  if (loading || !result || !mc) return null;

  if (result.claimedByOther) {
    return (
      <div className="rounded-md border border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.08)] p-3 text-xs text-[#fca5a5]">
        <p className="font-semibold">{t("onboarding.mcLookup.claimed.title")}</p>
        <p className="mt-1 text-[#fca5a5]/80">
          {t("onboarding.mcLookup.claimed.body")}
        </p>
      </div>
    );
  }

  if (result.found && result.blocked) {
    return (
      <div className="rounded-md border border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.08)] p-3 text-xs text-[#fca5a5]">
        <p className="font-semibold">
          {t("onboarding.mcLookup.blocked.title", {
            status: result.operatingStatus ?? "INACTIVE",
          })}
        </p>
        <p className="mt-1 text-[#fca5a5]/80">
          {t("onboarding.mcLookup.blocked.body")}
        </p>
      </div>
    );
  }

  if (result.found) {
    return (
      <div className="rounded-md border border-[rgba(52,211,153,0.25)] bg-[rgba(52,211,153,0.06)] p-3 text-xs text-[#34d399]">
        <p className="font-semibold">{t("onboarding.mcLookup.found.title")}</p>
        <p className="mt-1 text-[#34d399]/80">
          {[
            result.legalName,
            result.dotNumber && `DOT ${result.dotNumber}`,
            result.state,
            result.operatingStatus && result.operatingStatus !== "AUTHORIZED"
              ? result.operatingStatus
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
    );
  }

  // not-found branch: differentiate "FMCSA not configured" (we genuinely
  // didn't check) from "FMCSA checked and docket missing" (suspicious).
  if (!result.fmcsaConfigured) {
    return (
      <p className="text-[10px] text-[#6b7390]">
        {t("onboarding.mcLookup.notConfigured")}
      </p>
    );
  }

  return (
    <div className="rounded-md border border-[rgba(245,158,11,0.25)] bg-[rgba(245,158,11,0.06)] p-3 text-xs text-[#fbbf24]">
      <p className="font-semibold">{t("onboarding.mcLookup.notFound.title")}</p>
      <p className="mt-1 text-[#fbbf24]/80">
        {t("onboarding.mcLookup.notFound.body")}
      </p>
    </div>
  );
}

function PlanStep({
  persona,
  plans,
  trialDays,
  value,
  onChange,
}: {
  persona: Persona | null;
  plans: PlanDto[];
  trialDays: number;
  value: string;
  onChange: (tier: string) => void;
}) {
  const { t } = useT();
  const filtered = plans.filter((p) => p.persona === persona);

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold leading-tight tracking-tight text-white md:text-4xl">
        {t("onboarding.plan.heading")}
      </h1>
      <p className="text-[#9aa3ba]">
        {t("onboarding.plan.subtitle", { days: trialDays })}
      </p>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {filtered.map((plan) => {
          const selected = value === plan.tier;
          return (
            <button
              key={plan.tier}
              type="button"
              onClick={() => onChange(plan.tier)}
              className={`group relative flex flex-col gap-3 rounded-xl border p-5 text-left transition-all ${
                selected
                  ? "border-[#f59e0b] bg-[rgba(245,158,11,0.06)] shadow-[0_0_28px_rgba(245,158,11,0.18)]"
                  : "border-[rgba(255,255,255,0.1)] bg-[#161c2e]/60 hover:border-[rgba(245,158,11,0.4)]"
              }`}
            >
              <div className="flex items-baseline justify-between">
                <h3 className="text-base font-semibold text-white">{plan.label}</h3>
                {selected && <CheckCircle2 className="h-5 w-5 text-[#f59e0b]" />}
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-3xl font-bold text-white">
                  ${(plan.monthlyCents / 100).toFixed(0)}
                </span>
                <span className="text-sm text-[#9aa3ba]">{t("onboarding.plan.perMonth")}</span>
              </div>
              {/* Fee disclosure near the price — the 3% success fee applies only
                  to platform-sourced loads and is capped monthly at 2× plan. */}
              <p className="text-[11px] leading-snug text-[#6b7390]">
                {t("onboarding.plan.feeDisclosure")}
              </p>
              <ul className="space-y-1.5 text-xs text-[#9aa3ba]">
                <li className="flex items-start gap-1.5">
                  <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-[#34d399]" />
                  <span>
                    {plan.includedDriverSeats === 999
                      ? t("onboarding.plan.driverSeats.unlimited")
                      : t("onboarding.plan.driverSeats.count", {
                          count: plan.includedDriverSeats,
                        })}
                    {plan.additionalDriverCents > 0
                      ? t("onboarding.plan.driverSeats.additional", {
                          price: (plan.additionalDriverCents / 100).toFixed(0),
                        })
                      : ""}
                  </span>
                </li>
                {plan.includedDispatcherSeats > 0 && (
                  <li className="flex items-start gap-1.5">
                    <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-[#34d399]" />
                    <span>
                      {plan.includedDispatcherSeats === 999
                        ? t("onboarding.plan.dispatcherSeats.unlimited")
                        : t("onboarding.plan.dispatcherSeats.count", {
                            count: plan.includedDispatcherSeats,
                          })}
                    </span>
                  </li>
                )}
                <li className="flex items-start gap-1.5">
                  <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-[#34d399]" />
                  <span>
                    {plan.maxMcCount === null || plan.maxMcCount >= 999
                      ? t("onboarding.plan.mcs.unlimited")
                      : t("onboarding.plan.mcs.count", { count: plan.maxMcCount })}
                  </span>
                </li>
                {plan.features.carrierSafetyProfile && (
                  <li className="flex items-start gap-1.5">
                    <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-[#34d399]" />
                    <span>{t("onboarding.plan.feature.carrierSafetyProfile")}</span>
                  </li>
                )}
                {plan.features.counterpartyVettingPremium && (
                  <li className="flex items-start gap-1.5">
                    <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-[#34d399]" />
                    <span>{t("onboarding.plan.feature.counterpartyVetting")}</span>
                  </li>
                )}
                {/* «REST API + webhooks» and «SSO / SAML» bullets intentionally
                    not rendered — those integrations aren't built yet, so we
                    don't advertise them (plans.ts feature flags are untouched). */}
                <li className="text-[10px] text-[#6b7390]">
                  {t("onboarding.plan.auditRetention", { days: plan.auditRetentionDays })}
                </li>
              </ul>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DoneStep({ onContinue }: { onContinue: () => void }) {
  const { t } = useT();
  const { toast } = useToast();
  const [connecting, setConnecting] = useState(false);

  // Resolve the REAL driver bot (getMe on the webhook token, server-cached) —
  // a hardcoded username here once pointed every customer at the wrong bot.
  const botInfoQ = useQuery<{ configured: boolean; username: string | null }>({
    queryKey: ["/api/telegram/bot-info"],
  });
  const botUsername = botInfoQ.data?.configured ? botInfoQ.data.username : null;

  // Mint a one-time link code and open the t.me deep link: the bot receives
  // "/start <code>" and binds this chat to the logged-in account — the only
  // link path a self-serve owner has (no driver invite to redeem).
  async function connectTelegram() {
    if (!botUsername) return;
    setConnecting(true);
    try {
      const res = await apiJson<{ deepLink: string | null }>(
        "POST",
        "/api/me/telegram/link-code",
        {},
      );
      window.open(
        res.deepLink ?? `https://t.me/${botUsername}`,
        "_blank",
        "noopener,noreferrer",
      );
    } catch (err) {
      toast({
        title: t("onboarding.done.telegramLinkFailed"),
        description: (err as Error).message,
        variant: "destructive",
      });
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="inline-flex items-center gap-2 rounded-full border border-[rgba(52,211,153,0.3)] bg-[rgba(52,211,153,0.08)] px-3 py-1 text-xs font-medium text-[#34d399]">
        <CheckCircle2 className="h-3 w-3" />
        {t("onboarding.done.badge")}
      </div>
      <h1 className="text-4xl font-bold leading-tight tracking-tight text-white md:text-5xl">
        {t("onboarding.done.heading")}
      </h1>
      <p className="max-w-xl text-base leading-relaxed text-[#9aa3ba]">
        {t("onboarding.done.subtitle")}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Button
          onClick={onContinue}
          className="bg-[#f59e0b] text-[#0a0e1a] hover:bg-[#fbbf24]"
        >
          {t("onboarding.done.gotoDashboard")}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
        {botInfoQ.isLoading || botUsername ? (
          <Button
            variant="outline"
            onClick={connectTelegram}
            disabled={connecting || !botUsername}
            className="border-[rgba(255,255,255,0.14)] bg-transparent text-white hover:bg-[rgba(255,255,255,0.06)]"
          >
            {connecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t("onboarding.done.connectTelegram")}
          </Button>
        ) : (
          <p className="self-center text-xs text-[#6b7390]">
            {t("onboarding.done.telegramNotConfigured")}
          </p>
        )}
      </div>
    </div>
  );
}
