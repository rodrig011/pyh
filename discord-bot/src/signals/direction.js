import { VERDICTS, evaluate } from './engine.js';
import { minimumProfitableMoveCents } from './scalp.js';

/**
 * A directional read on every market, whether or not it is worth trading.
 *
 * The engine refuses about nine markets in ten, because it was built to answer
 * "should money be put on this?" — and the answer to that is almost always no,
 * once the spread and the fee are paid. That refusal is correct and it stays.
 *
 * But it was hiding something. The model has a probability for EVERY market.
 * Staying silent unless there were six cents of tradeable edge meant throwing
 * away a perfectly good opinion about which way the market is leaning, and
 * those are two different questions:
 *
 *   "Which way is this going?"        <- answerable almost always
 *   "Is there money in it after costs?" <- answerable almost never
 *
 * A read here is not a recommendation to trade. It is the model's honest lean,
 * published with the confidence it actually has and with whether the trade
 * clears costs stated separately and plainly. Anyone whose costs differ — a
 * bigger account, a different venue, a fee tier — can act on a read the engine
 * itself would decline, and they can see exactly why it declined.
 *
 * What is NOT allowed here: reporting how often the lean is right without
 * reporting what being wrong costs. A call at 88¢ is right seven times out of
 * eight and still loses money, and a product that shows the first number
 * without the second is lying with true statistics.
 */

export const CONFIDENCE = {
  STRONG: 'strong',
  LEAN: 'lean',
  COIN_FLIP: 'coin flip',
  NONE: 'none',
};

/**
 * How far from a coin flip the model actually is, named rather than numbered.
 *
 * The thresholds are deliberately unflattering. A 58% read on a binary market
 * is a genuine opinion and it is nowhere near a sure thing, so it is called a
 * lean and not a signal.
 */
export function confidenceOf(winProbability) {
  if (!Number.isFinite(winProbability)) return CONFIDENCE.NONE;
  const distance = Math.abs(winProbability - 0.5);
  if (distance >= 0.15) return CONFIDENCE.STRONG;
  if (distance >= 0.05) return CONFIDENCE.LEAN;
  return CONFIDENCE.COIN_FLIP;
}

/**
 * How likely the called side is to win, in words.
 *
 * Separate from confidence, and the separation is the fix for a message that
 * confused the room: it printed "UP — strong" on a call whose model
 * probability was 25%. Both statements were true and together they were
 * nonsense. The call WAS the right side to buy — up cost 24¢ and was worth 25 —
 * and it also loses three times out of four.
 *
 * Confidence measures how far the model is from a coin flip. Likelihood
 * measures whether the thing being bought usually happens. A cheap ticket that
 * is slightly underpriced is a good buy and a probable loss, and anyone acting
 * on one has to be told the second part in the same breath as the first.
 */
export function likelihoodOf(winProbability) {
  if (!Number.isFinite(winProbability)) return null;
  if (winProbability >= 0.75) return 'usually wins';
  if (winProbability >= 0.55) return 'wins more often than not';
  if (winProbability >= 0.45) return 'a coin flip';
  if (winProbability >= 0.25) return 'usually loses';
  return 'rarely wins';
}

/**
 * The price to aim to get out at, and the price that merely breaks even.
 *
 * "Go in now" is half a call. Without somewhere to go the position is held
 * until something forces the issue, which on a fifteen-minute contract means
 * held to settlement — a completely different bet from the one that was sized.
 *
 * `target` is what the model says the side is worth: the price it should reach
 * if the model is right. `minimumExit` is the far more important number, and
 * the one nobody publishes: below it the round trip loses money even though
 * the screen shows a gain, because the exchange is paid on the way in AND on
 * the way out.
 */
export function exitPlan(entryCents, winProbability, { feeRate = 0.07, marginCents = 0.5 } = {}) {
  if (!(entryCents > 0) || entryCents >= 100 || !Number.isFinite(winProbability)) return null;

  const target = winProbability * 100;
  const needed = minimumProfitableMoveCents(entryCents, { feeRate, marginCents });

  return {
    targetCents: target,
    minimumExitCents: needed === null ? null : entryCents + needed,
    // Whether the model's own target is even far enough to pay for the trip.
    // When it is not, there is no exit that works and the honest answer is not
    // to enter — which is a different reason from "no edge" and worth saying.
    targetClearsCosts: needed !== null && target >= entryCents + needed,
    neededMoveCents: needed,
  };
}

/**
 * The model's read on a market, always.
 *
 * Returns a direction whenever there is enough history to have one, plus the
 * separate and much rarer verdict on whether it is worth paying to act.
 */
