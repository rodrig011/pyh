import { expectedValue, normalCdf, probabilityAbove } from './math.js';
import { discreteBarrier } from './volatility.js';

/**
 * Flips, and when to take the money.
 *
 * A binary that is winning right now is not a won bet. Price only has to touch
 * the strike once before the bell for the position to be on the wrong side, and
 * on a fifteen-minute market that happens far more often than the current
 * price suggests. This is the number that tells a room to take profit instead
 * of holding a 70¢ contract into a coin flip — and no chart shows it.
 */

/**
 * The chance price touches the strike at least once before expiry.
 *
 * Reflection principle for a driftless random walk: the probability of ever
 * reaching a barrier is exactly twice the probability of finishing beyond it.
 * That factor of two is the whole point — a position sitting one sigma clear
 * finishes safe 84% of the time but is touched 32% of the time on the way,
 * and those two numbers lead to opposite decisions.
 */
export function flipProbability(spot, strike, sigma, { sigmaPerSample = null } = {}) {
  if (!(spot > 0) || !(strike > 0)) return null;
  if (!(sigma > 0)) return spot === strike ? 1 : 0;

  // The formula below assumes the price is watched continuously. It is not —
  // a print arrives every thirty seconds, and a touch between two prints still
  // happened. Broadie–Glasserman–Kou: pull the barrier toward the price by
  // exp(β·σ√Δt). Skipping it understates flip odds, which is the direction
  // that costs money — it tells a room to hold what it should have banked.
  const barrier =
    sigmaPerSample > 0
      ? discreteBarrier(strike, sigmaPerSample, { above: spot > strike })
      : strike;

  // Distance to the barrier in log space, and the drift the same log space
  // carries when price itself is a martingale: −σ²/2 over the horizon. The
  // textbook shortcut is 2·Φ(−a/σ), which drops that term; over fifteen
  // minutes the difference is small, and it is still the difference between a
  // number that is right and one that is nearly right.
  const a = Math.abs(Math.log(spot / barrier));
  const drift = -(sigma * sigma) / 2;

  const first = normalCdf((-a + drift) / sigma);
  const second = Math.exp((2 * drift * a) / (sigma * sigma)) * normalCdf((-a - drift) / sigma);

  return Math.max(0, Math.min(1, first + second));
}

/**
 * The chance it flips and stays flipped — touched and finished on the other
 * side. Always the smaller number, and the one that actually costs money: a
 * touch that comes back is a scare, a flip that holds is a loss.
 */
export function flipAndStayProbability(spot, strike, sigma, { above = null } = {}) {
  const winning = above ?? spot > strike;
  const finishAbove = probabilityAbove(spot, strike, sigma);
  if (finishAbove === null) return null;
  return winning ? 1 - finishAbove : finishAbove;
}

export const EXIT_ACTIONS = { HOLD: 'hold', CASH_OUT: 'cash_out', CUT_LOSS: 'cut_loss' };

export const EXIT_REASONS = {
  edge_gone: 'The market has caught up. There is no edge left to hold for.',
  flip_risk: 'Still winning, but the odds of it flipping before the bell are too high for what is left to gain.',
  target_hit: 'The move is banked. What remains is not worth the risk of giving it back.',
  thesis_broken: 'Price has crossed the strike. The reason for the position is gone.',
  no_time: 'Too close to the bell to react if it turns.',
  hold: 'The edge that opened this is still there.',
  hold_to_settle: 'Far enough clear, with little enough time, that holding to settlement beats paying the spread to leave.',
};

/**
 * Whether to stay in a position or take the money.
 *
 * The rule people use — "cash out at +20%" — is arbitrary and gives back the
 * trades that were about to pay most. The rule here is the one that follows
 * from the maths: hold only while the model still thinks the contract is
 * underpriced, and leave when what is left to win no longer covers the chance
 * of losing it.
 *
 * Pure, so a room can be shown exactly why it was told to get out.
 */
export function exitDecision(
  {
    entryCents,
    nowCents,
    spot,
    strike,
    sigma,
    secondsLeft,
    direction = 'up',
  },
  options = {},
) {
  const config = {
    // Below this, the remaining edge is not worth a spread to keep.
    minimumRemainingEdgeCents: 2,
    // Flip odds above this end a winning position regardless of the edge.
    maximumFlipRisk: 0.4,
    // Inside this, leaving costs more than it saves.
    settleWithinSeconds: 60,
    feeRate: 0.07,
    ...options,
  };

  const reasons = [];
  const up = direction === 'up';
  const finishesRight = probabilityAbove(spot, strike, sigma);
  const probability = finishesRight === null ? null : up ? finishesRight : 1 - finishesRight;
  const flip = flipProbability(spot, strike, sigma);
  const winning = up ? spot > strike : spot < strike;

  const move =
    Number.isFinite(entryCents) && entryCents > 0 && Number.isFinite(nowCents)
      ? ((nowCents - entryCents) / entryCents) * 100
      : null;

  const remaining =
    probability === null || !Number.isFinite(nowCents)
      ? null
      : expectedValue(probability, nowCents / 100, { feeRate: config.feeRate });

  const decide = (action, reason) => ({
    action,
    reason,
    explain: EXIT_REASONS[reason] ?? reason,
    ...report,
    reasons,
  });

  const report = {
    probability,
    flipProbability: flip,
    movePercent: move,
    remainingEdgeCents: remaining ? remaining.edge * 100 : null,
    // What is still on the table if it goes all the way, against what it costs
    // to keep it there.
    upsideCents: Number.isFinite(nowCents) ? 100 - nowCents : null,
    winning,
  };

  if (probability === null) return decide(EXIT_ACTIONS.HOLD, 'hold');

  // The position is simply wrong now. Nothing about profit-taking applies.
  if (!winning && probability < 0.35) return decide(EXIT_ACTIONS.CUT_LOSS, 'thesis_broken');

  // Close to the bell, moving costs a spread and gains nothing.
  if (secondsLeft <= config.settleWithinSeconds) {
    return decide(
      winning && probability > 0.8 ? EXIT_ACTIONS.HOLD : EXIT_ACTIONS.CASH_OUT,
      winning && probability > 0.8 ? 'hold_to_settle' : 'no_time',
    );
  }

  // Winning, but the walk still reaches the strike often enough to matter. The
  // comparison is against what is left to gain, not against a fixed number: a
  // 30% flip risk is fine with 40 cents of upside and reckless with four.
  if (winning && flip !== null && report.upsideCents !== null) {
    const worthRisking = report.upsideCents * (1 - flip);
    if (flip > config.maximumFlipRisk && worthRisking < report.upsideCents * 0.6) {
      reasons.push(`${Math.round(flip * 100)}% chance it touches the strike again before the bell`);
      return decide(EXIT_ACTIONS.CASH_OUT, 'flip_risk');
    }
  }

  // The market has repriced to where the model already is. Holding from here
  // is holding a fair bet and paying a fee for the privilege.
  if (remaining && remaining.edge * 100 < config.minimumRemainingEdgeCents) {
    if (move !== null && move > 0) {
      reasons.push(`Banked ${move.toFixed(1)}% — the rest is a coin flip`);
      return decide(EXIT_ACTIONS.CASH_OUT, 'target_hit');
    }
    return decide(EXIT_ACTIONS.CASH_OUT, 'edge_gone');
  }

  return decide(EXIT_ACTIONS.HOLD, 'hold');
}
