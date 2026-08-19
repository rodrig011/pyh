import { extractCodes } from '../lib/codes.js';

/**
 * Neither Zelle nor Venmo offers a public API for personal accounts, so both are
 * detected the same way: by reading the notification email and pulling out the
 * amount and the code the buyer put in the memo.
 *
 * Every pattern uses named groups (`amount`, `name`) so one matcher serves the
 * different word orders — "you received $50 from X" and "X paid you $50".
 */
export const PROVIDERS = {
  zelle: {
    name: 'zelle',
    label: 'Zelle',
    source: 'zelle-email',
    keyword: /zelle/i,
    // Spanish phrasings are kept: some banks send their alerts in Spanish.
    received: [
      /you\s+received\s+\$?\s?(?<amount>[\d,]+(?:\.\d{2})?)\s+from\s+(?<name>[^\n.,;<]{2,60})/i,
      /(?<name>[A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*){0,3})\s+sent\s+you\s+\$?\s?(?<amount>[\d,]+(?:\.\d{2})?)/,
      /you\s+received\s+\$?\s?(?<amount>[\d,]+(?:\.\d{2})?)/i,
      /sent\s+you\s+\$?\s?(?<amount>[\d,]+(?:\.\d{2})?)/i,
      /deposited\s+\$?\s?(?<amount>[\d,]+(?:\.\d{2})?)/i,
      /(?<name>[^\n.,;<]{2,60})\s+te\s+(?:ha\s+)?envi[oó]\s+\$?\s?(?<amount>[\d,]+(?:\.\d{2})?)/i,
      /te\s+(?:ha\s+)?envi[oó]\s+\$?\s?(?<amount>[\d,]+(?:\.\d{2})?)/i,
      /(?:recibiste|has\s+recibido)\s+(?:un\s+pago\s+de\s+)?\$?\s?(?<amount>[\d,]+(?:\.\d{2})?)/i,
    ],
    outgoing: [/you\s+sent\s+\$?\s?[\d,]+/i, /your\s+payment\s+to\b/i, /enviaste\s+\$?\s?[\d,]+/i],
    // Bank specific: there is no safe default, it must be configured.
    defaultSenders: [],
  },

  venmo: {
    name: 'venmo',
    label: 'Venmo',
    source: 'venmo-email',
    keyword: /venmo/i,
    received: [
      /(?<name>[\w .'-]{2,40})\s+paid\s+you\s+\$?\s?(?<amount>[\d,]+(?:\.\d{2})?)/i,
      /you\s+received\s+\$?\s?(?<amount>[\d,]+(?:\.\d{2})?)\s+from\s+(?<name>[^\n.,;<]{2,60})/i,
      /you\s+received\s+\$?\s?(?<amount>[\d,]+(?:\.\d{2})?)/i,
    ],
    // "You paid X" and payment requests must never be read as income.
    outgoing: [
      /you\s+paid\s+/i,
      /you\s+completed\s+.*payment\s+to/i,
      /requests?\s+\$?[\d,]+/i,
      /is\s+requesting/i,
    ],
    defaultSenders: ['venmo@venmo.com', 'venmo.com'],
  },
};

const MEMO_PATTERNS = [/(?:memo|note|nota|concepto|mensaje)\s*[:\-]\s*([^\n<]{1,120})/i];

/**
 * Does this sender match an allowlist entry?
 *
 * An entry with an "@" is an exact address. Without one it is a domain, and it
 * matches that domain or any subdomain of it — so `huntington.com` covers
 * `alerts@huntington.com` and `x@email.huntington.com`, which matters when all
 * you know is which bank sends the alert.
 *
 * The comparison is on the domain, never a substring: `x@huntington.com.evil.net`
 * contains "huntington.com" but is not Huntington, and that is exactly the
 * address a spoofer would register.
 */
export function senderMatches(from, allowed) {
  const address = (from ?? '').toLowerCase().trim();
  const entry = (allowed ?? '').toLowerCase().trim();
  if (address === '' || entry === '') return false;

  if (entry.includes('@')) return address === entry;

  const domain = address.slice(address.lastIndexOf('@') + 1);
  return domain === entry || domain.endsWith(`.${entry}`);
}

/** "JUAN PEREZ with Zelle®" -> "JUAN PEREZ". */
function cleanName(raw) {
  if (!raw) return null;
  const cleaned = raw
    .replace(/\s+(with|via|using|through|mediante|por)\s+(zelle|venmo)[®™]?.*$/i, '')
    .replace(/[®™]/g, '')
    .trim();
  return cleaned === '' ? null : cleaned;
}

/** Turns "1,234.50" into 123450 cents. */
export function parseAmountToCents(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[^\d.,]/g, '').replace(/,/g, '');
  if (cleaned === '') return null;
  const value = Number.parseFloat(cleaned);
  if (Number.isNaN(value)) return null;
  return Math.round(value * 100);
}

/** Strips HTML tags, leaving readable text behind. */
export function htmlToText(html) {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|td|h\d|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function firstMatch(patterns, text) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match;
  }
  return null;
}

