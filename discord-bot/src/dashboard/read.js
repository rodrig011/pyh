import { closeTimeOf, nearestTheMoneyContract } from '../picks/kalshi.js';
import { directionalRead } from '../signals/direction.js';
import { executablePrices } from '../signals/cost.js';
import { flipProbability } from '../signals/exit.js';
import { normalizeTrades, orderFlowSummary, whaleActivity, whaleLine } from '../picks/whales.js';
import { scalpDecision, SCALP_ACTIONS } from '../signals/scalp.js';
import {
  atr,
  bollingerWidth,
  distanceInSigma,
  emaStack,
  macd,
  momentum,
  rsi,
  sessionOf,
  trendFit,
} from '../signals/indicators.js';
import { confluenceRead } from '../signals/confluence.js';
import { scanPatterns } from '../signals/patterns.js';
import { findFairValueGaps, findSupportResistance } from '../signals/levels.js';
import { findKeyZones } from '../signals/keyZones.js';
import { confluencePatterns, settleConfluenceRecords } from '../signals/confluenceLog.js';
import { patternWinRates, settlePatternRecords } from '../signals/patternLog.js';
import { roundHistorySummary, settleRoundSnapshots } from '../signals/roundSnapshot.js';
import { measureEdge } from '../signals/measure.js';
import { settleObservations } from '../signals/recorder.js';
import { PROFILES, equity, lifetimeStats } from '../picks/paper.js';
import { dayKey, riskSummary } from '../picks/riskLimits.js';
import { buildCandles, buildVolume, rsiSeries } from './candles.js';

/** How much chart history to keep, independent of the 1h window the model itself reads. */
const CHART_HISTORY_MS = 4 * 60 * 60 * 1000;

/**
 * Whether the live bot's own open position should come out right now.
 *
 * Always graded in scalp's own terms (PROFILES.scalp), whatever profile the
 * position was actually ENTERED under. An exit is a different question from
 * an entry — "is this still worth holding" wants the faster, later-entering
 * rule regardless of how conservatively it got in — and the live trading
 * engine's own exit path already reasons this way rather than reusing the
 * entry profile.
 */
export function positionAction(position, board, { now, spot = null, prices = [] }) {
  if (!position) return null;
  const profile = PROFILES.scalp;
  const manual = Boolean(position.manual);

  const mine = (board?.contracts ?? []).find((candidate) => candidate?.market?.ticker === position.ticker);
  if (!mine) return { action: 'settling', ticker: position.ticker, side: position.side, manual };

  const closesAt = closeTimeOf(mine.market);
  const secondsLeft = Number.isFinite(closesAt) ? (closesAt - now) / 1000 : null;
  if (!(secondsLeft > 0)) return { action: 'settling', ticker: position.ticker, side: position.side, manual };

  const read = directionalRead(
    { prices, spot, strike: position.strike, marketPriceCents: mine.price, market: mine.market, secondsLeft },
    profile.engine,
  );
  const quotes = read.result?.quotes;
  if (!quotes) return { action: 'holding', ticker: position.ticker, side: position.side, manual };

  const heldBid = position.side === 'up' ? quotes.yesBidCents : quotes.noBidCents;
  const call = scalpDecision(
    { position: { entryCents: position.entryCents, side: position.side }, nowCents: heldBid, signal: read.result, secondsLeft },
    profile.scalp,
  );

  return {
    action: call.action === SCALP_ACTIONS.EXIT ? 'cash_out' : 'holding',
    ticker: position.ticker,
    side: position.side,
    entryCents: position.entryCents,
    nowCents: heldBid,
    reason: call.reason ?? null,
    manual,
  };
}

/**
 * What a manually-entered position should be recorded as, from a button
 * press on the dashboard showing the current board.
 *
 * The entry price is the side's own executable price right now — the ask a
 * buyer would actually pay — not the model's own called side or entry, since
 * somebody clicking "I'm in DOWN" while the model favours UP is telling the
 * truth about their own trade, not asking the model to agree with them.
 */
