import { useAuth } from "@/lib/use-auth";
import { useT } from "@/lib/i18n";

/**
 * Header badge: the logged-in user's per-user subscription countdown.
 * Reads subscriptionEndsAt from /api/me (useAuth); text is i18n via useT() so it
 * re-renders on language switch. Renders nothing when the user has no per-user
 * subscription (admin / accounts created before invites carried a subscription).
 */
export function SubscriptionBadge() {
  const { user } = useAuth();
  const { t } = useT();
  const endsAt = user?.subscriptionEndsAt;
  if (!endsAt) return null;
  const days = Math.ceil((new Date(endsAt).getTime() - Date.now()) / (24 * 3600 * 1000));
  const expired = days <= 0;
  const urgent = days > 0 && days <= 3;
  const cls =
    expired || urgent
      ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
      : "bg-primary/10 text-primary";
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}
      title={t("subscription.until", { date: new Date(endsAt).toLocaleDateString() })}
    >
      {expired ? t("subscription.expired") : t("subscription.daysLeft", { days })}
    </span>
  );
}
