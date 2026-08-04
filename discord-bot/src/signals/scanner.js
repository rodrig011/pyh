import { VERDICTS, evaluate } from './engine.js';
import { recommendSize } from './sizing.js';

/**
 * Scanning every market at once, which is where the growth rate actually
 * comes from.
 *
 * The growth per bet is capped by the edge and the Kelly maths, and no amount
 * of wanting changes it. The number that is NOT capped is how many good bets a
 * day the engine can find. One asset's 15-minute series offers 96 markets a
 * day and perhaps a handful pass the filters; four assets offer nearly four
 * hundred. Same edge, same sizing, several times the compounding — that is the
 * honest version of "make it grow faster", and it is a scanner, not a bigger
 * bet.
 */

/**
 * Runs the engine over every asset's market and sizes the ones worth taking.
 *
 * Pure: every input is handed in, so a scan can be replayed from snapshots and
 * the record of what was called can always be rebuilt.
 */
export function planScan(inputs, options = {}) {
  const {
    kellyFraction = 0.25,
    maximumFraction = 0.1,
    // The most of the bankroll allowed at risk across every simultaneous
    // signal. Crypto moves together: three same-direction crypto bets in the
    // same quarter hour are closer to one big bet than three small ones, and
    // sizing them as independent is how a single bad candle takes a triple
    // loss. The cap is what makes "scan more markets" safe to do.
    maximumTotalFraction = 0.15,
    engine = {},
  } = options;

  const calls = [];
  const skips = [];

  for (const input of inputs ?? []) {
    const result = evaluate(input, engine);
    const entry = { asset: input.asset ?? 'BTC', ticker: input.ticker ?? null, result };

    if (result.verdict === VERDICTS.SKIP) {
      skips.push(entry);
      continue;
    }

    const sizing = recommendSize({
      probability: result.probability,
      worstProbability: result.probabilityRange?.[0],
      priceDollars: result.entryCents / 100,
      kellyFraction,
      maximumFraction,
    });

    calls.push({ ...entry, sizing });
  }

  // Best edge first, because if the cap forces a choice, the strongest claim
  // should be the one that keeps its full size.
  calls.sort((a, b) => (b.result.expected?.net ?? 0) - (a.result.expected?.net ?? 0));

  // Scale the whole book down, never pick-and-drop: every call here already
  // beat the filters, and a proportional trim keeps the relative sizing that
  // the edges justify.
  const total = calls.reduce((sum, call) => sum + (call.sizing?.suggested ?? 0), 0);
  const scale = total > maximumTotalFraction ? maximumTotalFraction / total : 1;

  for (const call of calls) {
    if (!call.sizing) continue;
    call.sizing = {
      ...call.sizing,
      suggested: call.sizing.suggested * scale,
      scaledBy: scale,
    };
  }

  return {
    calls,
    skips,
    totalFraction: Math.min(total, maximumTotalFraction),
    scale,
    scanned: (inputs ?? []).length,
  };
}

/**
 * Which series to scan. "BTC:KXBTC15M,ETH:KXETH15M" -> a market list.
 *
 * Config rather than hardcoded, because only the exchange knows which series
 * exist this month — the BNB one was discovered in the analyst's own fills.
 */
export function parseMarkets(spec, fallbackAsset = 'BTC', fallbackSeries = null) {
  const entries = String(spec ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [asset, series] = part.split(':').map((piece) => piece.trim());
      return asset && series ? { asset: asset.toUpperCase(), series } : null;
    })
    .filter(Boolean);

  if (entries.length > 0) return entries;
  return fallbackSeries ? [{ asset: fallbackAsset, series: fallbackSeries }] : [];
}
