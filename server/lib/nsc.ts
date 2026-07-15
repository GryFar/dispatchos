// Canadian NSC (National Safety Code) identifier normalization.
//
// A Canadian domestic carrier has no US MC docket; it identifies by an NSC
// number. We let it claim that NSC through the same one-identifier-per-account
// registry as US carriers — but in its OWN namespace so it can never collide
// with a US MC that happens to share the same digits.
//
// normalizeMc() (server/routes.ts) collapses any input into "MC-<digits>".
// Feeding an NSC through it would map NSC "1234567" onto the SAME registry key
// as US MC "1234567" (mc_account_registry is unique per normalized string,
// V4-011) — a false collision that would 409 the second carrier to sign up.
//
// normalizeNsc() mirrors normalizeMc's "first contiguous digit run" rule
// (V4-007: "MC-9001" and "MC-9001-X2" must not diverge) but emits an
// "NSC-<digits>" key, a namespace disjoint from "MC-<digits>". Same uniqueness
// guarantee within Canadian carriers; zero cross-namespace collisions.

/**
 * Normalize a Canadian NSC number into a registry key: "NSC-<first digit run>".
 * Distinct from normalizeMc()'s "MC-<digits>" namespace. Falls back to the raw
 * upper-cased string when no digits are present (keeps a non-empty claim key so
 * the V4-003 "carrier needs a claimed docket" invariant still holds).
 */
export function normalizeNsc(value: string): string {
  const raw = String(value ?? "").trim().toUpperCase();
  // Drop a leading "NSC" prefix the user may have typed, then take the first
  // contiguous run of digits — the docket number — exactly like normalizeMc.
  const afterPrefix = raw.replace(/^NSC[-\s]*/, "");
  const digits = afterPrefix.match(/\d+/)?.[0] ?? "";
  return digits ? `NSC-${digits}` : raw;
}
