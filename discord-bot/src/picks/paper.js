import { SCALP_ACTIONS, roundTripCostCents, scalpDecision } from '../signals/scalp.js';
import { directionalRead } from '../signals/direction.js';
import { readBoard, boardIsUnreadable, censusLine } from '../signals/board.js';
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
    // Refusals broken down by reason. Without this the report says "refused 41"
    // and nobody — including whoever wrote it — can tell an engine that is
    // working from an engine that is broken. With it, "38 no_edge" reads as a
    // fair market and "38 no_price" reads as a bug, in one glance.
    census: {},
    // Bumped on every reset. The background sweep reads the account, then waits
    // on the network, then writes it back; a reset landing inside that gap was
    // silently overwritten by the stale copy, which is exactly the "reset does
    // not work" that got reported.
    epoch: at,
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
export function paperTick(
  account,
  input,
  { now = Date.now(), ticker = null, sizing = {}, candidates = null } = {},
) {
  const position = account.position;

  // Holding something: the only market that matters is the one it is held on.
  // Reading the board's best strike instead would judge a position against a
  // contract it is not in — and settle it against a strike it was never
  // written on, which is the same class of mistake as grading a Kalshi call on
  // the spot price.
  if (position) return holdTick(account, position, input, { now, candidates });

  // Flat: the whole ladder is on the table. This is the change that answers
  // "it skips every market" — not a lower bar, a wider look.
  const board = candidates
    ? readBoard(candidates, input)
    : readBoard(
        [{ price: input?.marketPriceCents, market: input?.market, strike: input?.strike }],
        input,
      );

  const seen = countLook(account, board);

  // The refusal the person paying for this explicitly asked to keep: when the
  // ladder as a whole says the volatility cannot be read, stand aside. One
  // strike slipping through a condition that refused all the others is the
  // definition of a false positive.
  if (boardIsUnreadable(board)) return { account: seen, event: null };
  if (!board.best) return { account: seen, event: null };

  return enterTick(seen, board.best, { now, ticker, sizing });
}

/** One tick while a position is open: hold, sell, or let it settle. */
function holdTick(account, position, input, { now, candidates }) {
  // The market this position actually lives on, found by ticker. When the
  // window has rolled it is gone from the board, and the position settles
  // against ITS OWN strike rather than whatever strike is listed now.
  const mine =
    (candidates ?? []).find((candidate) => candidate?.market?.ticker === position.ticker) ?? null;

  const strike = Number.isFinite(position.strike) ? position.strike : input?.strike;
  const marketPriceCents = mine ? mine.price : input?.marketPriceCents;
  const market = mine ? mine.market : input?.market;

  // Out of time, or the contract is no longer listed: it settled, and
  // settlement costs no fee at all.
  const expired = !(input?.secondsLeft > 0) || (candidates && !mine);
  if (expired) {
    const won = position.side === 'up' ? input.spot > strike : input.spot <= strike;
    const proceeds = won ? position.contracts * 1 : 0;
    const closed = { ...position, exitCents: won ? 100 : 0, proceeds, reason: 'settled', at: now };
    return { account: bookTrade(account, closed), event: { kind: 'settled', trade: closed } };
  }

  const read = directionalRead({ ...input, strike, marketPriceCents, market });
  const quotes = read.result?.quotes;
  if (!quotes) return { account, event: null };

  // What the held side could be SOLD for: its own bid. A DOWN position is sold
  // at the NO bid, which is a hundred minus the YES ask.
  const heldBid = position.side === 'up' ? quotes.yesBidCents : quotes.noBidCents;

  const call = scalpDecision({
    position: { entryCents: position.entryCents, side: position.side },
    nowCents: heldBid,
    signal: read.result,
    secondsLeft: input.secondsLeft,
  });

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

/** Books what the whole board was looked at and refused for. */
function countLook(account, board) {
  const census = { ...(account.census ?? {}) };
  for (const { reason, count } of board.census ?? []) {
    census[reason] = (census[reason] ?? 0) + count;
  }
  return {
    ...account,
    seen: account.seen + board.looked,
    refused: account.refused + board.refused,
    census,
  };
}

/** Opens the board's best strike, if the stake buys at least one contract. */
function enterTick(account, entry, { now, ticker, sizing }) {
  const read = entry.read;

  // Sized the way the live bot sizes: a quarter of Kelly on the pessimistic
  // probability, hard-capped.
  const sized = recommendSize({
    probability: read.winProbability,
    worstProbability: read.result.worstWinProbability ?? read.winProbability,
    priceDollars: read.entryCents / 100,
    ...sizing,
  });

  const stake = account.cash * (sized?.suggested ?? 0);
  const contracts = contractsFor(stake, read.entryCents);
  if (contracts < 1) return { account, event: null };

  // Buying pays the ask, plus the fee, out of cash.
  const cost = contracts * (read.entryCents / 100);
  const fee = contracts * feePerContract(read.entryCents / 100);
  if (cost + fee > account.cash) return { account, event: null };

  const opened = {
    ticker: entry.ticker ?? ticker,
    // The strike is part of the position, not part of the feed. Settling
    // against whatever strike the feed lists at the bell grades the trade on a
    // contract it was never in — and once the bot reads a ladder rather than a
    // single market, "whatever the feed lists" is a different strike almost
    // every tick.
    strike: entry.strike,
    side: read.call,
    entryCents: read.entryCents,
    contracts,
    cost: cost + fee,
    openedAt: now,
    modelProbability: read.winProbability,
  };

  return {
    account: { ...account, cash: account.cash - (cost + fee), position: opened },
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

  // The refusal breakdown. A bare count cannot distinguish an engine finding a
  // fair market from an engine that has stopped being able to read a price, and
  // those need completely different responses.
  const why = censusLine(
    Object.entries(account.census ?? {})
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
  );

  if (closed.length === 0) {
    lines.push(
      '',
      `No trades. It looked at **${account.seen}** market(s) and refused **${account.refused}**.`,
      why ? `Why: ${why}.` : null,
      '_Refusing is the normal state. Most 15-minute markets are priced correctly._',
    );
  } else {
    lines.push(
      '',
      `**${closed.length}** trade(s) · **${wins}W ${losses}L** · ` +
        `refused **${account.refused}** of **${account.seen}** market(s)`,
      why ? `Refused because: ${why}.` : null,
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
        `at **${Math.round(account.position.entryCents)}%**` +
        // Which strike, now that there is a ladder of them. "Holding UP" means
        // nothing when a dozen contracts on the same asset are all called UP.
        (Number.isFinite(account.position.strike)
          ? ` · strike **$${Math.round(account.position.strike).toLocaleString('en-US')}**`
          : '') +
        '.',
    );
  }

  lines.push(
    '',
    '_Imaginary money, real prices: bought at the ask, sold at the bid, both fees charged._',
    '_What it cannot know is whether that price was there in size._',
  );

  return lines.filter((line) => line !== null && line !== undefined).join('\n');
}

/** Whether enough time has passed to send another report. */
export function reportDue(account, { now = Date.now(), everyHours = 6 } = {}) {
  return now - (account.lastReportAt ?? 0) >= everyHours * 3_600_000;
}
