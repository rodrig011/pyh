import { bollingerWidth, emaStack, macd, momentum, rsi, trendFit } from './indicators.js';

/**
 * A second, independent read on the same tape.
 *
 * `evaluate()` in engine.js answers one question: is this specific contract
 * mispriced against a probability model. This answers a different one — does
 * everything ELSE about how price has been moving agree on a direction —
 * trend alignment, momentum, oscillator extremes, whale flow. It is not a
 * second vote to average into the first. Kept completely separate so the two
 * can be checked against each other and, over time, MEASURED against each
 * other by confluenceLog.js — which one is actually worth listening to is an
 * empirical question, not something either file gets to assert about itself.
 *
 * Nothing here trades. This is context, the same as the RSI and momentum
 * numbers already on the dashboard — just combined into one lean instead of
 * left as four separate numbers nobody has time to weigh by eye while a
 * fifteen-minute clock runs.
 */

const SQUEEZE_WIDTH_PERCENT = 0.5;

export function confluenceRead({ prices, whales = null } = {}) {
  const reasons = [];
  let score = 0;

  const stack = emaStack(prices);
  if (stack.alignment === 'bullish') {
    score += 1;
    reasons.push('EMA9 > EMA21 > EMA50');
  } else if (stack.alignment === 'bearish') {
    score -= 1;
    reasons.push('EMA9 < EMA21 < EMA50');
  }

  const macdRead = macd(prices);
  if (macdRead) {
    if (macdRead.histogram > 0) {
      score += 1;
      reasons.push('MACD histogram positive');
    } else if (macdRead.histogram < 0) {
      score -= 1;
      reasons.push('MACD histogram negative');
    }
  }

  const rsiValue = rsi(prices);
  if (Number.isFinite(rsiValue)) {
    // Extremes read as a REVERSAL signal, not a continuation — the classic
    // oscillator reading, and deliberately the opposite sign from momentum
    // below when both fire at once, which is itself informative: it means
    // a fast move just ran into a level it usually turns back from.
    if (rsiValue >= 70) {
      score -= 1;
      reasons.push(`RSI ${Math.round(rsiValue)} — overbought`);
    } else if (rsiValue <= 30) {
      score += 1;
      reasons.push(`RSI ${Math.round(rsiValue)} — oversold`);
    }
  }

  const trend = trendFit((prices ?? []).slice(-20));
  if (trend && trend.r2 > 0.5) {
    if (trend.slope > 0) {
      score += 1;
      reasons.push(`trending up (R²=${trend.r2.toFixed(2)})`);
    } else if (trend.slope < 0) {
      score -= 1;
      reasons.push(`trending down (R²=${trend.r2.toFixed(2)})`);
    }
  }

  const mom = momentum((prices ?? []).slice(-20));
  if (Number.isFinite(mom) && Math.abs(mom) >= 0.05) {
    if (mom > 0) {
      score += 1;
      reasons.push(`momentum +${mom.toFixed(2)}%`);
    } else {
      score -= 1;
      reasons.push(`momentum ${mom.toFixed(2)}%`);
    }
  }

  if (whales && whales.count > 0) {
    if (whales.lean >= 0.4) {
      score += 1;
      reasons.push(`whale flow leaning UP (${whales.count} print(s))`);
    } else if (whales.lean <= -0.4) {
      score -= 1;
      reasons.push(`whale flow leaning DOWN (${whales.count} print(s))`);
    }
  }

  const bands = bollingerWidth(prices);
  const squeeze = bands !== null && bands.widthPercent < SQUEEZE_WIDTH_PERCENT;
  if (squeeze) reasons.push('Bollinger squeeze — quiet before a move, direction unknown');

  // Six inputs, each worth one vote. Two-plus net votes before this claims a
  // lean at all — one input disagreeing with everything else is noise, not
  // a minority report worth acting on.
  const lean = !squeeze && score >= 2 ? 'up' : !squeeze && score <= -2 ? 'down' : null;

  return {
    lean,
    score,
    reasons,
    squeeze,
    indicators: {
      emaStack: stack.alignment,
      macdHistogram: macdRead?.histogram ?? null,
      rsi: rsiValue,
      trendR2: trend?.r2 ?? null,
      momentum: mom,
      bollingerWidthPercent: bands?.widthPercent ?? null,
      whaleLean: whales?.lean ?? null,
    },
  };
}