/**
 * Reads a payment notification email from any supported provider.
 *
 * @param {object} email  {from, subject, text, html, messageId, date}
 * @param {object} [options]
 * @param {Array<{provider: string, allowedSenders: string[]}>} [options.providers]
 *        which providers to accept and whose senders to trust. Defaults to Zelle.
 * @param {string[]} [options.allowedSenders] shorthand for a single-provider setup
 * @param {string} [options.codePrefix='VIP']
 * @param {number} [options.codeLength=6]
 * @param {boolean} [options.requireKeyword=true]
 */
export function parsePaymentEmail(email = {}, options = {}) {
  const {
    codePrefix = 'VIP',
    codeLength = 6,
    requireKeyword = true,
    allowedSenders,
    providers = [{ provider: 'zelle', allowedSenders: allowedSenders ?? [] }],
  } = options;

  const from = (email.from ?? '').toLowerCase();
  const subject = email.subject ?? '';
  const body = email.text && email.text.trim() !== '' ? email.text : htmlToText(email.html);
  const haystack = `${subject}\n${body}`;
  const receivedAt = email.date ? new Date(email.date).getTime() : Date.now();

  const base = {
    isPayment: false,
    provider: null,
    amountCents: null,
    senderName: null,
    memo: null,
    codes: [],
    reference: email.messageId ?? null,
    receivedAt,
    source: null,
  };

  const reasons = [];

  for (const entry of providers) {
    const rules = PROVIDERS[entry.provider];
    if (!rules) {
      reasons.push(`unknown provider ${entry.provider}`);
      continue;
    }

    const trusted = entry.allowedSenders?.length ? entry.allowedSenders : rules.defaultSenders;

    // No allowlist means no way to tell the bank apart from anyone who emails
    // this inbox, and the wording of a payment alert is trivial to fake. Refuse
    // rather than trust: a misconfigured deployment must be inert, not generous.
    if (trusted.length === 0) {
      reasons.push(`${rules.label}: no sender allowlist configured, so nothing is trusted`);
      continue;
    }

    if (!trusted.some((allowed) => senderMatches(from, allowed))) {
      reasons.push(`${rules.label}: Untrusted sender ${email.from ?? '(empty)'}`);
      continue;
    }

    if (requireKeyword && !rules.keyword.test(`${from}\n${haystack}`)) {
      reasons.push(`The email does not mention ${rules.label}`);
      continue;
    }

    const amountMatch = firstMatch(rules.received, haystack);
    if (firstMatch(rules.outgoing, haystack) && !amountMatch) {
      reasons.push(`${rules.label}: this is an outgoing payment, not an incoming one`);
      continue;
    }
    if (!amountMatch) {
      reasons.push(`${rules.label}: no payment-received wording found`);
      continue;
    }

    const memoMatch = firstMatch(MEMO_PATTERNS, haystack);
    return {
      ...base,
      isPayment: true,
      provider: rules.name,
      source: rules.source,
      amountCents: parseAmountToCents(amountMatch.groups?.amount ?? ''),
      senderName: cleanName(amountMatch.groups?.name),
      memo: memoMatch ? memoMatch[1].trim() : null,
      codes: extractCodes(haystack, { prefix: codePrefix, length: codeLength }),
    };
  }

  return { ...base, reason: reasons.join('; ') || 'no provider matched' };
}

/** Zelle-only wrapper, kept for callers that do not care about other providers. */
export function parseZelleEmail(email = {}, options = {}) {
  const parsed = parsePaymentEmail(email, {
    ...options,
    requireKeyword: options.requireZelleKeyword ?? options.requireKeyword ?? true,
    providers: [{ provider: 'zelle', allowedSenders: options.allowedSenders ?? [] }],
  });
  return { ...parsed, source: parsed.source ?? 'zelle-email' };
}
