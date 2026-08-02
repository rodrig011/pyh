/**
 * Trading calls and the record they build up.
 *
 * A room where analysts shout "up" and "down" all day is only worth paying for
 * if somebody is counting. Every call is written down before its window opens
 * and settled after it closes, so a track record accumulates whether or not it
 * flatters anyone — a leaderboard that can only go up is marketing, not a
 * record.
 *
 * Pure: these are the numbers members judge the room by, so they have to be
 * checkable against fixed data rather than eyeballed in Discord.
 */

export const DIRECTIONS = { UP: 'up', DOWN: 'down' };
export const OUTCOMES = { WIN: 'win', LOSS: 'loss', BREAK_EVEN: 'break_even', VOID: 'void' };

export const DIRECTION_LABEL = {
  [DIRECTIONS.UP]: '🟢 LONG',
  [DIRECTIONS.DOWN]: '🔴 SHORT',
};

/**
 * When the window should close.
 *
 * A 15-minute market settles on the quarter hour, not fifteen minutes after
 * whenever somebody happened to press a button — a call opened at 3:41 that
 * runs to 3:56 is graded across the boundary of the candle it was called on,
 * which is the wrong candle. Snapping to the next boundary makes the bot's
 * clock the same clock the room is trading.
 *
 * A boundary that is nearly here is skipped: a call with eleven seconds left in
 * it is not a call.
 */
export function nextCandleClose(now, minutes, { minimumSeconds = 60 } = {}) {
  const period = minutes * 60 * 1000;
  let close = Math.ceil(now / period) * period;
  if (close - now < minimumSeconds * 1000) close += period;
  return close;
}

export const OUTCOME_LABEL = {
  [OUTCOMES.WIN]: '✅ Win',
  [OUTCOMES.LOSS]: '❌ Loss',
  [OUTCOMES.BREAK_EVEN]: '➖ Break even',
  [OUTCOMES.VOID]: '🚫 Void',
};

/**
 * @param {object} input
 * @param {string} input.analystId
 * @param {string} input.direction  one of DIRECTIONS
 * @param {string} input.asset      e.g. "BTC"
 * @param {number} input.minutes    how long the call runs for
 */
export function buildPick({
  analystId,
  analystTag = null,
  guildId,
  direction,
  asset,
  minutes,
  entry = null,
  target = null,
  stop = null,
  note = null,
  sizePercent = null,
  alignToCandle = true,
  now = Date.now(),
}) {
  if (!Object.values(DIRECTIONS).includes(direction)) {
    throw new Error(`Unknown direction: ${direction}`);
  }
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error('A call has to run for a positive number of minutes');
  }

  return {
    id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    analystId,
    analystTag,
    guildId,
    direction,
    asset: asset.toUpperCase(),
    minutes,
    entry,
    target,
    stop,
    note,
    // How much of the portfolio the analyst said to put in. Part of the signal,
    // not a detail: "long BTC" and "long BTC with your whole book" differ.
    sizePercent,
    createdAt: now,
    closesAt: alignToCandle ? nextCandleClose(now, minutes) : now + minutes * 60 * 1000,
    outcome: null,
    settledAt: null,
    settledBy: null,
    // How the call ended: 'exit' when the analyst closed it, 'window' when it
    // simply ran out. The room is told which, because a call the analyst cashed
    // and a call that expired against them are not the same event.
    closedBy: null,
    exit: null,
    messageId: null,
  };
}

/** Calls whose window has closed but that nobody has graded yet. */
export function dueForSettlement(picks, now = Date.now()) {
  return picks.filter((pick) => !pick.outcome && pick.closesAt <= now);
}

export function settlePick(pick, { outcome, settledBy, exit = null, closedBy = 'window', now = Date.now() }) {
  if (!Object.values(OUTCOMES).includes(outcome)) throw new Error(`Unknown outcome: ${outcome}`);
  pick.outcome = outcome;
  pick.settledAt = now;
  pick.settledBy = settledBy ?? null;
  pick.closedBy = closedBy;
  pick.exit = exit;
  return pick;
}

/**
 * Changes the outcome of a call that was already scored.
 *
 * Kept as an amendment rather than a rewrite: the original verdict, who changed
 * it and why all stay on the record. These numbers are public and members judge
 * the room by them, so an edit that left no trace would be a way to launder a
 * record rather than correct one.
 */
