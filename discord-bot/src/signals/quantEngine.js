import { executablePrices, netEdgeCents } from './cost.js';
import { trendFit } from './indicators.js';
import { logReturns, probabilityAbove, scaleVolatility } from './math.js';
import { effectiveSecondsLeft } from './settlement.js';
import { volatilityEstimate } from './volatility.js';

export const QUANT_STATUS = {
  OK: 'ok',
  INSUFFICIENT: 'insufficient_data',
};

export const CONFIDENCE_GRADES = {
  A: 'A',
  B: 'B',
  C: 'C',
  D: 'D',
};

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const finite = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function logit(probability) {
  const p = clamp(probability, 1e-6, 1 - 1e-6);
  return Math.log(p / (1 - p));
}

function logistic(value) {
  return 1 / (1 + Math.exp(-value));
}

function signedUnit(value) {
  const number = finite(value);
  return number === null ? null : clamp(number, -1, 1);
}

/**
 * Trade-tape delta. This is CVD, not OFI: OFI requires successive order-book
 * snapshots and must remain missing when all we have is prints.
 */
export function cumulativeVolumeDelta(trades) {
  let yes = 0;
  let no = 0;
  for (const trade of trades ?? []) {
    const size = finite(trade?.count ?? trade?.size ?? trade?.amount);
    if (!(size > 0)) continue;
    const side = trade?.taker_side ?? trade?.side;
    if (side === 'yes' || side === 'buy') yes += size;
    else if (side === 'no' || side === 'sell') no += size;
  }
  const total = yes + no;
  return total > 0 ? (yes - no) / total : null;
}

/** Only real quoted size can produce a book imbalance. Prices alone cannot. */
export function bookImbalance(market) {
  const bid = finite(
    market?.yes_bid_size ?? market?.yes_bid_size_fp ?? market?.bid_size ?? market?.bid_depth,
  );
  const ask = finite(
    market?.yes_ask_size ?? market?.yes_ask_size_fp ?? market?.ask_size ?? market?.ask_depth,
  );
  if (!(bid >= 0) || !(ask >= 0) || bid + ask === 0) return null;
  return (bid - ask) / (bid + ask);
}

export function liquidityScore(market, { fullScoreDollars = 1000 } = {}) {
  const dollars = finite(market?.liquidity_dollars ?? market?.liquidity);
  if (!(dollars >= 0)) return null;
  return clamp(Math.log1p(dollars) / Math.log1p(fullScoreDollars), 0, 1);
}

export function expandingVolatility(returns, { threshold = 1.25 } = {}) {
  const values = (returns ?? []).filter(Number.isFinite);
  if (values.length < 20) return null;
  const half = Math.floor(values.length / 2);
  const rms = (rows) => Math.sqrt(rows.reduce((sum, value) => sum + value ** 2, 0) / rows.length);
  const previous = rms(values.slice(0, half));
  const recent = rms(values.slice(half));
  if (!(previous > 0)) return recent > 0;
  return recent / previous >= threshold;
}

function confidenceGrade(score) {
  if (score >= 85) return CONFIDENCE_GRADES.A;
  if (score >= 70) return CONFIDENCE_GRADES.B;
  if (score >= 55) return CONFIDENCE_GRADES.C;
  return CONFIDENCE_GRADES.D;
}

function adjustedProbability(base, adjustment) {
  return logistic(logit(base) + adjustment);
}

/**
 * Pure, auditable settlement-probability engine.
 *
 * No text model, prompt, network call or discretionary direction exists here.
 * Distance/time/volatility establish the distribution. Genuine microstructure
 * may make a bounded log-odds adjustment; missing inputs lower confidence and
 * are never replaced with invented zeros.
 */
