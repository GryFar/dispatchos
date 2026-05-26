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
import { apiJson } from "@/lib/queryClient";
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

const STEP_LABELS = ["Welcome", "Account type", "Company", "Plan", "Done"];

export default function OnboardingPage() {
  const { user, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { t: _t } = useT();

  const [step, setStep] = useState(0);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [companyName, setCompanyName] = useState("");
  const [mc, setMc] = useState("");
  const [dot, setDot] = useState("");
  const [fleetSize, setFleetSize] = useState<string>("");
  const [planTier, setPlanTier] = useState<string>("");

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
    setStep(p.step ?? 0);
    const d = p.data || {};
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
    const isFinal = next === STEP_LABELS.length - 1;

    try {
      await saveMutation.mutateAsync({
        step: next,
        data: dataPatch,
        completed: isFinal || undefined,
      });
      setStep(next);
      if (isFinal) {
        toast({ title: "🎉 Welcome to DispatchOS", description: "You're all set." });
      }
    } catch (err) {
      toast({
        title: "Не удалось сохранить",
        description: (err as Error).message,
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

  if (authLoading || progressQ.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0e1a]">
        <Loader2 className="h-8 w-8 animate-spin text-[#f59e0b]" />
      </div>
    );
  }

  const canAdvance =
    step === 0 ||
    (step === 1 && Boolean(persona)) ||
    (step === 2 && Boolean(mc)) ||
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
            {STEP_LABELS.map((label, idx) => (
              <div key={label} className="flex items-center gap-1.5">
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
                  {label}
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
        {step < STEP_LABELS.length - 1 && (
          <div className="mt-10 flex items-center justify-between">
            <Button
              variant="ghost"
              onClick={goBack}
              disabled={step === 0 || saveMutation.isPending}
              className="text-[#9aa3ba] hover:text-white"
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
            <Button
              onClick={goNext}
              disabled={!canAdvance || saveMutation.isPending}
              className="bg-[#f59e0b] text-[#0a0e1a] hover:bg-[#fbbf24]"
            >
              {saveMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              {step === STEP_LABELS.length - 2 ? "Start your 14-day trial" : "Continue"}
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
  return (
    <div className="space-y-6">
      <div className="inline-flex items-center gap-2 rounded-full border border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.08)] px-3 py-1 text-xs font-medium text-[#f59e0b]">
        <Sparkles className="h-3 w-3" />
        Setup takes about 5 minutes
      </div>
      <h1 className="text-4xl font-bold leading-tight tracking-tight text-white md:text-5xl">
        Привет{userName ? `, ${userName}` : ""}.<br />
        <span className="text-[#f59e0b]">Давайте настроим DispatchOS под вас.</span>
      </h1>
      <p className="max-w-xl text-base leading-relaxed text-[#9aa3ba]">
        За 4 шага: выберем тип аккаунта, привяжем MC#, подберём тариф. Документы — позже, на спокойной голове. 14 дней триал на любом тарифе.
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
      title: "Owner-Operator",
      description: "I drive my own truck",
      priceHint: "Starting at $19/mo",
      bullets: ["Single MC", "I'm the driver AND the boss", "1-2 trucks"],
    },
    {
      id: "fleet",
      icon: <Building2 className="h-7 w-7" />,
      title: "Carrier / Fleet",
      description: "We have multiple drivers",
      priceHint: "Starting at $49/mo",
      bullets: ["Multiple MCs or 2+ drivers", "Dispatchers + drivers separate", "2-50 trucks"],
    },
    {
      id: "enterprise",
      icon: <Crown className="h-7 w-7" />,
      title: "Enterprise",
      description: "Large fleet, custom needs",
      priceHint: "Custom pricing",
      bullets: ["50+ trucks", "API access, SSO, dedicated CSM", "On-prem option"],
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold leading-tight tracking-tight text-white md:text-4xl">
        Какой тип аккаунта вам нужен?
      </h1>
      <p className="text-[#9aa3ba]">
        От этого зависит набор вопросов на следующих шагах и стартовая цена.
      </p>
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
}) {
  const isFleet = persona === "fleet" || persona === "enterprise";

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold leading-tight tracking-tight text-white md:text-4xl">
        {isFleet ? "Информация о компании" : "Информация о вашем MC"}
      </h1>
      <p className="text-[#9aa3ba]">
        Эти данные нужны для broker scoring, FMCSA snapshot, и для compliance мониторинга. Вы сможете поменять их потом в Settings.
      </p>

      <div className="space-y-4 rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#161c2e]/40 p-5">
        {isFleet && (
          <div className="space-y-1.5">
            <Label className="text-xs text-[#9aa3ba]">Company legal name *</Label>
            <Input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="Acme Trucking LLC"
              className="border-[rgba(255,255,255,0.14)] bg-[#0a0e1a] text-white placeholder:text-[#6b7390]"
            />
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs text-[#9aa3ba]">MC# *</Label>
            <Input
              value={mc}
              onChange={(e) => setMc(e.target.value.toUpperCase())}
              placeholder="MC-123456"
              className="border-[rgba(255,255,255,0.14)] bg-[#0a0e1a] text-white placeholder:text-[#6b7390]"
            />
            <p className="text-[10px] text-[#6b7390]">
              We'll auto-pull authority status from FMCSA SAFER.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-[#9aa3ba]">DOT# (optional)</Label>
            <Input
              value={dot}
              onChange={(e) => setDot(e.target.value)}
              placeholder="3456789"
              className="border-[rgba(255,255,255,0.14)] bg-[#0a0e1a] text-white placeholder:text-[#6b7390]"
            />
          </div>
        </div>

        {isFleet && (
          <div className="space-y-1.5">
            <Label className="text-xs text-[#9aa3ba]">Fleet size</Label>
            <select
              value={fleetSize}
              onChange={(e) => setFleetSize(e.target.value)}
              className="h-10 w-full rounded-md border border-[rgba(255,255,255,0.14)] bg-[#0a0e1a] px-3 text-sm text-white"
            >
              <option value="">Select size...</option>
              <option value="2-5">2-5 trucks</option>
              <option value="6-20">6-20 trucks</option>
              <option value="21-50">21-50 trucks</option>
              <option value="50+">50+ trucks</option>
            </select>
          </div>
        )}

        {!isFleet && (
          <p className="rounded-md border border-[rgba(52,211,153,0.2)] bg-[rgba(52,211,153,0.05)] p-3 text-xs text-[#34d399]">
            ✓ Owner-operator setup. Документы (CDL, medical, insurance) можно загрузить позже — система не блокирует работу без них, но напомнит alert'ами.
          </p>
        )}
      </div>
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
  const filtered = plans.filter((p) => p.persona === persona);

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold leading-tight tracking-tight text-white md:text-4xl">
        Выберите план
      </h1>
      <p className="text-[#9aa3ba]">
        Первые {trialDays} дней — бесплатно на любом тарифе. Без карты на старте. Cancel anytime.
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
                <span className="text-sm text-[#9aa3ba]">/mo</span>
              </div>
              <ul className="space-y-1.5 text-xs text-[#9aa3ba]">
                <li className="flex items-start gap-1.5">
                  <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-[#34d399]" />
                  <span>
                    {plan.includedDriverSeats === 999
                      ? "Unlimited driver seats"
                      : `${plan.includedDriverSeats} driver seat${plan.includedDriverSeats === 1 ? "" : "s"}`}
                    {plan.additionalDriverCents > 0
                      ? ` (+$${(plan.additionalDriverCents / 100).toFixed(0)}/mo per add'l)`
                      : ""}
                  </span>
                </li>
                {plan.includedDispatcherSeats > 0 && (
                  <li className="flex items-start gap-1.5">
                    <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-[#34d399]" />
                    <span>
                      {plan.includedDispatcherSeats === 999
                        ? "Unlimited dispatcher seats"
                        : `${plan.includedDispatcherSeats} dispatcher seat${plan.includedDispatcherSeats === 1 ? "" : "s"}`}
                    </span>
                  </li>
                )}
                <li className="flex items-start gap-1.5">
                  <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-[#34d399]" />
                  <span>
                    {plan.maxMcCount === null || plan.maxMcCount >= 999
                      ? "Unlimited MCs"
                      : `${plan.maxMcCount} MC${plan.maxMcCount === 1 ? "" : "s"}`}
                  </span>
                </li>
                {plan.features.carrierSafetyProfile && (
                  <li className="flex items-start gap-1.5">
                    <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-[#34d399]" />
                    <span>Carrier Safety Profile (Montgomery)</span>
                  </li>
                )}
                {plan.features.counterpartyVettingPremium && (
                  <li className="flex items-start gap-1.5">
                    <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-[#34d399]" />
                    <span>Counterparty vetting premium</span>
                  </li>
                )}
                {plan.features.apiAccess && (
                  <li className="flex items-start gap-1.5">
                    <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-[#34d399]" />
                    <span>REST API + webhooks</span>
                  </li>
                )}
                {plan.features.ssoSaml && (
                  <li className="flex items-start gap-1.5">
                    <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-[#34d399]" />
                    <span>SSO / SAML</span>
                  </li>
                )}
                <li className="text-[10px] text-[#6b7390]">
                  Audit log retention: {plan.auditRetentionDays}d
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
  return (
    <div className="space-y-6">
      <div className="inline-flex items-center gap-2 rounded-full border border-[rgba(52,211,153,0.3)] bg-[rgba(52,211,153,0.08)] px-3 py-1 text-xs font-medium text-[#34d399]">
        <CheckCircle2 className="h-3 w-3" />
        Setup complete
      </div>
      <h1 className="text-4xl font-bold leading-tight tracking-tight text-white md:text-5xl">
        🎉 Вы готовы.
      </h1>
      <p className="max-w-xl text-base leading-relaxed text-[#9aa3ba]">
        Триал начался — 14 дней без оплаты. Загрузить документы (insurance, CDL, medical) можно из dashboard в разделе Compliance — alerts уже подключены.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Button
          onClick={onContinue}
          className="bg-[#f59e0b] text-[#0a0e1a] hover:bg-[#fbbf24]"
        >
          Go to dashboard
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          onClick={() => window.open("https://t.me/DispatchOS_Computer_Bot", "_blank")}
          className="border-[rgba(255,255,255,0.14)] bg-transparent text-white hover:bg-[rgba(255,255,255,0.06)]"
        >
          Connect Telegram bot
        </Button>
      </div>
    </div>
  );
}
