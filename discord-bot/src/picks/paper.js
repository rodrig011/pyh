import { SCALP_ACTIONS, roundTripCostCents, scalpDecision } from '../signals/scalp.js';
import { directionalRead } from '../signals/direction.js';
import { recommendSize } from '../signals/sizing.js';
import { feePerContract } from '../signals/math.js';

/**
 * The engine trading the real market with imaginary money.
 *
 * Everything before this was either a simulation of a market I invented, or a
 * measurement of how well the model forecasts. Neither answers the question
 * somebody actually has, which is: if I had done what it said, all day, every
 * day, would there be more money at the end.
 *
 * So it trades. Real contract, real quoted prices, real fees, imaginary
 * dollars. The rules that make the answer worth having:
 *
 *   - Buying pays the ASK and selling takes the BID. Filling at the mid is how
 *     a paper account beats a real one by half a spread on every trade and
 *     nobody notices until the money is real.
 *   - The fee comes off both legs, and settlement is free, exactly as the
 *     exchange charges it.
 *   - It only enters what the live engine would call. No hindsight, no
 *     re-reading a market with the answer in hand.
 *
 * What it still cannot model: whether that quoted price was available in size,
 * and whether a real order would have moved the book. On a market showing $400
 * resting, a $3 order is a fair assumption. It is still an assumption.
 */

export const START_BANKROLL = 70;

export function newAccount({ bankroll = START_BANKROLL, at = Date.now() } = {}) {
  return {
    cash: bankroll,
    start: bankroll,
    startedAt: at,
    position: null,
    trades: [],
    lastReportAt: at,
    // Every market it looked at and refused, so the report can say how much of
    // the day was spent waiting rather than trading.
    seen: 0,
    refused: 0,
  };
}

/** Contracts affordable at a price, given the stake. Whole contracts only. */
export function contractsFor(stakeDollars, priceCents) {
  if (!(stakeDollars > 0) || !(priceCents > 0)) return 0;
  return Math.floor(stakeDollars / (priceCents / 100));
}

/**
 * One tick of the paper account against a live market read.
 *
 * Pure: the market is handed in, so a day can be replayed from the recorded
 * log and the account rebuilt exactly.
 */
export function paperTick(account, input, { now = Date.now(), ticker = null, sizing = {} } = {}) {
  const read = directionalRead(input);
  const quotes = read.result?.quotes;
  if (!quotes) return { account, event: null };

  const position = account.position;

  // What the held side could be SOLD for: its own bid. A DOWN position is sold
  // at the NO bid, which is a hundred minus the YES ask.
  const heldBid = position
    ? position.side === 'up'
      ? quotes.yesBidCents
      : quotes.noBidCents
    : null;

  if (position) {
    const call = scalpDecision({
      position: { entryCents: position.entryCents, side: position.side },
      nowCents: heldBid,
      signal: read.result,
      secondsLeft: input.secondsLeft,
    });

    // Out of time and still holding: it settles, which costs no fee at all.
    const expired = !(input.secondsLeft > 0);
    if (expired) {
      const won = position.side === 'up' ? input.spot > input.strike : input.spot <= input.strike;
      const proceeds = won ? position.contracts * 1 : 0;
      const closed = { ...position, exitCents: won ? 100 : 0, proceeds, reason: 'settled', at: now };
      return {
        account: bookTrade(account, closed),
        event: { kind: 'settled', trade: closed },
      };
    }

    if (call.action === SCALP_ACTIONS.EXIT && heldBid > 0) {
      // Selling pays a fee on the way out too.
      const gross = position.contracts * (heldBid / 100);
      const fee = position.contracts * feePerContract(heldBid / 100);
      const closed = {
        ...position,
        exitCents: heldBid,
        proceeds: gross - fee,
        reason: call.reason,
        at: now,
      };
      return { account: bookTrade(account, closed), event: { kind: 'exit', trade: closed } };
    }

    return { account, event: null };
  }

  const seen = { ...account, seen: account.seen + 1 };
  if (!read.tradeable) return { account: { ...seen, refused: seen.refused + 1 }, event: null };

  // Sized the way the live bot sizes: a quarter of Kelly on the pessimistic
  // probability, hard-capped.
  const sized = recommendSize({
    probability: read.winProbability,
    worstProbability: read.result.worstWinProbability ?? read.winProbability,
    priceDollars: read.entryCents / 100,
    ...sizing,
  });

  const stake = seen.cash * (sized?.suggested ?? 0);
  const contracts = contractsFor(stake, read.entryCents);
  if (contracts < 1) return { account: seen, event: null };

  // Buying pays the ask, plus the fee, out of cash.
  const cost = contracts * (read.entryCents / 100);
  const fee = contracts * feePerContract(read.entryCents / 100);
  if (cost + fee > seen.cash) return { account: seen, event: null };

  const opened = {
    ticker,
    side: read.call,
    entryCents: read.entryCents,
    contracts,
    cost: cost + fee,
    openedAt: now,
    modelProbability: read.winProbability,
  };

  return {
    account: { ...seen, cash: seen.cash - (cost + fee), position: opened },
    event: { kind: 'enter', trade: opened },
  };
}