export function editPickOutcome(pick, { outcome, editedBy, note = null, now = Date.now() }) {
  if (!Object.values(OUTCOMES).includes(outcome)) throw new Error(`Unknown outcome: ${outcome}`);
  if (pick.outcome === outcome) return { changed: false, from: outcome, pick };

  const from = pick.outcome;
  pick.edits = [
    ...(pick.edits ?? []),
    { from, to: outcome, by: editedBy, note, at: now },
  ];
  pick.outcome = outcome;
  pick.editedAt = now;
  pick.editedBy = editedBy;
  // A call graded by hand is no longer the price feed's verdict, and the record
  // should not go on claiming it was.
  pick.settledBy = editedBy;
  return { changed: true, from, pick };
}

/** One line describing a call, short enough for a picker. */
export function describePick(pick) {
  const when = new Date(pick.createdAt);
  const stamp = `${String(when.getUTCMonth() + 1).padStart(2, '0')}/${String(when.getUTCDate()).padStart(2, '0')} ${String(when.getUTCHours()).padStart(2, '0')}:${String(when.getUTCMinutes()).padStart(2, '0')}`;
  const side = pick.direction === DIRECTIONS.UP ? 'LONG' : 'SHORT';
  const result = pick.outcome ? OUTCOME_LABEL[pick.outcome].replace(/^\S+\s/, '') : 'open';
  return `${stamp}  ${side} ${pick.asset} ${pick.minutes}m — ${result}`;
}

/**
 * An analyst's record.
 *
 * Break-evens and voids are counted but kept out of the win rate: a call that
 * went nowhere is neither a hit nor a miss, and folding it into either one
 * would let anyone improve their percentage by calling nothing.
 */
export function computeRecord(picks, { analystId = null, sinceDays = null, now = Date.now() } = {}) {
  let considered = picks.filter((pick) => pick.outcome);
  if (analystId) considered = considered.filter((pick) => pick.analystId === analystId);
  if (sinceDays) {
    considered = considered.filter((pick) => pick.createdAt > now - sinceDays * 86400000);
  }

  const wins = considered.filter((pick) => pick.outcome === OUTCOMES.WIN).length;
  const losses = considered.filter((pick) => pick.outcome === OUTCOMES.LOSS).length;
  const breakEven = considered.filter((pick) => pick.outcome === OUTCOMES.BREAK_EVEN).length;
  const decided = wins + losses;

  // Newest first, so a streak reads forwards from the most recent call.
  const ordered = [...considered]
    .filter((pick) => pick.outcome === OUTCOMES.WIN || pick.outcome === OUTCOMES.LOSS)
    .sort((a, b) => b.createdAt - a.createdAt);

  let streak = 0;
  for (const pick of ordered) {
    const won = pick.outcome === OUTCOMES.WIN;
    if (streak === 0) streak = won ? 1 : -1;
    else if (won && streak > 0) streak += 1;
    else if (!won && streak < 0) streak -= 1;
    else break;
  }

  return {
    settled: considered.length,
    wins,
    losses,
    breakEven,
    decided,
    winRate: decided === 0 ? null : wins / decided,
    streak,
    open: picks.filter(
      (pick) => !pick.outcome && (!analystId || pick.analystId === analystId),
    ).length,
  };
}

/**
 * The leaderboard.
 *
 * Analysts below `minimum` decided calls are held back rather than shown: one
 * lucky call is 100%, and putting that above someone at 62% over forty calls
 * would make the board actively misleading.
 */
export function leaderboard(picks, { sinceDays = null, minimum = 5, now = Date.now() } = {}) {
  const analystIds = [...new Set(picks.filter((pick) => pick.outcome).map((pick) => pick.analystId))];

  const rows = analystIds.map((analystId) => ({
    analystId,
    ...computeRecord(picks, { analystId, sinceDays, now }),
  }));

  const ranked = rows
    .filter((row) => row.decided >= minimum)
    .sort((a, b) => b.winRate - a.winRate || b.decided - a.decided);

  return {
    ranked,
    provisional: rows
      .filter((row) => row.decided < minimum && row.decided > 0)
      .sort((a, b) => b.decided - a.decided),
    minimum,
  };
}

export function formatWinRate(rate) {
  return rate === null ? '—' : `${Math.round(rate * 1000) / 10}%`;
}

export function formatStreak(streak) {
  if (streak === 0) return '—';
  return streak > 0 ? `🔥 ${streak} in a row` : `🧊 ${Math.abs(streak)} down`;
}
