/**
 * Picks which alert milestone a countdown currently sits in.
 *
 * `thresholds` is the descending list of days-before-expiry milestones
 * (e.g. [30, 14, 7, 1, 0, -1, -7]). Given `daysUntil` (whole calendar days
 * until expiry; negative = already expired), returns the SMALLEST threshold
 * that has been reached — the most recent milestone passed, i.e.
 * `min { t : t >= daysUntil }`.
 *
 * Why "smallest reached" and not an exact `daysUntil === t` match: the daily
 * job can miss a day (restart, outage, weekend gap). An exact match silently
 * skips the milestone the countdown jumped over. Bucketing by the reached
 * milestone means a skipped day still fires on the next run. Firing exactly
 * once per milestone is enforced by the caller's per-threshold anti-dupe
 * record, so this stays a pure function.
 *
 * Returns null only when the countdown is still above every milestone (too
 * early). Once it reaches the smallest threshold it stays clamped there
 * forever — being below the last milestone does NOT return null, because the
 * "expired" buckets (e.g. -1, -7) must keep firing past their day. The
 * per-threshold anti-dupe record in the caller stops them repeating.
 */
export function pickAlertThreshold(
  daysUntil: number,
  thresholds: number[],
): number | null {
  let reached: number | null = null;
  for (const t of thresholds) {
    if (daysUntil <= t && (reached === null || t < reached)) {
      reached = t;
    }
  }
  return reached;
}