/** Moves a closed position into the ledger and returns the cash. */
function bookTrade(account, closed) {
  const profit = closed.proceeds - closed.cost;
  return {
    ...account,
    cash: account.cash + closed.proceeds,
    position: null,
    trades: [...account.trades, { ...closed, profit }].slice(-500),
  };
}

/** Cash plus whatever an open position could be sold for right now. */
export function equity(account, markCents = null) {
  const open =
    account.position && markCents > 0 ? account.position.contracts * (markCents / 100) : 0;
  return account.cash + open;
}

/**
 * The six-hourly report.
 *
 * Written to be read by somebody who wants one number and then, if that number
 * is interesting, the reason for it. The gross-versus-net line is not optional:
 * a paper account that reports only the profit hides the single thing most
 * likely to make it wrong in real life.
 */
export function report(account, { now = Date.now(), markCents = null } = {}) {
  const value = equity(account, markCents);
  const profit = value - account.start;
  const percent = (profit / account.start) * 100;
  const hours = (now - account.startedAt) / 3_600_000;

  const closed = account.trades;
  const wins = closed.filter((t) => t.profit > 0).length;
  const losses = closed.filter((t) => t.profit < 0).length;
  const fees = closed.reduce(
    (total, t) => total + t.contracts * roundTripCostCents(t.entryCents, Math.max(1, t.exitCents)) / 100,
    0,
  );

  const money = (n) => `$${n.toFixed(2)}`;
  const sign = (n) => (n >= 0 ? '+' : '');

  const lines = [
    `${profit >= 0 ? '📈' : '📉'} **PAPER — ${money(value)}** _(started ${money(account.start)})_`,
    '',
    `**${sign(profit)}${money(profit).replace('$', '$')}** · **${sign(percent)}${percent.toFixed(1)}%** in ${hours.toFixed(0)}h`,
  ];

  if (closed.length === 0) {
    lines.push(
      '',
      `No trades. It looked at **${account.seen}** market(s) and refused **${account.refused}**.`,
      '_Refusing is the normal state. Most 15-minute markets are priced correctly._',
    );
  } else {
    lines.push(
      '',
      `**${closed.length}** trade(s) · **${wins}W ${losses}L** · ` +
        `refused **${account.refused}** of **${account.seen}** market(s)`,
      `**${money(fees)}** of that went to the exchange in fees.`,
    );

    const best = closed.reduce((a, b) => (b.profit > a.profit ? b : a));
    const worst = closed.reduce((a, b) => (b.profit < a.profit ? b : a));
    lines.push(
      '',
      `Best **${sign(best.profit)}${money(best.profit)}** · worst **${sign(worst.profit)}${money(worst.profit)}**`,
    );
  }

  if (account.position) {
    lines.push(
      '',
      `Currently holding **${account.position.contracts} ${account.position.side.toUpperCase()}** ` +
        `at **${Math.round(account.position.entryCents)}%**.`,
    );
  }

  lines.push(
    '',
    '_Imaginary money, real prices: bought at the ask, sold at the bid, both fees charged._',
    '_What it cannot know is whether that price was there in size._',
  );

  return lines.join('\n');
}

/** Whether enough time has passed to send another report. */
export function reportDue(account, { now = Date.now(), everyHours = 6 } = {}) {
  return now - (account.lastReportAt ?? 0) >= everyHours * 3_600_000;
}