export function manualEntry(side, { ticker, strike, quotes, now = Date.now() }) {
  if (side !== 'up' && side !== 'down') return null;
  if (!ticker || !(strike > 0) || !quotes) return null;

  const entryCents = side === 'up' ? quotes.yesAskCents : quotes.noAskCents;
  if (!(entryCents > 0)) return null;

  return { ticker, side, strike, entryCents, manual: true, at: now };
}

/**
 * How many times the live bot has actually been right and wrong — settled
 * real orders only, read straight from the trade ledger so this can never
 * drift from what riskLimits.js itself bases the daily numbers on.
 */
export function tradeRecord(orders) {
  const settled = (orders ?? []).filter((order) => Number.isFinite(order?.profitDollars));
  const wins = settled.filter((order) => order.profitDollars > 0).length;
  const losses = settled.filter((order) => order.profitDollars < 0).length;
  const breakEven = settled.length - wins - losses;
  return {
    wins,
    losses,
    breakEven,
    total: settled.length,
    winRate: wins + losses > 0 ? wins / (wins + losses) : null,
  };
}

/** Compact, read-only paper metrics for the three controlled profiles. */
export function paperSummary(accounts, marks = {}) {
  return Object.entries(accounts ?? {}).map(([profile, account]) => {
    const value = equity(account, marks[profile] ?? null);
    const stats = lifetimeStats(account);
    return {
      profile,
      bankroll: value,
      returnPercent: account.start > 0 ? ((value - account.start) / account.start) * 100 : null,
      wins: stats.wins,
      losses: stats.losses,
      trades: stats.total,
      openPositions: account.position ? 1 : 0,
      ...(profile === 'always' ? { benchmark: true } : {}),
    };
  });
}

/**
 * Records "I'm in" from a dashboard button press — reads the board fresh, at
 * the moment of the click, rather than trusting whatever was on screen from
 * the last poll a few seconds ago.
 */
export async function enterManualPosition(store, config, side, { openBoard, fetchSpotPrice, now = Date.now() }) {
  const settings = config.picks ?? {};
  const kalshi = settings.kalshi ?? {};
  const board = await openBoard(kalshi, { now }).catch(() => null);

  const contract = nearestTheMoneyContract(board?.contracts);
  if (!contract) return { ok: false, reason: 'No readable market right now' };

  const market = contract.market ?? {};
  const strike = Number.isFinite(Number(market.floor_strike))
    ? Number(market.floor_strike)
    : Number(market.cap_strike);

  // "I'm in" records a position the person already entered. It only needs
  // Kalshi's contract price; making it depend on BTC history or the prediction
  // engine caused a valid button press to fail whenever the analytical read
  // was temporarily unavailable.
  const quotes = executablePrices(market, contract.price);
  if (!quotes) return { ok: false, reason: 'Kalshi did not provide a usable contract price right now' };

  const entry = manualEntry(side, { ticker: market.ticker, strike, quotes, now });
  if (!entry) {
    return {
      ok: false,
      reason: `Kalshi did not provide a usable ${side.toUpperCase()} entry price right now`,
    };
  }
  entry.priceQuoted = quotes.quoted;
  entry.priceSource = contract.priceSource ?? (quotes.quoted ? 'kalshi-book' : 'kalshi-last-trade');

  store.setDashboardPosition(entry);
  return { ok: true, position: entry };
}

/**
 * The same read the panel and the paper account trade on, packaged for
 * something that is not Discord. No new modelling here — this calls the
 * exact functions everything else calls (the engine, the whale tape, the
 * flip-odds formula), so the dashboard can never show something the trading
 * path itself would disagree with.
 */