export function estimateSettlementProbability(input = {}, options = {}) {
  const {
    prices = [],
    spot = null,
    strike = null,
    secondsLeft = null,
    marketPriceCents = null,
    market = null,
    trades = [],
    microstructure = {},
    technicalOnly = false,
    historicallyCalibrated = false,
  } = input;
  const config = {
    sampleSeconds: 30,
    settlementAveraging: true,
    settlementWindowSeconds: 60,
    feeRate: 0.07,
    minimumLiquidityDollars: 25,
    ...options,
  };

  const missing = [];
  const current = finite(spot ?? prices.at(-1));
  const line = finite(strike);
  const clock = finite(secondsLeft);
  const marketProbability = finite(marketPriceCents) === null ? null : finite(marketPriceCents) / 100;
  if (!(current > 0)) missing.push('spot');
  if (!(line > 0)) missing.push('strike');
  if (!(clock > 0)) missing.push('time_remaining');
  if (!(marketProbability > 0 && marketProbability < 1)) missing.push('market_probability');

  const quotes = executablePrices(market, marketPriceCents);
  if (!quotes) missing.push('executable_quotes');

  const returns = logReturns(prices);
  const volatility = volatilityEstimate(returns);
  if (!volatility || !(volatility.sigma > 0)) missing.push('realized_volatility');

  if (missing.length > 0) {
    return {
      status: QUANT_STATUS.INSUFFICIENT,
      missing,
      fairPYes: null,
      fairPNo: null,
      edge: { yes: null, no: null },
      confidence: { score: 0, grade: CONFIDENCE_GRADES.D, penalties: ['missing critical data'] },
    };
  }

  const horizonSeconds = config.settlementAveraging
    ? effectiveSecondsLeft(clock, config.settlementWindowSeconds)
    : clock;
  const sigma = scaleVolatility(volatility.sigma, config.sampleSeconds, horizonSeconds);
  const sigmaLow = scaleVolatility(volatility.low, config.sampleSeconds, horizonSeconds);
  const sigmaHigh = scaleVolatility(volatility.high, config.sampleSeconds, horizonSeconds);
  if (!(sigma > 0)) {
    return {
      status: QUANT_STATUS.INSUFFICIENT,
      missing: ['realized_volatility'],
      fairPYes: null,
      fairPNo: null,
      edge: { yes: null, no: null },
      confidence: { score: 0, grade: CONFIDENCE_GRADES.D, penalties: ['missing critical data'] },
    };
  }

  const structuralPYes = probabilityAbove(current, line, sigma);
  const structuralRange = [
    probabilityAbove(current, line, sigmaHigh),
    probabilityAbove(current, line, sigmaLow),
  ].filter(Number.isFinite).sort((a, b) => a - b);

  const trend = trendFit(prices.slice(-20));
  const trendStrength = trend?.r2 ?? null;
  const trendDirection = trend?.slope > 0 ? 1 : trend?.slope < 0 ? -1 : 0;
  const ofi = signedUnit(microstructure.ofi);
  const cvd = signedUnit(microstructure.cvd ?? cumulativeVolumeDelta(trades));
  const depthImbalance = signedUnit(microstructure.bookImbalance ?? bookImbalance(market));
  const microValues = [ofi, cvd, depthImbalance].filter(Number.isFinite);
  const microScore = microValues.length
    ? microValues.reduce((sum, value) => sum + value, 0) / microValues.length
    : null;

  // The requested 40% microstructure / 5% technical split is represented as
  // bounded log-odds influence, not a second fake probability. Full agreement
  // can move a coin flip by about ten points; it cannot overwhelm a 3-sigma
  // distance-to-strike calculation without historical calibration.
  const microAdjustment = Number.isFinite(microScore) ? 0.4 * microScore : 0;
  // A price-derived trend is not independent evidence. It may refine genuine
  // order-flow evidence, but it cannot move fair value by itself.
  const trendAdjustment = Number.isFinite(microScore) && Number.isFinite(trendStrength)
    ? 0.05 * trendStrength * trendDirection
    : 0;
  const adjustment = microAdjustment + trendAdjustment;
  const fairPYes = adjustedProbability(structuralPYes, adjustment);
  const fairPNo = 1 - fairPYes;
  const probabilityRange = structuralRange.map((value) => adjustedProbability(value, adjustment));

  const liquidity = liquidityScore(market);
  const liquidityDollars = finite(market?.liquidity_dollars ?? market?.liquidity);
  const thinBook = liquidityDollars !== null && liquidityDollars < config.minimumLiquidityDollars;
  const volExpanding = expandingVolatility(returns);

  // Evidence coverage follows the requested weights. Liquidity affects
  // reliability/executability, never direction.
  let confidenceScore = 45; // 30 distance/time + 15 realized volatility
  confidenceScore += (microValues.length / 3) * 40;
  if (liquidity !== null) confidenceScore += 10;
  if (trendStrength !== null) confidenceScore += 5;

  const penalties = [];
  const caps = [];
  if (Number.isFinite(trendStrength) && trendStrength < 0.2) {
    confidenceScore = Math.min(confidenceScore, 70);
    caps.push('trend strength below 0.20 caps confidence at 70%');
  }
  if (ofi === null || depthImbalance === null) {
    confidenceScore = Math.min(confidenceScore, 80);
    caps.push('no real OFI or complete book caps confidence at 80%');
  }
  if (!historicallyCalibrated) {
    confidenceScore = Math.min(confidenceScore, 90);
    caps.push('no calibrated history caps confidence at 90%');
  }
  // Caps establish the highest defensible starting point. Penalties are then
  // real point deductions from that capped score, never swallowed by a later
  // cap (e.g. 90 -> technical-only -20 must be 70, not 80).
  if (thinBook) {
    confidenceScore -= 15;
    penalties.push('thin book: -15');
  }
  if (volExpanding === true) {
    confidenceScore -= 10;
    penalties.push('expanding volatility: -10');
  }
  if (technicalOnly) {
    confidenceScore -= 20;
    penalties.push('technical-only thesis: -20');
  }
  confidenceScore = clamp(confidenceScore, 0, 100);

  const yesEdge = netEdgeCents(fairPYes, 'up', quotes, { feeRate: config.feeRate });
  const noEdge = netEdgeCents(fairPNo, 'down', quotes, { feeRate: config.feeRate });

  return {
    status: QUANT_STATUS.OK,
    missing: [
      ...(ofi === null ? ['ofi'] : []),
      ...(cvd === null ? ['cvd'] : []),
      ...(depthImbalance === null ? ['book_imbalance'] : []),
    ],
    fairPYes,
    fairPNo,
    structuralPYes,
    marketProbability,
    probabilityRange,
    sigma,
    volatility,
    quotes,
    edge: { yes: yesEdge, no: noEdge },
    confidence: {
      score: confidenceScore,
      grade: confidenceGrade(confidenceScore),
      penalties,
      caps,
    },
    features: {
      distanceDollars: current - line,
      distancePercent: ((current - line) / line) * 100,
      distanceSigma: Math.log(current / line) / sigma,
      secondsLeft: clock,
      trendStrength,
      trendDirection,
      ofi,
      cvd,
      bookImbalance: depthImbalance,
      microScore,
      liquidityScore: liquidity,
      liquidityDollars,
      thinBook,
      volatilityExpanding: volExpanding,
    },
  };
}
