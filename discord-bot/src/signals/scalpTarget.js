import { normalCdf, probabilityAbove, feePerContract } from './math.js';

/**
 * Scalping a fixed percentage, and the arithmetic that decides whether it works.
 *
 * The request behind this file: "recommend buy UP or buy DOWN on every market,
 * and scalp ten percent." That is a genuinely DIFFERENT bet from everything
 * else here, and the difference is worth being precise about rather than
 * quietly conflating.
 *
 * Every other part of this engine asks: will this contract finish above the
 * strike? A ten-percent scalp asks something much easier: will the PRICE move
 * ten percent, at any point, before the bell? Buying at 40¢ and selling at 44¢
 * pays 10% and needs four cents of movement — which happens constantly, far
 * more often than the contract finishing in the money. So the honest win rate
 * on a scalp is high, and it is high for a real reason, not a sales reason.
 *
 * THE PART THAT MUST NOT BE HIDDEN, because it is the whole trade:
 *
 * A Kalshi contract's price IS its probability, and a probability is a
 * martingale — it has no drift by construction. Optional stopping then says
 * that no stopping rule on a martingale has positive expected value. Take
 * profit at +10%, hold the losers, do it a thousand times: the mean is exactly
 * zero before fees, and negative after them.
 *
 * What a 10% target changes is the SHAPE, not the mean. It converts one
 * even-money bet into a great many small wins and a few total losses. Roughly:
 * win 85% of the time for +10%, lose 15% of the time for most of the stake.
 * That feels like a machine that prints money for a week and then gives it all
 * back in an afternoon, and everyone who has run it has that story.
 *
 * So this file computes the real numbers — the touch probability from the
 * volatility, the break-even win rate after both fees, and the gap between them
 * — and says out loud which side of that gap a given market is on. A scalp on a
 * market where the model has NO edge is a coin flip with extra steps. A scalp
 * on one where it does is the same edge, taken sooner and with less variance.
 */

/**
 * The spot price at which this contract would be worth `targetCents`.
 *
 * Inverts the pricing formula. `probabilityAbove` maps spot to a probability
 * through a normal CDF, so the target price implies a target spot, and from
 * there the question becomes a first-passage problem with a closed form.
 */
export function spotForPrice(targetCents, strike, sigma) {
  if (!(strike > 0) || !(sigma > 0)) return null;
  const p = targetCents / 100;
  if (!(p > 0) || !(p < 1)) return null;

  // d = (ln(S/K) − σ²/2) / σ, and p = Φ(d), so ln(S/K) = σ·Φ⁻¹(p) + σ²/2.
  const d = inverseNormalCdf(p);
  if (!Number.isFinite(d)) return null;
  return strike * Math.exp(sigma * d + (sigma * sigma) / 2);
}

/**
 * Φ⁻¹, by Acklam's rational approximation. Accurate to about 1e-9, which is
 * far finer than any volatility estimate feeding it.
 */
export function inverseNormalCdf(p) {
  if (!(p > 0) || !(p < 1)) return null;

  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];

  const low = 0.02425;
  const high = 1 - low;

  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > high) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }

  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/**
 * The chance the spot TOUCHES a level before the bell, not the chance it
 * finishes there.
 *
 * Reflection principle for driftless Brownian motion: the probability of ever
 * reaching a level is exactly twice the probability of finishing beyond it.
 * That factor of two is the single most useful fact in this whole file, and it
 * is why a scalp target is hit so much more often than people expect.
 */
export function touchProbability(spot, level, sigma) {
  if (!(spot > 0) || !(level > 0)) return null;
  if (!(sigma > 0)) return spot === level ? 1 : 0;

  const distance = Math.abs(Math.log(level / spot));
  // 2·Φ(−|m|/σ), capped: the reflection identity is exact for the running
  // maximum, and 1 is the most a probability can be.
  return Math.min(1, 2 * normalCdf(-distance / sigma));
}

/**
 * The win rate a fixed-target scalp has to beat just to break even.
 *
 * Wins pay the target percentage on the stake. Losses, on a binary held to the
 * bell, usually cost the whole stake. So a +10% target needs a startlingly high
 * hit rate — which is exactly what makes the strategy feel safe and be not.
 */
