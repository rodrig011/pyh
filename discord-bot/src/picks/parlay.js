/**
 * A sports parlay is not a Kalshi contract.
 *
 * There is no live price to grade it against, no clock counting down, no
 * settlement window — the whole shape a trading call needs does not exist
 * here. What is worth keeping is the two things that actually matter: a
 * public record tied to whoever called it, and one unambiguous WIN, LOSS or
 * PUSH pressed by hand once the game is actually decided.
 */

export const PARLAY_OUTCOMES = { WIN: 'win', LOSS: 'loss', PUSH: 'push' };

export function buildParlay({
  analystId,
  analystTag = null,
  guildId,
  legs,
  odds = null,
  units = null,
  note = null,
  now = Date.now(),
}) {
  if (!analystId || !guildId) throw new Error('A parlay needs to know who called it and where');
  if (!legs || !legs.trim()) throw new Error('A parlay needs at least one leg written out');

  return {
    id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    analystId,
    analystTag,
    guildId,
    legs: legs.trim(),
    odds: odds?.trim() || null,
    units: Number.isFinite(units) ? units : null,
    note: note?.trim() || null,
    outcome: null,
    createdAt: now,
    settledAt: null,
    messageId: null,
    channelId: null,
  };
}

/** Marks the outcome. Settling twice just overwrites — the last press by a mod is the record. */
export function settleParlay(parlay, outcome, { now = Date.now() } = {}) {
  if (!Object.values(PARLAY_OUTCOMES).includes(outcome)) return parlay;
  return { ...parlay, outcome, settledAt: now };
}

/**
 * One analyst's record. Pushes are void — neither a win nor a loss — so the
 * win rate is decided bets only, the same reasoning as any sportsbook grade.
 */
export function parlayRecord(parlays, analystId) {
  const mine = (parlays ?? []).filter((parlay) => parlay?.analystId === analystId && parlay.outcome);
  const wins = mine.filter((parlay) => parlay.outcome === PARLAY_OUTCOMES.WIN).length;
  const losses = mine.filter((parlay) => parlay.outcome === PARLAY_OUTCOMES.LOSS).length;
  const pushes = mine.filter((parlay) => parlay.outcome === PARLAY_OUTCOMES.PUSH).length;
  const decided = wins + losses;

  return { wins, losses, pushes, decided, winRate: decided > 0 ? wins / decided : null };
}

/** Every analyst with at least one decided parlay, best win rate first. */
export function parlayLeaderboard(parlays, { minimumDecided = 1 } = {}) {
  const analystIds = [...new Set((parlays ?? []).map((parlay) => parlay?.analystId).filter(Boolean))];

  return analystIds
    .map((analystId) => ({
      analystId,
      analystTag: parlays.find((parlay) => parlay.analystId === analystId)?.analystTag ?? null,
      ...parlayRecord(parlays, analystId),
    }))
    .filter((row) => row.decided >= minimumDecided)
    .sort((a, b) => b.winRate - a.winRate || b.decided - a.decided);
}
