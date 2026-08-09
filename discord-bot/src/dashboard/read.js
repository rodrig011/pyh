import { closeTimeOf, nearestTheMoneyContract } from '../picks/kalshi.js';
import { directionalRead } from '../signals/direction.js';

/**
 * The same read the panel and the paper account trade on, packaged for
 * something that is not Discord. No new modelling here — this calls the
 * exact function everything else calls, so the dashboard can never show a
 * call the trading path itself would disagree with.
 */
export async function computeRead(
  store,
  config,
  { openBoard, fetchSpotPrice, now = Date.now() },
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

  return {
    ok: true,
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
    at: now,
  };
}
