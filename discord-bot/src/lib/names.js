/**
 * Matching the name on a bank alert against the name a buyer typed.
 *
 * Banks that strip the memo still name the payer, so the name is the only
 * identifying thing left in the email. It arrives shouted and unpunctuated
 * ("CHRISTOPHER SWAILS"), while the buyer types it however they like
 * ("Chris Swails", "swails, christopher"), so neither side can be compared raw.
 */

/** "  Chris  Swails-Jr. " -> "CHRIS SWAILS JR". */
export function normalizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

/**
 * Do these two names plausibly belong to the same person?
 *
 * The surname has to match outright — it is the half people do not shorten, and
 * without it the check would hand memberships to anyone called Chris. Given
 * names are allowed to be abbreviated, since "Chris" for "Christopher" is the
 * single most common way the two spellings differ.
 *
 * Deliberately strict: a wrong match here grants a stranger a paid membership,
 * while a missed one only falls through to a mod pressing one button.
 */
export function nameMatches(a, b) {
  const left = normalizeName(a).split(' ').filter(Boolean);
  const right = normalizeName(b).split(' ').filter(Boolean);
  if (left.length === 0 || right.length === 0) return false;

  if (left.join(' ') === right.join(' ')) return true;
  if (left.at(-1) !== right.at(-1)) return false;

  // One side gave a surname only. The surnames already match, and there is
  // nothing else to compare.
  if (left.length === 1 || right.length === 1) return true;

  const [first, second] = [left[0], right[0]];
  if (first === second) return true;

  // "CHRIS" against "CHRISTOPHER". Two letters would match far too much.
  const short = first.length <= second.length ? first : second;
  const long = first.length <= second.length ? second : first;
  return short.length >= 3 && long.startsWith(short);
}
