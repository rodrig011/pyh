import { extractCodes } from '../lib/codes.js';

// Frases con las que los bancos avisan de un Zelle RECIBIDO (ingles y espanol).
const RECEIVED_PATTERNS = [
  /you\s+received\s+\$?\s?([\d,]+(?:\.\d{2})?)/i,
  /sent\s+you\s+\$?\s?([\d,]+(?:\.\d{2})?)/i,
  /has\s+sent\s+you\s+\$?\s?([\d,]+(?:\.\d{2})?)/i,
  /deposited\s+\$?\s?([\d,]+(?:\.\d{2})?)/i,
  /te\s+(?:ha\s+)?envi[oó]\s+\$?\s?([\d,]+(?:\.\d{2})?)/i,
  /(?:recibiste|has\s+recibido)\s+(?:un\s+pago\s+de\s+)?\$?\s?([\d,]+(?:\.\d{2})?)/i,
];

// Si el correo dice que TU enviaste dinero, no es un cobro: hay que ignorarlo.
const OUTGOING_PATTERNS = [
  /you\s+sent\s+\$?\s?[\d,]+/i,
  /your\s+payment\s+to\b/i,
  /enviaste\s+\$?\s?[\d,]+/i,
];

const NAME_PATTERNS = [
  /([A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*){0,3})\s+sent\s+you/,
  /you\s+received\s+\$?[\d,.]+\s+from\s+([^\n.,;<]{2,60})/i,
  /from\s+([^\n.,;<]{2,60})\s+(?:with|via)\s+zelle/i,
  /([^\n.,;<]{2,60})\s+te\s+(?:ha\s+)?envi[oó]/i,
];

const MEMO_PATTERNS = [
  /(?:memo|note|nota|concepto|mensaje)\s*[:\-]\s*([^\n<]{1,120})/i,
];

/** Convierte "1,234.50" en 123450 centavos. */
export function parseAmountToCents(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[^\d.,]/g, '').replace(/,/g, '');
  if (cleaned === '') return null;
  const value = Number.parseFloat(cleaned);
  if (Number.isNaN(value)) return null;
  return Math.round(value * 100);
}

/** Quita etiquetas HTML dejando el texto legible. */
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
 * Analiza un correo de notificacion de Zelle.
 *
 * @param {object} email
 * @param {string} [email.from] direccion del remitente
 * @param {string} [email.subject]
 * @param {string} [email.text] cuerpo en texto plano
 * @param {string} [email.html] cuerpo en HTML (se usa si no hay texto)
 * @param {string} [email.messageId]
 * @param {Date|number} [email.date]
 * @param {object} [options]
 * @param {string[]} [options.allowedSenders] dominios o direcciones de confianza
 * @param {string} [options.codePrefix='VIP']
 * @param {number} [options.codeLength=6]
 * @param {boolean} [options.requireZelleKeyword=true]
 * @returns {{isPayment: boolean, reason?: string, amountCents: number|null, senderName: string|null, memo: string|null, codes: string[], reference: string|null, receivedAt: number, source: 'zelle-email'}}
 */
export function parseZelleEmail(email = {}, options = {}) {
  const {
    allowedSenders = [],
    codePrefix = 'VIP',
    codeLength = 6,
    requireZelleKeyword = true,
  } = options;

  const from = (email.from ?? '').toLowerCase();
  const subject = email.subject ?? '';
  const body = email.text && email.text.trim() !== '' ? email.text : htmlToText(email.html);
  const haystack = `${subject}\n${body}`;
  const receivedAt = email.date ? new Date(email.date).getTime() : Date.now();

  const base = {
    isPayment: false,
    amountCents: null,
    senderName: null,
    memo: null,
    codes: [],
    reference: email.messageId ?? null,
    receivedAt,
    source: 'zelle-email',
  };

  if (allowedSenders.length > 0) {
    const trusted = allowedSenders.some((allowed) => from.includes(allowed.toLowerCase()));
    if (!trusted) return { ...base, reason: `Remitente no autorizado: ${email.from ?? '(vacio)'}` };
  }

  if (requireZelleKeyword && !/zelle/i.test(`${from}\n${haystack}`)) {
    return { ...base, reason: 'El correo no menciona Zelle' };
  }

  if (firstMatch(OUTGOING_PATTERNS, haystack) && !firstMatch(RECEIVED_PATTERNS, haystack)) {
    return { ...base, reason: 'Es un pago enviado, no recibido' };
  }

  const amountMatch = firstMatch(RECEIVED_PATTERNS, haystack);
  if (!amountMatch) {
    return { ...base, reason: 'No se encontro ninguna frase de pago recibido' };
  }

  const codes = extractCodes(haystack, { prefix: codePrefix, length: codeLength });
  const nameMatch = firstMatch(NAME_PATTERNS, haystack);
  const memoMatch = firstMatch(MEMO_PATTERNS, haystack);

  return {
    ...base,
    isPayment: true,
    amountCents: parseAmountToCents(amountMatch[1]),
    senderName: nameMatch ? nameMatch[1].trim() : null,
    memo: memoMatch ? memoMatch[1].trim() : null,
    codes,
  };
}
