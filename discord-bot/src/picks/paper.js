import { SCALP_ACTIONS, roundTripCostCents, scalpDecision } from '../signals/scalp.js';
import { directionalRead } from '../signals/direction.js';
import { readBoard, boardIsUnreadable, brokenDiagnosis, censusLine } from '../signals/board.js';
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

/**
 * How hard the account is allowed to push.
 *
 * `careful` is what the measurements support: six cents of edge, quarter
 * Kelly, no entries inside two minutes of the bell. `scalp` is what was asked
 * for — thinner edges, bigger bets, later entries, profits banked sooner.
 *
 * The honest label on `scalp`: the simulator says a three-cent bar loses about
 * 7.6% against a market that is never wrong, where six cents loses 2.1%. That
 * is the cost of trading more, and it is measured rather than feared. It is
 * also exactly why this belongs in a PAPER account first: imaginary money is
 * what a question like this is for, and being timid with imaginary money learns
 * nothing.
 */
export const PROFILES = {
  careful: {
    label: 'careful',
    engine: { minimumEdgeCents: 6, minimumWorstCaseEdgeCents: 2 },
    sizing: { kellyFraction: 0.25, maximumFraction: 0.1 },
    scalp: { marginCents: 0.5, noEntryWithinSeconds: 120 },
  },
  scalp: {
    label: 'scalp',
    // Half the edge required, and the pessimistic-volatility test dropped to
    // break-even rather than +2¢: both of those gates exist to reject edges
    // that are really vol-estimate noise, and loosening them means accepting
    // some of that noise on purpose.
    engine: { minimumEdgeCents: 3, minimumWorstCaseEdgeCents: 0 },
    // Double the Kelly portion and double the cap. Size is what actually bounds
    // the damage on this instrument — stops were measured and they are worse —
    // so this is the knob that carries the real risk of the profile.
    sizing: { kellyFraction: 0.5, maximumFraction: 0.2 },
    // Enters a minute from the bell instead of two, and banks a move as soon as
    // it has covered the round trip plus a quarter cent.
    scalp: { marginCents: 0.25, noEntryWithinSeconds: 60 },
  },
};

export function profileOf(account) {
  return PROFILES[account?.profile] ?? PROFILES.careful;
}