export function breakEvenWinRate(entryCents, targetPercent, { feeRate = 0.07 } = {}) {
  if (!(entryCents > 0) || !(targetPercent > 0)) return null;

  const entry = entryCents / 100;
  const exit = Math.min(0.99, entry * (1 + targetPercent / 100));
  const fees = feePerContract(entry, feeRate) + feePerContract(exit, feeRate);

  const win = exit - entry - fees;
  // The loss assumed: it goes to nothing, which is what a binary does when the
  // scalp fails and it is held to the bell.
  const loss = entry;
  if (!(win > 0)) return 1;

  // w·win = (1−w)·loss  →  w = loss / (win + loss)
  return loss / (win + loss);
}

/**
 * A scalp plan for one market: which side, what target, and the honest odds.
 *
 * `edge` is the model's edge in cents on the side being taken, and it is the
 * ONLY thing here that can make the plan positive-expectancy. Everything else
 * describes the shape of the bet.
 */
export function scalpPlan({
  side,
  entryCents,
  spot,
  strike,
  sigma,
  targetPercent = 10,
  edgeCents = 0,
  feeRate = 0.07,
} = {}) {
  if (!(entryCents > 0) || !(entryCents < 100)) return null;

  const targetCents = Math.min(99, entryCents * (1 + targetPercent / 100));
  const breakEven = breakEvenWinRate(entryCents, targetPercent, { feeRate });

  // Where the contract has to trade for the target to be hit, expressed as a
  // spot level, then as a first-passage probability.
  //
  // A DOWN position is the NO side, whose price rises as the YES price falls,
  // so its target is the YES price coming DOWN to 100 − target.
  const yesTargetCents = side === 'down' ? 100 - targetCents : targetCents;
  const targetSpot = spotForPrice(yesTargetCents, strike, sigma);
  const touch = targetSpot === null ? null : touchProbability(spot, targetSpot, sigma);

  // Expected value per contract, in cents, on the stated assumptions: hit the
  // target and take it, or miss and hold to a total loss.
  const entry = entryCents / 100;
  const exit = targetCents / 100;
  const fees = feePerContract(entry, feeRate) + feePerContract(exit, feeRate);
  const expectedCents =
    touch === null ? null : (touch * (exit - entry - fees) - (1 - touch) * entry) * 100;

  return {
    side,
    entryCents,
    targetCents,
    targetPercent,
    targetSpot,
    // The chance the target is reached at any point before the bell. Roughly
    // twice the chance of finishing there, which is the number that surprises
    // everybody.
    touchProbability: touch,
    breakEvenWinRate: breakEven,
    // Positive only when the touch odds beat what the fees demand. On a fairly
    // priced market this sits at or just below zero, by construction.
    expectedCents,
    edgeCents,
    // The honest verdict, in one word.
    verdict:
      touch === null || breakEven === null
        ? 'unknown'
        : touch >= breakEven && edgeCents > 0
          ? 'worth taking'
          : touch >= breakEven
            ? 'coin flip'
            : 'against you',
  };
}

/**
 * Which side a fixed-percentage scalp costs least on — and it is not the cheap
 * one, which is the opposite of what everybody assumes.
 *
 * Kalshi's fee is 0.07·P·(1−P) per contract, so as a fraction of the stake it
 * is 0.07·(1−P). That falls as the contract gets MORE expensive:
 *
 *     15¢ contract → round trip costs 13.3% of the stake
 *     40¢ contract → 10.0%
 *     80¢ contract →  3.8%
 *
 * So a ten percent target on a 15¢ lottery ticket is under water before the
 * price moves at all, and the same target on an 80¢ contract clears the fee
 * nearly three times over. The instinct to scalp the cheap side — more room to
 * run, bigger percentage moves — is exactly backwards once the exchange is paid.
 */
export function cheapestToScalp(quotes, { feeRate = 0.07 } = {}) {
  if (!quotes) return null;
  const cost = (entryCents) => {
    const p = entryCents / 100;
    return p > 0 && p < 1 ? feeRate * (1 - p) : Infinity;
  };
  return cost(quotes.yesAskCents) <= cost(quotes.noAskCents) ? 'up' : 'down';
}

/** Round-trip fee as a fraction of the stake, which is the number that decides. */
export function feeShareOfStake(entryCents, { feeRate = 0.07 } = {}) {
  if (!(entryCents > 0) || !(entryCents < 100)) return null;
  const entry = entryCents / 100;
  const exit = Math.min(0.99, entry * 1.1);
  return (feePerContract(entry, feeRate) + feePerContract(exit, feeRate)) / entry;
}
