// ===========================================================================
// server/lib/auth-redirect.ts — where to send a user right after auth
// ===========================================================================
//
// Shared by POST /api/auth/login and POST /api/auth/totp/confirm-signup
// (server/routes.ts). Historically the redirect was computed from the role
// alone, which stranded every interrupted self-serve signup: a carrier owner
// signs up as role 'driver' with NO carrier and NO trial (routes.ts self-serve
// branch), and the only navigation into the resumable /onboarding wizard was
// the in-session signup flow. Reload / logout / resume-2FA all landed the user
// in an empty driver portal with no path back to the wizard — the MC claim,
// trial and the whole paid funnel were silently lost.
//
// Rule: a role-'driver' user with no linked carrier whose onboarding is not
// completed belongs in /onboarding. Invited drivers are unaffected: invite
// signup either links them to a carrier (linkedClientId) or stamps their
// onboarding row completed at creation (routes.ts invite branch).
// ---------------------------------------------------------------------------

import { storage } from "../storage";

export function postAuthRedirect(user: {
  id: string;
  role: string;
  linkedClientId?: string | null;
}): string {
  if (user.role === "admin") return "/admin";
  if (user.role === "dispatcher") return "/dispatch";
  // Self-serve carrier owner mid-funnel: no carrier yet and the wizard isn't
  // done — resume it instead of dropping them into a dead empty portal.
  if (!user.linkedClientId && !storage.getOnboardingProgress(user.id)?.completedAt) {
    return "/onboarding";
  }
  return "/d";
}
