/**
 * The rails that stand between a bug and somebody's actual money.
 *
 * Every other file here answers "should we take this trade". This one answers
 * "may we", and the two are deliberately separate: a model that is wrong loses
 * slowly and is caught by the record, while a bug that is wrong loses
 * everything at once and is caught by nothing. Only one of those needs a rail.
 *
 * The design rule throughout: every limit is checked against what the exchange
 * says happened, not against what this process thinks it did. A counter held in
 * memory is reset by a redeploy, and this bot redeployed eight times in one day.
 * A day's spending rebuilt from filled orders survives restarts, crashes and
 * this file being wrong about its own state.
 *
 * DISARMED BY DEFAULT, and that is not a formality. Arming is a separate,
 * explicit act with its own command, because the difference between "the code
 * can trade" and "the code is trading" is the only difference that matters at
 * three in the morning.
 */

/** The whole day's budget. Nothing can raise this at runtime except a person. */
export const DEFAULT_DAILY_LIMIT_DOLLARS = 20;

/** The most that may sit in one position, as a share of the daily budget. */
export const DEFAULT_PER_TRADE_SHARE = 0.25;

/** Consecutive losses before the day is over, whatever the budget says. */
export const DEFAULT_LOSS_STREAK_STOP = 3;

export const BLOCKED = {
  DISARMED: 'disarmed',
  NO_CREDENTIALS: 'no_credentials',
  DAILY_LIMIT: 'daily_limit',
  LOSS_STREAK: 'loss_streak',
  ALREADY_IN: 'already_in',
  TOO_BIG: 'too_big',
  KILLED: 'killed',
  STALE_CLOCK: 'stale_clock',
};

export function newRiskState({ dailyLimitDollars = DEFAULT_DAILY_LIMIT_DOLLARS, at = Date.now() } = {}) {
  return {
    armed: false,
    dailyLimitDollars,
    // Set by a person, cleared by a person. A kill switch that expires by
    // itself is not a kill switch.
    killed: false,
    killedReason: null,
    armedAt: null,
    createdAt: at,
  };
}

/**
 * The UTC day a moment belongs to.
 *
 * UTC rather than local, because Kalshi settles on it and a limit that resets
 * at a different hour from the exchange is a limit with a seam in it.
 */
export function dayKey(at = Date.now()) {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * What has actually been spent today, rebuilt from the orders that filled.
 *
 * `orders` are this bot's own records of what it sent AND what came back. Only
 * filled contracts count towards the budget: an order that was rejected cost
 * nothing, and an order whose fate is unknown is counted as spent, because the
 * safe assumption about an unknown order is that it worked.
 */
export function spentToday(orders, { now = Date.now() } = {}) {
  const today = dayKey(now);
  let spent = 0;
  let trades = 0;
  let realised = 0;

  for (const order of orders ?? []) {
    if (dayKey(order?.at ?? 0) !== today) continue;
    if (order.status === 'rejected') continue;

    spent += Number(order.costDollars) || 0;
    trades += 1;
    if (Number.isFinite(order.profitDollars)) realised += order.profitDollars;
  }

  return { spent, trades, realised, day: today };
}

/** How many trades in a row have lost, most recent first. */
export function lossStreak(orders, { now = Date.now() } = {}) {
  const today = dayKey(now);
  let streak = 0;
  for (const order of [...(orders ?? [])].reverse()) {
    if (dayKey(order?.at ?? 0) !== today) break;
    if (!Number.isFinite(order.profitDollars)) continue;
    if (order.profitDollars >= 0) break;
    streak += 1;
  }
  return streak;
}

/**
 * May this trade be placed, and for how much.
 *
 * Returns the size in DOLLARS that is allowed, which is never more than what is
 * asked for and is often less. A caller that ignores the returned size and uses
 * its own has defeated the whole file, so the size is the only thing returned
 * that is worth reading.
 */
export function checkTrade({
  state,
  orders = [],
  wantDollars,
  hasCredentials = false,
  openPosition = null,
  secondsLeft = null,
  now = Date.now(),
  perTradeShare = DEFAULT_PER_TRADE_SHARE,
  lossStreakStop = DEFAULT_LOSS_STREAK_STOP,
} = {}) {
  const no = (blocked, why) => ({ allowed: false, dollars: 0, blocked, why });

  if (!state?.armed) return no(BLOCKED.DISARMED, 'Live trading is not armed.');
  if (state.killed) return no(BLOCKED.KILLED, `Killed: ${state.killedReason ?? 'by hand'}`);
  if (!hasCredentials) return no(BLOCKED.NO_CREDENTIALS, 'No trading credentials configured.');

  // One position at a time. Two open bets on a fifteen-minute crypto contract
  // are not two bets — they move together, so the real exposure is the sum
  // while the limit was written for one.
  if (openPosition) return no(BLOCKED.ALREADY_IN, 'Already holding a position.');

  // A clock this bot cannot read has already caused it to refuse every market
  // for two days. Refusing to SPEND on one is the same caution pointed at the
  // thing that costs money.
  if (!Number.isFinite(secondsLeft) || secondsLeft <= 0) {
    return no(BLOCKED.STALE_CLOCK, 'No readable time left on this market.');
  }

  const { spent, realised } = spentToday(orders, { now });
  const limit = Number(state.dailyLimitDollars) || DEFAULT_DAILY_LIMIT_DOLLARS;

  // The budget is what may be PUT AT RISK today, not a target for net losses.
  // Counting only losses would let a day of round trips spend the limit many
  // times over on the way to the same place.
  const remaining = limit - spent;
  if (!(remaining > 0)) {
    return no(BLOCKED.DAILY_LIMIT, `Today's $${limit.toFixed(2)} is spent (${spent.toFixed(2)}).`);
  }

  const streak = lossStreak(orders, { now });
  if (streak >= lossStreakStop) {
    return no(
      BLOCKED.LOSS_STREAK,
      `${streak} losses in a row. Done for the day — a losing streak is when a wrong model looks most like a run of bad luck.`,
    );
  }

  const perTradeCap = limit * perTradeShare;
  const dollars = Math.min(Number(wantDollars) || 0, perTradeCap, remaining);
  if (!(dollars > 0)) return no(BLOCKED.TOO_BIG, 'Nothing left to size this with.');

  return {
    allowed: true,
    dollars,
    // Everything the caller might want to say out loud, so it does not have to
    // recompute any of it and get a different answer.
    remainingToday: remaining - dollars,
    spentToday: spent,
    realisedToday: realised,
    lossStreak: streak,
    limit,
    perTradeCap,
  };
}

/** A one-line status a person can read before deciding to trust it. */
export function riskSummary(state, orders = [], { now = Date.now() } = {}) {
  const { spent, trades, realised } = spentToday(orders, { now });
  const limit = Number(state?.dailyLimitDollars) || DEFAULT_DAILY_LIMIT_DOLLARS;

  return {
    armed: Boolean(state?.armed) && !state?.killed,
    killed: Boolean(state?.killed),
    killedReason: state?.killedReason ?? null,
    limit,
    spent,
    remaining: Math.max(0, limit - spent),
    trades,
    realised,
    lossStreak: lossStreak(orders, { now }),
    day: dayKey(now),
  };
}
