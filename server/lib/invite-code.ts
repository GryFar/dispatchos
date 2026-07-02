// ===========================================================================
// server/lib/invite-code.ts — cryptographically strong invite codes
// ===========================================================================
// V5-006: the two ad-hoc generators (admin.ts ~59 bits with modulo bias, and
// leads.ts only 48 bits via 3×randomBytes(2)) were both below a safe bar. This
// is the single source of truth: ~98 bits of entropy (20 chars over a 30-char
// look-alike-free alphabet), CSPRNG, with rejection sampling to drop the modulo
// bias (256 % 30 != 0). Human-readable DOS-XXXX-XXXX-XXXX-XXXX-XXXX format.
// ===========================================================================
import crypto from "node:crypto";

const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // A–Z minus IOLU, 2–9 minus 01
const BLOCKS = 5;
const BLOCK_LEN = 4;
const TOTAL = BLOCKS * BLOCK_LEN; // 20 random chars

export function generateInviteCode(): string {
  const chars: string[] = [];
  while (chars.length < TOTAL) {
    const buf = crypto.randomBytes(TOTAL);
    for (let i = 0; i < buf.length && chars.length < TOTAL; i += 1) {
      // Rejection sampling: 240 = 8*30, so bytes 240..255 would bias the first
      // 16 alphabet symbols. Drop them for a uniform distribution.
      if (buf[i] >= 240) continue;
      chars.push(INVITE_ALPHABET[buf[i] % INVITE_ALPHABET.length]);
    }
  }
  const blocks: string[] = [];
  for (let b = 0; b < BLOCKS; b += 1) {
    blocks.push(chars.slice(b * BLOCK_LEN, (b + 1) * BLOCK_LEN).join(""));
  }
  return `DOS-${blocks.join("-")}`;
}