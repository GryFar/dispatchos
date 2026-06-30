/**
 * Whole calendar days from `fromIso` to `toIso` (negative if `toIso` is
 * earlier). Both inputs are reduced to UTC midnight of their YYYY-MM-DD date
 * before differencing, so the result is:
 *   - immune to DST (UTC has no shifts),
 *   - independent of time-of-day (a cron at 23:00 and one at 01:00 agree),
 *   - an exact integer (no Math.round guesswork on fractional days).
 * Returns 0 if either input cannot be parsed as a YYYY-MM-DD-prefixed string.
 */
export function daysBetween(fromIso: string, toIso: string): number {
  const utcMidnight = (iso: string): number => {
    const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
    if (!y || !m || !d) return NaN;
    // Reject out-of-range components so Date.UTC can't silently normalize
    // overflow (e.g. month 13 -> next Jan, Feb 30 -> Mar 2) into a finite but
    // wrong timestamp. The round-trip check below catches month-specific
    // overflow (e.g. Feb 30, Apr 31) that the coarse bounds above miss.
    if (m < 1 || m > 12 || d < 1 || d > 31) return NaN;
    const ts = Date.UTC(y, m - 1, d);
    const back = new Date(ts);
    if (back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return NaN;
    return ts;
  };
  const a = utcMidnight(fromIso);
  const b = utcMidnight(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  // (b - a) is always an exact multiple of one day at UTC midnight; the
  // Math.round is purely defensive against float division noise.
  return Math.round((b - a) / 86_400_000);
}