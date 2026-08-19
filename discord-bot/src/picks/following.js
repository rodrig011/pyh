import { DIRECTIONS } from './picks.js';

/**
 * What each member actually made, on their own entry.
 *
 * An analyst's record answers "were the calls good". It does not answer the
 * only question a member is really paying to have answered: "am I making
 * money". Those come apart constantly — the analyst gets in at 39 and the room
 * gets in at 47, and a call the board scores as a win is a loss for whoever
 * was slow. Nobody in this business publishes that number, because it is the
 * one that can embarrass them.
 *
 * It is also the number that keeps a member subscribed. People remember the
 * two they lost and forget the nine they won; a running total of their own
 * makes cancelling feel like walking away from money.
 */
export const FOLLOW_CHOICES = { IN: 'in' };

/**
 * Records that a member took a call, at the price showing when they pressed.
 *
 * One entry per member per call: pressing twice is a slip, not a second
 * position, and the first press is the honest timestamp.
 */
export function recordFollow(follows, { pickId, userId, price, unit, at }) {
  const existing = (follows ?? []).find(
    (follow) => follow.pickId === pickId && follow.userId === userId,
  );
  if (existing) return { added: false, follow: existing };

  const follow = { pickId, userId, price: price ?? null, unit: unit ?? null, at };
  return { added: true, follow };
}

/**
 * The return on one member's entry, as a percentage of what they put in.
 *
 * A Kalshi contract is bought and sold outright, so the return is the move over
 * their own entry. On spot it is the move in their favour — a SHORT that fell
 * made money, and the sign has to say so.
 */
export function followerReturn(pick, follow) {
  const entry = follow?.price;
  const exit = pick?.exit;
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry <= 0) return null;

  if (pick.priceUnit === 'cents') {
    // Both prices are already the side the member holds, so up is profit.
    return ((exit - entry) / entry) * 100;
  }

  const move = ((exit - entry) / entry) * 100;
  return pick.direction === DIRECTIONS.DOWN ? -move : move;
}

/**
 * What that return did to their book.
 *
 * The call carries the size the analyst told the room to use, so a +30% move
 * with a quarter of the book in is +7.5% on the account. Reporting the raw
 * contract move as if it were the account move is how signal rooms end up
 * advertising numbers nobody actually made.
 */
export function portfolioReturn(pick, follow) {
  const raw = followerReturn(pick, follow);
  if (raw === null) return null;
  const size = Number.isFinite(pick.sizePercent) ? pick.sizePercent : 100;
  return (raw * size) / 100;
}

/**
 * One member's record: what they took, what they made, and how late they were.
 *
 * `missedReturn` is the other half of the story and is deliberately included —
 * a member who skips the winners needs to see that, and it is the honest
 * counterweight to only ever showing them their own good news.
 */
export function memberRecord(follows, picks, userId, { sinceDays = null, now = Date.now() } = {}) {
  const inWindow = (at) => sinceDays === null || at > now - sinceDays * 86400000;

  const mine = (follows ?? []).filter((follow) => follow.userId === userId && inWindow(follow.at));
  const byPick = new Map(mine.map((follow) => [follow.pickId, follow]));

  const settled = (picks ?? []).filter((pick) => pick.outcome && inWindow(pick.createdAt));

  let wins = 0;
  let losses = 0;
  let flat = 0;
  let book = 1;
  let lagTotal = 0;
  let lagCount = 0;
  const graded = [];

  for (const pick of settled) {
    const follow = byPick.get(pick.id);
    if (!follow) continue;

    if (Number.isFinite(follow.at) && Number.isFinite(pick.createdAt)) {
      lagTotal += Math.max(0, follow.at - pick.createdAt);
      lagCount += 1;
    }

    const move = portfolioReturn(pick, follow);
    if (move === null) {
      flat += 1;
      continue;
    }

    if (move > 0.01) wins += 1;
    else if (move < -0.01) losses += 1;
    else flat += 1;

    book *= 1 + move / 100;
    graded.push({ pickId: pick.id, asset: pick.asset, at: pick.createdAt, percent: move });
  }

  // What the calls they skipped would have paid, taken at the analyst's own
  // entry — the fairest available stand-in for "if you had been there".
  let missedBook = 1;
  let missed = 0;
  for (const pick of settled) {
    if (byPick.has(pick.id)) continue;
    const move = portfolioReturn(pick, { price: pick.entry });
    if (move === null) continue;
    missed += 1;
    missedBook *= 1 + move / 100;
  }

  return {
    userId,
    followed: mine.length,
    graded: graded.length,
    wins,
    losses,
    flat,
    winRate: wins + losses === 0 ? null : wins / (wins + losses),
    // Compounded, because that is what a book actually does across trades.
    returnPercent: graded.length === 0 ? null : (book - 1) * 100,
    best: graded.length === 0 ? null : graded.reduce((a, b) => (b.percent > a.percent ? b : a)),
    worst: graded.length === 0 ? null : graded.reduce((a, b) => (b.percent < a.percent ? b : a)),
    averageLagSeconds: lagCount === 0 ? null : Math.round(lagTotal / lagCount / 1000),
    missed,
    missedReturnPercent: missed === 0 ? null : (missedBook - 1) * 100,
    stillOpen: (picks ?? []).filter((pick) => !pick.outcome && byPick.has(pick.id)).length,
  };
}

/** How many took a given call, for the line the room sees when it closes. */
export function followerCount(follows, pickId) {
  return (follows ?? []).filter((follow) => follow.pickId === pickId).length;
}

/**
 * The room against the analyst on the same call.
 *
 * When the analyst wins and the room does not, the cause is almost always lag,
 * and this is what makes that visible instead of arguable.
 */
export function roomVersusAnalyst(follows, pick) {
  const taken = (follows ?? []).filter((follow) => follow.pickId === pick.id);
  if (taken.length === 0) return null;

  const returns = taken.map((follow) => portfolioReturn(pick, follow)).filter((value) => value !== null);
  if (returns.length === 0) return null;

  const analyst = portfolioReturn(pick, { price: pick.entry });
  const average = returns.reduce((total, value) => total + value, 0) / returns.length;

  return {
    followers: taken.length,
    analystPercent: analyst,
    roomPercent: average,
    inProfit: returns.filter((value) => value > 0).length,
    gap: analyst === null ? null : average - analyst,
  };
}

export function formatPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

export function formatLag(seconds) {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