export async function computeRead(
  store,
  config,
  { openBoard, fetchSpotPrice, fetchTrades = null, now = Date.now() },
) {
  const settings = config.picks ?? {};
  const kalshi = settings.kalshi ?? {};
  const asset = settings.defaultAsset ?? 'BTC';

  if (!kalshi.enabled || !kalshi.seriesTicker) {
    return { ok: false, reason: 'Kalshi is not enabled (set KALSHI_ENABLED and KALSHI_SERIES_TICKER)' };
  }

  const [board, quote] = await Promise.all([
    openBoard(kalshi, { now }).catch(() => null),
    fetchSpotPrice(asset),
  ]);

  const contract = nearestTheMoneyContract(board?.contracts);
  if (!contract) return { ok: false, reason: 'No readable market on the board right now' };
  if (!(quote?.price > 0)) {
    return {
      ok: false,
      reason: quote?.error ?? `No live ${asset} price right now`,
      priceSource: quote?.source ?? (asset === 'BTC' ? 'kalshi-brti' : null),
      priceErrorCode: quote?.errorCode ?? 'unavailable',
      priceHttpStatus: quote?.httpStatus ?? null,
    };
  }

  const market = contract.market ?? {};
  const strike = Number.isFinite(Number(market.floor_strike))
    ? Number(market.floor_strike)
    : Number(market.cap_strike);

  const closesAt = closeTimeOf(market);
  const secondsLeft = Number.isFinite(closesAt) ? (closesAt - now) / 1000 : null;

  const prices = store
    .listSamples(asset)
    .filter((sample) => sample?.at >= now - 60 * 60 * 1000 && sample?.price > 0)
    .map((sample) => sample.price);

  const read = directionalRead({
    prices,
    spot: quote.price,
    priceSource: quote.source ?? null,
    strike,
    marketPriceCents: contract.price,
    market,
    secondsLeft,
  });

  // The chance it touches the strike again before the bell — pure arithmetic
  // on the same volatility the call itself used, not a separate model.
  const sigma = read.result?.sigma ?? null;
  const flip = Number.isFinite(sigma) ? flipProbability(quote.price, strike, sigma) : null;

  // The trade tape, if this caller can fetch it. Optional: a dashboard reading
  // an account with no `fetchTrades` wired in just shows no whale reading
  // rather than failing the whole response over it.
  let whales = null;
  let volume = [];
  let orderFlow = null;
  if (fetchTrades && market.ticker) {
    const { trades } = await fetchTrades(kalshi, market.ticker).catch(() => ({ trades: [] }));
    whales = whaleActivity(trades);
    orderFlow = orderFlowSummary(trades, { now });
    // Logged so the chart has real volume to show, on this and every future
    // contract — see store.recordContractTrades for why it cannot be
    // backfilled for anything already rolled over.
    store.recordContractTrades?.(market.ticker, normalizeTrades(trades));
    volume = buildVolume(store.listContractTrades?.(market.ticker) ?? []);
  }

  // A separate, longer window than the model reads — this is for the chart,
  // which benefits from more history than a 15-minute contract's own
  // volatility estimate needs. Built before the indicators below so ATR,
  // which needs real highs and lows rather than the tick history, has candles
  // to read.
  const candles = buildCandles(
    store.listSamples(asset).filter((sample) => sample?.at >= now - CHART_HISTORY_MS),
    { bucketMs: 60_000, limit: 240 },
  );
  // RSI on the 1-minute candle closes — a coarser, chart-friendly cousin of
  // the RSI reported above, which reads the raw tick history instead.
  const rsiOverTime = rsiSeries(candles);

  // Real swing-point geometry over the same candles the chart draws — see
  // patterns.js. Purely descriptive, same as whales and confluence: never
  // fed into the call above, and comes back null for whatever it does not
  // actually find rather than a guess dressed up as a reading.
  const patterns = scanPatterns(candles);

  // Auto support/resistance and open fair-value gaps — same source candles,
  // same rule: a level or gap only appears when the real geometry backs it.
  const levels = findSupportResistance(candles);
  const fairValueGaps = findFairValueGaps(candles);
  // Where a level and a gap happen to land on the same price — see
  // keyZones.js. Deliberately narrow: only two genuinely independent
  // mechanisms are combined, never a pattern against the same pivots that
  // built the level in the first place.
  const keyZones = findKeyZones({ levels, fairValueGaps });

  // Same descriptive layer the engine's own comments describe as "what price
  // has been doing" — none of it feeds the trade decision above, it explains
  // the read rather than replacing it. Trend and momentum read the last 20
  // samples, the same window engine.js itself uses for its own trend check.
  const recent = prices.slice(-20);
  const trend = trendFit(recent);
  const stack = emaStack(prices);
  const macdRead = macd(prices);
  const bands = bollingerWidth(prices);
  const indicators = {
    rsi: rsi(prices),
    momentum: momentum(recent),
    trendR2: trend?.r2 ?? null,
    trendSlope: trend?.slope ?? null,
    // How many standard deviations of the time left the strike sits from
    // spot — the number the file itself calls "the single most useful one no
    // chart shows."
    sigmaDistance: Number.isFinite(sigma) ? distanceInSigma(quote.price, strike, sigma) : null,
    emaStack: stack.alignment,
    emaFast: stack.values?.fast ?? null,
    emaMid: stack.values?.mid ?? null,
    emaSlow: stack.values?.slow ?? null,
    macdHistogram: macdRead?.histogram ?? null,
    bollingerWidthPercent: bands?.widthPercent ?? null,
    atr: atr(candles, 14),
    session: sessionOf(now),
  };

  // The chart read on the same tape — see confluence.js. When chart
  // confirmation is enabled it gates a buy; it remains visible separately so
  // agreement and refusals can be measured. Settled lazily, here, the same way /picks edge settles
  // recorder.js's quotes: only when somebody is actually looking, rather than
  // adding a write to the collector loop that runs whether or not anyone is.
  const confluence = confluenceRead({ prices, whales });
  const settledConfluence = settleConfluenceRecords(store.confluenceLog?.(asset) ?? [], {
    now,
    samples: store.listSamples(asset),
  });
  if (settledConfluence.settled > 0 && store.putConfluenceLog) {
    store.putConfluenceLog(asset, settledConfluence.log, { flush: true });
  }
  const confluenceMeasured = confluencePatterns(settledConfluence.log);

  // Pattern Sonar's own track record — see patternLog.js. Settled lazily
  // here too, same reasoning as confluence: only when someone is actually
  // looking, rather than adding a write to the collector loop that runs
  // whether or not anyone is.
  const settledPatterns = settlePatternRecords(store.patternLog?.(asset) ?? [], {
    now,
    samples: store.listSamples(asset),
  });
  if (settledPatterns.settled > 0 && store.putPatternLog) {
    store.putPatternLog(asset, settledPatterns.log, { flush: true });
  }
  const patternTrackRecord = patternWinRates(settledPatterns.log);

  // The raw material for a future "rounds like this one" search — see
  // roundSnapshot.js. Only a status line here; nothing matches against it
  // yet, because there is not enough real settled history for a match to
  // mean anything.
  const settledRounds = settleRoundSnapshots(store.roundSnapshots?.(asset) ?? [], {
    now,
    samples: store.listSamples(asset),
  });
  if (settledRounds.settled > 0 && store.putRoundSnapshots) {
    store.putRoundSnapshots(asset, settledRounds.log, { flush: true });
  }
  const roundHistory = roundHistorySummary(settledRounds.log);

  // The model's own track record — the exact same measurement /picks edge
  // reports in Discord, read from the same recorded quotes, so the number on
  // this page can never disagree with the one people already trust. Settled
  // lazily here too, same reasoning as confluence above.
  const settledQuotes = settleObservations(store.listQuotes?.(asset) ?? [], {
    now,
    samples: store.listSamples(asset),
  });
  if (settledQuotes.settled > 0 && store.putQuotes) store.putQuotes(asset, settledQuotes.log, { flush: true });
  const trackRecord = measureEdge(settledQuotes.log);

  // The model's own uncertainty, drawn as a range rather than left as a
  // single number: `sigma` is already scaled to the time left, so ±1σ in log
  // space is the band spot is expected to land inside of by the close, at
  // roughly a two-thirds chance. Not a prediction of where it WILL be — a
  // width. A market inside a wide band is a coin flip whatever the model
  // says; a strike outside a narrow one is closer to a sure thing.
  const expectedRange =
    Number.isFinite(sigma) && Number.isFinite(secondsLeft) && secondsLeft > 0
      ? {
          low: quote.price * Math.exp(-sigma),
          high: quote.price * Math.exp(sigma),
          at: now + secondsLeft * 1000,
        }
      : null;

  // The live bot's own position wins if it has one — real money, the
  // authoritative source. Otherwise fall back to whatever was entered by
  // hand on the dashboard itself.
  const held = store.riskState?.()?.position ?? store.dashboardPosition?.() ?? null;
  const position = positionAction(held, board, { now, spot: quote.price, prices });

  const record = tradeRecord(store.listTradeOrders?.() ?? []);
  const paperAccounts = store.paperAccounts?.() ?? {};
  const paperMarks = {};
  for (const [profile, account] of Object.entries(paperAccounts)) {
    if (!account?.position) continue;
    paperMarks[profile] = (board?.contracts ?? []).find(
      (candidate) => candidate?.market?.ticker === account.position.ticker,
    )?.price ?? null;
  }
  const paperTrading = paperSummary(paperAccounts, paperMarks);

  // Read-only. Whether real money is armed is decided in Discord — see
  // riskLimits.js's own docstring on why arming is deliberately not
  // something any API surface, this one included, can do.
  const liveTrading = riskSummary(store.riskState?.() ?? null, store.listTradeOrders?.() ?? [], { now });

  // Today's own orders, newest first — the aggregate stats above answer "how
  // is the day going", not "which trade was that $2 loss". Without this the
  // only way to answer that question was asking a person to dig through logs.
  liveTrading.recentOrders = (store.listTradeOrders?.() ?? [])
    .filter((order) => order?.status !== 'rejected' && dayKey(order?.at ?? 0) === dayKey(now))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, 12)
    .map((order) => ({
      at: order.at,
      side: order.side,
      contracts: order.contracts,
      limitCents: order.limitCents,
      costDollars: order.costDollars,
      profitDollars: Number.isFinite(order.profitDollars) ? order.profitDollars : null,
      forced: Boolean(order.forced),
      status: order.status,
    }));

  return {
    ok: true,
    position,
    record,
    paperTrading,
    indicators,
    asset,
    ticker: market.ticker ?? null,
    strike,
    spot: quote.price,
    priceSource: quote.source ?? contract.priceSource ?? null,
    secondsLeft,
    action: read.action,
    call: read.call,
    leaning: read.leaning ?? null,
    stayOut: read.stayOut,
    waitingFor: read.tradeable
      ? null
      : read.triggers
        ? {
            type: 'price',
            upAtCents: read.triggers.upAt,
            downAtCents: read.triggers.downAt,
            downAtYesPriceCents: read.triggers.downAtYesPrice,
          }
        : { type: 'filter', filter: read.blockedBy ?? read.result?.reason ?? null },
    tradeable: read.tradeable,
    confidence: read.confidence,
    likelihood: read.likelihood,
    winProbability: read.winProbability,
    marketWinProbability: read.marketWinProbability,
    valueCents: read.valueCents,
    entryCents: read.entryCents ?? null,
    reason: read.tradeable ? null : (read.result?.explain ?? read.reason),
    flipProbability: flip,
    whales: whales && whales.count > 0 ? { ...whales, line: whaleLine(whales) } : null,
    orderFlow,
    patterns,
    patternTrackRecord,
    levels,
    fairValueGaps,
    keyZones,
    roundHistory,
    candles,
    rsiSeries: rsiOverTime,
    volume,
    expectedRange,
    confluence,
    confluenceMeasured,
    liveTrading,
    trackRecord,
    at: now,
  };
}
