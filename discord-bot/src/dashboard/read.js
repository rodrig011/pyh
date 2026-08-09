import { closeTimeOf, nearestTheMoneyContract } from '../picks/kalshi.js';
import { directionalRead } from '../signals/direction.js';
import { flipProbability } from '../signals/exit.js';
import { whaleActivity, whaleLine } from '../picks/whales.js';
import { scalpDecision, SCALP_ACTIONS } from '../signals/scalp.js';
import { PROFILES } from '../picks/paper.js';
import { buildCandles } from './candles.js';

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

/**
 * Records "I'm in" from a dashboard button press — reads the board fresh, at
 * the moment of the click, rather than trusting whatever was on screen from
 * the last poll a few seconds ago.
 */
export async function enterManualPosition(store, config, side, { openBoard, fetchSpotPrice, now = Date.now() }) {
  const settings = config.picks ?? {};
  const kalshi = settings.kalshi ?? {};
  const asset = settings.defaultAsset ?? 'BTC';

  const [board, quote] = await Promise.all([
    openBoard(kalshi, { now }).catch(() => null),
    fetchSpotPrice(asset),
  ]);

  const contract = nearestTheMoneyContract(board?.contracts);
  if (!contract) return { ok: false, reason: 'No readable market right now' };

  const market = contract.market ?? {};
  const strike = Number.isFinite(Number(market.floor_strike))
    ? Number(market.floor_strike)
    : Number(market.cap_strike);

  const prices = store
    .listSamples(asset)
    .filter((sample) => sample?.at >= now - 60 * 60 * 1000 && sample?.price > 0)
    .map((sample) => sample.price);
  const secondsLeft = Number.isFinite(closeTimeOf(market)) ? (closeTimeOf(market) - now) / 1000 : null;

  const read = directionalRead({
    prices,
    spot: quote?.price ?? null,
    strike,
    marketPriceCents: contract.price,
    market,
    secondsLeft,
  });

  const entry = manualEntry(side, { ticker: market.ticker, strike, quotes: read.result?.quotes, now });
  if (!entry) return { ok: false, reason: 'Could not price that side right now' };

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
  if (!(quote?.price > 0)) return { ok: false, reason: `No live ${asset} price right now` };

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
  if (fetchTrades && market.ticker) {
    const { trades } = await fetchTrades(kalshi, market.ticker).catch(() => ({ trades: [] }));
    whales = whaleActivity(trades);
  }

  const candles = buildCandles(
    store.listSamples(asset).filter((sample) => sample?.at >= now - 60 * 60 * 1000),
    { bucketMs: 60_000, limit: 60 },
  );

  // The live bot's own position wins if it has one — real money, the
  // authoritative source. Otherwise fall back to whatever was entered by
  // hand on the dashboard itself.
  const held = store.riskState?.()?.position ?? store.dashboardPosition?.() ?? null;
  const position = positionAction(held, board, { now, spot: quote.price, prices });

  const record = tradeRecord(store.listTradeOrders?.() ?? []);

  return {
    ok: true,
    position,
    record,
    asset,
    ticker: market.ticker ?? null,
    strike,
    spot: quote.price,
    secondsLeft,
    call: read.call,
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
    candles,
    at: now,
  };
}