export function directionalRead(input, options = {}) {
  const result = evaluate(input, options);

  // `probability` is the chance of finishing above the strike, and refusals
  // carry it too — that was fixed so a held position could be judged without a
  // fresh verdict, and it is what makes this file possible at all.
  const probability = result.probability;

  if (!Number.isFinite(probability)) {
    return {
      call: null,
      confidence: CONFIDENCE.NONE,
      // The genuine "I do not know": no history, no price, market already shut.
      reason: result.explain ?? result.reason ?? 'no read',
      tradeable: false,
      result,
    };
  }

  // Which way the market is more likely to go. Informative, and NOT a
  // recommendation — this is the distinction the whole file turns on.
  const leaning = probability >= 0.5 ? VERDICTS.UP : VERDICTS.DOWN;

  // Which side is worth owning AT THE PRICE IT COSTS. When the model says 60%
  // and the contract costs 88¢, the market probably does go up — and buying up
  // at 88 is still a bad purchase, because 88 is too much to pay for a 60%
  // chance. The cheap side is DOWN even though the likely side is UP.
  //
  // Confusing those two is the classic and expensive beginner error, and a
  // product that prints one arrow cannot help but commit it. Both are
  // published, and when they disagree that is said out loud.
  const quotes = result.quotes ?? null;
  const upCost = quotes?.yesAskCents ?? result.marketProbability * 100;
  const downCost = quotes?.noAskCents ?? 100 - result.marketProbability * 100;

  const upValue = Number.isFinite(upCost) ? probability * 100 - upCost : null;
  const downValue = Number.isFinite(downCost) ? (1 - probability) * 100 - downCost : null;

  // When neither side is underpriced there is no side worth buying, and
  // picking the marginally-less-bad one is noise dressed as a decision. In a
  // fairly priced market the honest call is simply the likely side, with no
  // claim of value attached.
  const anyValue = (upValue ?? -Infinity) > 0 || (downValue ?? -Infinity) > 0;
  const call =
    upValue === null || downValue === null || !anyValue
      ? leaning
      : upValue >= downValue
        ? VERDICTS.UP
        : VERDICTS.DOWN;

  const winProbability = call === VERDICTS.UP ? probability : 1 - probability;
  const entryCents = call === VERDICTS.UP ? upCost : downCost;

  // What the market itself charges for the same side, so the two opinions can
  // be compared without arithmetic. Not always available on a refusal.
  const marketProbability = result.marketProbability;
  const marketWinProbability = Number.isFinite(marketProbability)
    ? call === VERDICTS.UP
      ? marketProbability
      : 1 - marketProbability
    : null;

  // A read is not a trade. This is the engine's own verdict, kept separate so
  // nothing downstream can mistake a lean for a recommendation.
  const tradeable = result.verdict !== VERDICTS.SKIP;

  return {
    // The side worth owning at what it costs. This is the actionable one.
    call,
    // The side more likely to happen. Informative only.
    leaning,
    // The moment worth teaching: the likely side and the cheap side are not
    // the same, and paying up for the likely one is how a high win rate
    // becomes a losing account. Only ever true when the cheap side is
    // genuinely cheap — a fairly priced market has no cheap side, and saying
    // otherwise would be inventing a disagreement out of rounding.
    disagrees: anyValue && call !== leaning,
    winProbability,
    // The raw edge on the called side before any threshold, in cents. Positive
    // means the model thinks it is underpriced; it may still be far too small
    // to pay for the spread and the fee, which is what `tradeable` reports.
    valueCents: call === VERDICTS.UP ? upValue : downValue,
    confidence: confidenceOf(winProbability),
    // Said alongside the confidence, always. "Strong" on a 25% call was true
    // and useless without this.
    likelihood: likelihoodOf(winProbability),
    // Where to aim to get out, and the price below which getting out loses
    // money however green the screen looks.
    exit: exitPlan(entryCents, winProbability),
    marketWinProbability,
    // How far the model is from the market on this side, in cents. Positive
    // means the model likes it more than the price does. This is an opinion
    // about value, NOT a claim that it clears costs.
    disagreementCents:
      marketWinProbability === null ? null : (winProbability - marketWinProbability) * 100,
    // Kept separate on purpose. A read is not a trade.
    tradeable,
    whyNotTradeable: tradeable ? null : (result.explain ?? result.reason ?? null),
    entryCents: Number.isFinite(entryCents) ? entryCents : null,
    netEdgeCents: result.cost?.netCents ?? null,
    secondsLeft: result.secondsLeft ?? input?.secondsLeft ?? null,
    result,
  };
}

/**
 * The record of directional reads, scored the only way that is not misleading.
 *
 * Every product in this space reports a hit rate. A hit rate on its own is
 * meaningless and reliably flattering: call everything that trades at 85¢ and
 * you will be right 85% of the time while losing money, because the one loss
 * costs almost six times what each win pays.
 *
 * So this reports four things together and they travel as a set:
 *
 *   - how often the lean was right
 *   - what it would have paid, per contract, after fees
 *   - how well the stated confidence matched reality
 *   - how many of the reads were actually tradeable
 *
 * The second number is the one that decides whether the first one means
 * anything.
 */
export function readRecord(reads) {
  const graded = (reads ?? []).filter(
    (read) => read?.call && (read.outcome === 0 || read.outcome === 1),
  );
  if (graded.length === 0) return { graded: 0, hitRate: null, centsPerCall: null };

  let hits = 0;
  let cents = 0;
  let priced = 0;
  const byConfidence = new Map();

  for (const read of graded) {
    // The call was UP and it finished above, or DOWN and it did not.
    const won = read.call === VERDICTS.UP ? read.outcome === 1 : read.outcome === 0;
    if (won) hits += 1;

    const bucket = byConfidence.get(read.confidence) ?? { n: 0, hits: 0, stated: 0 };
    bucket.n += 1;
    if (won) bucket.hits += 1;
    bucket.stated += read.winProbability ?? 0;
    byConfidence.set(read.confidence, bucket);

    // What acting on it would actually have paid, at the price it would have
    // been paid at. Without this the hit rate is decoration.
    if (Number.isFinite(read.entryCents) && read.entryCents > 0) {
      priced += 1;
      cents += (won ? 100 : 0) - read.entryCents;
    }
  }

  return {
    graded,
    hitRate: hits / graded.length,
    // Gross of fees. The fee is roughly 2¢ at mid prices, so a figure under
    // that is a loss however good the hit rate looks.
    centsPerCall: priced > 0 ? cents / priced : null,
    priced,
    tradeableShare: graded.filter((read) => read.tradeable).length / graded.length,
    byConfidence: [...byConfidence].map(([confidence, bucket]) => ({
      confidence,
      n: bucket.n,
      // What it said would happen, against what did. These two being close is
      // worth more than either being high.
      stated: bucket.stated / bucket.n,
      actual: bucket.hits / bucket.n,
    })),
  };
}