export function newAccount({ bankroll = START_BANKROLL, at = Date.now(), profile = 'scalp' } = {}) {
  return {
    cash: bankroll,
    start: bankroll,
    startedAt: at,
    position: null,
    trades: [],
    lastReportAt: at,
    profile: PROFILES[profile] ? profile : 'careful',
    // Distinct CONTRACTS considered, not sweeps performed.
    //
    // This counted once per tick, and the sweep runs every ten seconds — so six
    // hours of watching the same handful of 15-minute markets reported "2100
    // markets", which is 2160 ticks wearing a different hat. It made a working
    // reset look broken, because the number climbed back into the hundreds
    // within minutes, and it made every refusal ratio meaningless.
    //
    // A market is now counted ONCE, when it rolls off the board, with whatever
    // the last word on it was.
    seen: 0,
    refused: 0,
    // Raw sweeps, kept so the two numbers can be shown side by side and the old
    // inflated figure is recognisable for what it was.
    looks: 0,
    // Contracts currently in view: ticker -> refusal reason, or null if it was
    // tradeable. Bounded by the size of one window's ladder.
    window: {},
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
  const profile = profileOf(account);

  // The board is read on every tick, holding or not.
  //
  // It costs nothing — the quotes were already fetched — and it is what keeps
  // the census honest: contracts expire whether or not the account happens to
  // be in one, and only counting them while flat would report a fraction of the
  // day and call it the whole of it.
  const board = candidates
    ? readBoard(candidates, input, profile.engine)
    : readBoard(
        [{ price: input?.marketPriceCents, market: input?.market, strike: input?.strike }],
        input,
        profile.engine,
      );

  const seen = countLook(account, board);

  // Holding something: the only market that matters is the one it is held on.
  // Reading the board's best strike instead would judge a position against a
  // contract it is not in — and settle it against a strike it was never
  // written on, which is the same class of mistake as grading a Kalshi call on
  // the spot price.
  if (position) return holdTick(seen, position, input, { now, candidates });

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

  const profile = profileOf(account);
  const read = directionalRead({ ...input, strike, marketPriceCents, market }, profile.engine);
  const quotes = read.result?.quotes;
  if (!quotes) return { account, event: null };

  // What the held side could be SOLD for: its own bid. A DOWN position is sold
  // at the NO bid, which is a hundred minus the YES ask.
  const heldBid = position.side === 'up' ? quotes.yesBidCents : quotes.noBidCents;

  const call = scalpDecision(
    {
      position: { entryCents: position.entryCents, side: position.side },
      nowCents: heldBid,
      signal: read.result,
      secondsLeft: input.secondsLeft,
    },
    profile.scalp,
  );

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

/**
 * A reason that is trivially true of every contract in its final seconds,
 * whatever else was going on. `too_late` fires once secondsLeft drops below
 * the floor no matter how good or bad the price was, and `no_clock` is the
 * same failure with no clock read at all — so if the LAST look before a
 * contract rolled off the board is the one kept, every contract that was
 * never tradeable ends up filed as "too late", which is true of its last ten
 * seconds and says nothing about the other fourteen minutes and fifty
 * seconds it was refused for.
 */
const TRIVIAL_TAIL_REASONS = new Set(['too_late', 'no_clock']);

/**
 * The reason worth remembering for a contract, between what was already on
 * record and what this tick just saw.
 *
 * A substantive refusal (no_edge, wide_spread, priced_out, ...) always wins,
 * because it is the actual answer to "why didn't this trade". A trivial tail
 * reason only gets recorded when nothing more informative was ever seen —
 * it must not be allowed to overwrite a real answer just for arriving last.
 */
function betterReason(existing, next) {
  if (existing === undefined) return next;
  if (!TRIVIAL_TAIL_REASONS.has(next)) return next;
  return TRIVIAL_TAIL_REASONS.has(existing) ? next : existing;
}

/**
 * Books the board, counting each CONTRACT once rather than each sweep.
 *
 * A contract stays "in view" while it is listed, and its entry is overwritten
 * every tick with the latest word on it. Only when it rolls off the board — the
 * bell rang, the window moved on — is it folded into the totals, once, with
 * whatever the last verdict was.
 *
 * This is what the old counter got wrong. It added one per tick, so the same
 * fifteen-minute market was counted about ninety times, and six hours of
 * watching a handful of contracts reported two thousand markets.
 */
function countLook(account, board) {
  const window = { ...(account.window ?? {}) };
  const census = { ...(account.census ?? {}) };
  let seen = account.seen;
  let refused = account.refused;

  const listed = new Set();
  for (const entry of board.reads ?? []) {
    // A contract with no ticker still needs identifying, or it is never counted
    // at all. The strike is what actually distinguishes one contract in a
    // window from another, so it stands in when the feed did not name it.
    const key = entry.ticker ?? `strike:${entry.strike}`;
    listed.add(key);
    // Null means it cleared the bar at least at this moment. A market that was
    // ever tradeable is not a refusal, whatever it looks like later.
    window[key] = entry.read.tradeable
      ? null
      : window[key] === null
        ? null
        : betterReason(window[key], entry.read.result?.reason ?? 'no read');
  }

  // Anything no longer listed has finished. Count it, once.
  for (const [ticker, reason] of Object.entries(window)) {
    if (listed.has(ticker)) continue;
    seen += 1;
    if (reason !== null) {
      refused += 1;
      census[reason] = (census[reason] ?? 0) + 1;
    }
    delete window[ticker];
  }

  return {
    ...account,
    seen,
    refused,
    census,
    window,
    looks: (account.looks ?? 0) + 1,
  };
}

/** Opens the board's best strike, if the stake buys at least one contract. */
function enterTick(account, entry, { now, ticker, sizing }) {
  const read = entry.read;
  const profile = profileOf(account);

  // Sized the way the live bot sizes: a quarter of Kelly on the pessimistic
  // probability, hard-capped.
  const sized = recommendSize({
    probability: read.winProbability,
    worstProbability: read.result.worstWinProbability ?? read.winProbability,
    priceDollars: read.entryCents / 100,
    ...profile.sizing,
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
    `_Mode: **${profileOf(account).label}**_`,
    '',
    `**${sign(profit)}${money(profit).replace('$', '$')}** · **${sign(percent)}${percent.toFixed(1)}%** in ${hours.toFixed(0)}h`,
  ];

  // The refusal breakdown. A bare count cannot distinguish an engine finding a
  // fair market from an engine that has stopped being able to read a price, and
  // those need completely different responses.
  const rows = Object.entries(account.census ?? {})
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
  const why = censusLine(rows);
  const broken = brokenDiagnosis(rows);

  if (closed.length === 0) {
    lines.push(
      '',
      `No trades. **${account.seen}** contract(s) went by and it refused **${account.refused}**.`,
      why ? `Why: ${why}.` : null,
      lookLine(account),
      broken ? broken.message : '_Refusing is the normal state. Most 15-minute markets are priced correctly._',
    );
  } else {
    lines.push(
      '',
      `**${closed.length}** trade(s) · **${wins}W ${losses}L** · ` +
        `refused **${account.refused}** of **${account.seen}** contract(s)`,
      why ? `Refused because: ${why}.` : null,
      lookLine(account),
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

/**
 * The two numbers that used to be one, and the reason they are both shown.
 *
 * The sweep runs every ten seconds, so six hours of watching the same handful
 * of fifteen-minute contracts is about 2,160 looks at maybe two dozen markets.
 * Reporting the looks as "markets" turned that into "2100 markets in 6 hours",
 * which is impossible on its face and made a working reset look broken.
 */
function lookLine(account) {
  const looks = account.looks ?? 0;
  if (looks === 0) return null;
  return (
    `_${looks.toLocaleString('en-US')} sweep(s) of the board — a contract is counted once, ` +
    `when it expires, not once every ten seconds._`
  );
}

/**
 * Both accounts, side by side, in one message.
 *
 * One message and not two, because the comparison IS the answer. Two separate
 * reports arriving together make a person do the subtraction themselves, and
 * the subtraction is the only part that matters: same markets, same instant,
 * same quoted prices, one difference between them.
 *
 * The controlled experiment is what makes this worth anything. A careful run
 * from Tuesday against an aggressive run from Thursday compares two weeks of
 * weather. These two see the identical tape.
 */
export function compareReport(accounts, { now = Date.now(), marks = {} } = {}) {
  const entries = Object.entries(accounts ?? {}).filter(([, account]) => account?.start > 0);
  if (entries.length === 0) return 'No paper runs going.';
  if (entries.length === 1) {
    const [profile, account] = entries[0];
    return report(account, { now, markCents: marks[profile] ?? null });
  }

  const money = (n) => `$${n.toFixed(2)}`;
  const sign = (n) => (n >= 0 ? '+' : '');

  const rows = entries
    .map(([profile, account]) => {
      const value = equity(account, marks[profile] ?? null);
      const profit = value - account.start;
      return {
        profile,
        label: PROFILES[profile]?.label ?? profile,
        value,
        profit,
        percent: (profit / account.start) * 100,
        trades: account.trades.length,
        wins: account.trades.filter((trade) => trade.profit > 0).length,
        losses: account.trades.filter((trade) => trade.profit < 0).length,
        seen: account.seen,
        refused: account.refused,
        account,
      };
    })
    // Best first, so the answer is the first thing read.
    .sort((a, b) => b.percent - a.percent);

  const hours = (now - Math.min(...entries.map(([, a]) => a.startedAt))) / 3_600_000;
  const lines = [
    `⚖️ **PAPER — ${rows.length} runs, same markets, ${hours.toFixed(0)}h**`,
    '',
  ];

  for (const row of rows) {
    lines.push(
      `${row.profit >= 0 ? '📈' : '📉'} **${row.label.toUpperCase()} — ${money(row.value)}** ` +
        `_(${sign(row.percent)}${row.percent.toFixed(1)}%)_`,
      row.trades === 0
        ? `　no trades · **${row.seen}** contract(s) seen, **${row.refused}** refused`
        : `　**${row.trades}** trade(s) · **${row.wins}W ${row.losses}L** · ` +
          `refused **${row.refused}** of **${row.seen}**`,
    );

    const why = censusLine(
      Object.entries(row.account.census ?? {})
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
      { limit: 3 },
    );
    if (why) lines.push(`　_${why}_`);
    lines.push('');
  }

  // Before any comparison: whether these numbers mean anything at all. Two runs
  // both refusing everything for want of a clock are not level pegging, they
  // are both blind, and calling that "dead level" is the report lying politely.
  const allCensus = new Map();
  for (const row of rows) {
    for (const [reason, count] of Object.entries(row.account.census ?? {})) {
      allCensus.set(reason, (allCensus.get(reason) ?? 0) + count);
    }
  }
  const broken = brokenDiagnosis(
    [...allCensus].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
  );
  if (broken) {
    lines.push(broken.message, '', '_Neither run is a verdict on anything until this is fixed._');
    return lines.join('\n');
  }

  // The subtraction, done for them.
  const [best, worst] = [rows[0], rows.at(-1)];
  const gap = best.percent - worst.percent;
  const totalTrades = rows.reduce((sum, row) => sum + row.trades, 0);

  lines.push(
    gap < 0.05
      ? '**Dead level so far.** Neither setting has shown anything the other has not.'
      : `**${best.label} is ahead by ${gap.toFixed(1)} points**, on ${totalTrades} trade(s) between them.`,
  );

  // The warning that has to travel with the number, every time. A handful of
  // 15-minute binaries is a coin-flip sequence, and the gap between two of them
  // after a day says almost nothing.
  lines.push(
    totalTrades < 40
      ? '_Far too few trades to mean anything. Under about forty a side, this gap is noise ' +
        'and reading it as a verdict is how a bad setting gets promoted._'
      : '_Still early. Judge this over weeks, not days._',
    '',
    '_Imaginary money, real prices: bought at the ask, sold at the bid, both fees charged._',
  );

  return lines.join('\n');
}
