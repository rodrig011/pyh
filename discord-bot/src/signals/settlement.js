/**
 * Kalshi does not settle on the final price. It settles on the AVERAGE of the
 * final sixty seconds.
 *
 * Every crypto contract on the exchange resolves against a 60-second average of
 * the CME CF Real-Time Index, sampled once per second. The engine has been
 * pricing these as if they settle on the price at the bell, and those are
 * different instruments with different variances.
 *
 * The correction is derivable rather than fitted, which is why it is worth
 * more than any indicator. Writing S for the index and h for the averaging
 * window, the settlement value from time t with tau seconds left is
 *
 *     A = (1/h) * integral over the last h seconds of S
 *
 * Splitting that at the start of the window and using Var(time-average of a
 * Brownian path over h) = sigma^2 * h/3:
 *
 *     tau > h:   Var(A) = sigma^2 * (tau - h) + sigma^2 * h/3
 *                       = sigma^2 * (tau - 2h/3)
 *
 * So an average-settled contract behaves like a point-settled one with FORTY
 * SECONDS LESS on the clock. It is a small correction at the open and an
 * enormous one near the bell:
 *
 *     15 min left  ->  860s instead of 900s   (sigma 2% lower)
 *      5 min left  ->  260s instead of 300s   (sigma 7% lower)
 *      2 min left  ->   80s instead of 120s   (sigma 18% lower)
 *
 * Eighteen percent less volatility, one sigma away from the strike, is about
 * five cents of probability — the size of the engine's entire edge threshold,
 * and it was being given away in the wrong direction. The model thought the
 * price had more time to come back than it really did, so it called contracts
 * overpriced when they were fairly priced.
 *
 * Inside the window the correction changes character: part of the settlement
 * value has already been printed and cannot move any more.
 */

/** The averaging window Kalshi settles crypto contracts on. */
export const SETTLEMENT_WINDOW_SECONDS = 60;

/**
 * The point-settled horizon that has the same variance as this average-settled
 * contract. Feed this to the volatility scaling instead of the raw clock.
 *
 * Never negative and never zero while the contract is live: some uncertainty
 * remains right up until the last print.
 */
export function effectiveSecondsLeft(secondsLeft, windowSeconds = SETTLEMENT_WINDOW_SECONDS) {
  if (!(secondsLeft > 0)) return 0;
  const h = windowSeconds > 0 ? windowSeconds : SETTLEMENT_WINDOW_SECONDS;

  // Still outside the window: the whole average is in the future.
  if (secondsLeft > h) return secondsLeft - (2 * h) / 3;

  // Inside it. Only the part of the window still to be printed can move, and
  // its influence on the average is diluted by the seconds already banked —
  // hence the cube. At tau = h this agrees with the branch above (h/3), which
  // is the check the tests make.
  return (secondsLeft * secondsLeft * secondsLeft) / (3 * h * h);
}

/**
 * The reference price the contract is really being measured against.
 *
 * Outside the window this is just the spot: nothing has been banked yet. Inside
 * it, the settlement average is part history and part future, so the honest
 * reference is a blend — and a price that spiked in the last twenty seconds
 * settles lower than it currently trades, because forty seconds of the average
 * were printed before the spike.
 *
 * `windowAverageSoFar` is the average of the index over the part of the window
 * already elapsed. With no such reading available it falls back to spot, which
 * is the old behaviour and is flagged as an estimate rather than pretended to
 * be exact.
 */
export function settlementReference(
  spot,
  secondsLeft,
  { windowAverageSoFar = null, windowSeconds = SETTLEMENT_WINDOW_SECONDS } = {},
) {
  if (!(spot > 0)) return null;
  const h = windowSeconds > 0 ? windowSeconds : SETTLEMENT_WINDOW_SECONDS;

  if (!(secondsLeft > 0)) return { price: spot, banked: 1, exact: false };
  if (secondsLeft >= h) return { price: spot, banked: 0, exact: true };

  const elapsed = h - secondsLeft;
  const banked = elapsed / h;

  if (!(windowAverageSoFar > 0)) {
    return { price: spot, banked, exact: false };
  }

  return {
    price: (windowAverageSoFar * elapsed + spot * secondsLeft) / h,
    banked,
    exact: true,
  };
}

/**
 * How many cents the averaging is worth on a given read.
 *
 * Published rather than folded in silently, because it is the one number in
 * this engine that comes from reading the contract's rules rather than from
 * modelling the market — and it is largest exactly where the engine trades.
 */
export function averagingEdgeCents(probabilityWithout, probabilityWith) {
  if (!Number.isFinite(probabilityWithout) || !Number.isFinite(probabilityWith)) return null;
  return (probabilityWith - probabilityWithout) * 100;
}
