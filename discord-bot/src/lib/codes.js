import { randomInt } from 'node:crypto';

// Alphabet without ambiguous characters (0/O, 1/I/L) so nobody mistypes the
// code when copying it into the Zelle memo.
export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Generates a cryptographically secure random code, e.g. "VIP-7K3QDM".
 * It always contains at least one digit, so a plain phrase like "VIP membership"
 * is never mistaken for a code when scanning an email.
 *
 * @param {object} [options]
 * @param {string} [options.prefix='VIP']
 * @param {number} [options.length=6]
 * @param {(code: string) => boolean} [options.isTaken] returns true if the code already exists
 */
export function generateCode({ prefix = 'VIP', length = 6, isTaken = () => false } = {}) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let body = '';
    for (let i = 0; i < length; i += 1) body += ALPHABET[randomInt(ALPHABET.length)];
    if (!/[0-9]/.test(body)) continue;
    const code = `${prefix.toUpperCase()}-${body}`;
    if (!isTaken(code)) return code;
  }
  throw new Error('Could not generate a unique code after 200 attempts');
}

/**
 * Normalizes any way of writing the code: "vip 7k3 qdm" -> "VIP-7K3QDM".
 * Returns null when the input is not a valid code.
 */
export function normalizeCode(raw, { prefix = 'VIP', length = 6 } = {}) {
  if (typeof raw !== 'string') return null;
  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const upperPrefix = prefix.toUpperCase();
  if (!compact.startsWith(upperPrefix)) return null;
  const body = compact.slice(upperPrefix.length, upperPrefix.length + length);
  if (body.length !== length) return null;
  if (![...body].every((char) => ALPHABET.includes(char))) return null;
  if (!/[0-9]/.test(body)) return null;
  return `${upperPrefix}-${body}`;
}

/**
 * Finds every code present in free-form text (email subject or body, Zelle memo,
 * and so on). Tolerates spaces, dashes and lowercase.
 * @returns {string[]} unique, canonical codes
 */
export function extractCodes(text, { prefix = 'VIP', length = 6 } = {}) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const upperPrefix = prefix.toUpperCase();
  const escaped = upperPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = new Set();

  // HTML tags can split the code in half ("VIP-<b>7K3QDM</b>"), so drop them first.
  const clean = text.replace(/<[^>]+>/g, ' ');

  // 1) Direct match, allowing separators between prefix and body.
  const loose = new RegExp(`${escaped}[\\s\\-_.:]*([A-Z0-9][\\sA-Z0-9\\-]{0,${length * 2}})`, 'gi');
  for (const match of clean.matchAll(loose)) {
    const code = normalizeCode(`${upperPrefix}${match[1]}`, { prefix, length });
    if (code) found.add(code);
  }

  // 2) Second pass over the text with every separator removed, in case the email
  //    breaks the code up with markup or line wraps.
  const compact = clean.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const strict = new RegExp(`${escaped}([A-Z0-9]{${length}})`, 'g');
  for (const match of compact.matchAll(strict)) {
    const code = normalizeCode(`${upperPrefix}${match[1]}`, { prefix, length });
    if (code) found.add(code);
  }

  return [...found];
}
