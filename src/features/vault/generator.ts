/*
 * Password generator. Uses the OS random source (crypto.getRandomValues) with
 * rejection sampling, so every character is equally likely.
 */

const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "!#$%&*+-=?@_";

export interface GeneratorOptions {
  length: number;
  digits: boolean;
  symbols: boolean;
}

function randomIndex(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % n;
}

export function generatePassword({ length, digits, symbols }: GeneratorOptions): string {
  const sets = [LOWER, UPPER, ...(digits ? [DIGITS] : []), ...(symbols ? [SYMBOLS] : [])];
  const all = sets.join("");
  // At least one of each chosen set, the rest from all, then shuffled.
  const chars = sets.map((s) => s[randomIndex(s.length)]);
  while (chars.length < length) chars.push(all[randomIndex(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** Rough strength in bits (length × log2 of the character pool). */
export function strengthBits(password: string): number {
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/\d/.test(password)) pool += 10;
  if (/[^a-zA-Z\d]/.test(password)) pool += 20;
  return pool ? Math.round(password.length * Math.log2(pool)) : 0;
}
