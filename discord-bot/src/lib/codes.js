import { randomInt } from 'node:crypto';

// Alfabeto sin caracteres ambiguos (0/O, 1/I/L) para que nadie se equivoque al
// copiar el codigo en la nota de Zelle.
export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Genera un codigo aleatorio criptograficamente seguro, p.ej. "VIP-7K3QDM".
 * Siempre lleva al menos un digito: asi una palabra suelta como "VIP membership"
 * nunca se confunde con un codigo al leer el correo.
 *
 * @param {object} [options]
 * @param {string} [options.prefix='VIP']
 * @param {number} [options.length=6]
 * @param {(code: string) => boolean} [options.isTaken] devuelve true si el codigo ya existe
 */
export function generateCode({ prefix = 'VIP', length = 6, isTaken = () => false } = {}) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let body = '';
    for (let i = 0; i < length; i += 1) body += ALPHABET[randomInt(ALPHABET.length)];
    if (!/[0-9]/.test(body)) continue;
    const code = `${prefix.toUpperCase()}-${body}`;
    if (!isTaken(code)) return code;
  }
  throw new Error('No se pudo generar un codigo unico despues de 200 intentos');
}

/**
 * Normaliza cualquier forma de escribir el codigo: "vip 7k3 qdm" -> "VIP-7K3QDM".
 * Devuelve null si no cumple el formato canonico.
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
 * Busca todos los codigos presentes en un texto libre (asunto o cuerpo del correo,
 * nota de Zelle, etc.). Tolera espacios, guiones y minusculas.
 * @returns {string[]} codigos canonicos y unicos
 */
export function extractCodes(text, { prefix = 'VIP', length = 6 } = {}) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const upperPrefix = prefix.toUpperCase();
  const escaped = upperPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = new Set();

  // Las etiquetas HTML pueden partir el codigo por la mitad ("VIP-<b>7K3QDM</b>"),
  // asi que se quitan antes de buscar.
  const clean = text.replace(/<[^>]+>/g, ' ');

  // 1) Coincidencia directa, permitiendo separadores entre prefijo y cuerpo.
  const loose = new RegExp(`${escaped}[\\s\\-_.:]*([A-Z0-9][\\sA-Z0-9\\-]{0,${length * 2}})`, 'gi');
  for (const match of clean.matchAll(loose)) {
    const code = normalizeCode(`${upperPrefix}${match[1]}`, { prefix, length });
    if (code) found.add(code);
  }

  // 2) Segunda pasada sobre el texto sin separadores, por si el correo parte el
  //    codigo con etiquetas HTML o saltos de linea.
  const compact = clean.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const strict = new RegExp(`${escaped}([A-Z0-9]{${length}})`, 'g');
  for (const match of compact.matchAll(strict)) {
    const code = normalizeCode(`${upperPrefix}${match[1]}`, { prefix, length });
    if (code) found.add(code);
  }

  return [...found];
}
