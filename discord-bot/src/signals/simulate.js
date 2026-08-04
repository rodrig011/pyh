import { evaluate } from './engine.js';
import { SCALP_ACTIONS, roundTripReturn, scalpDecision } from './scalp.js';
import { recommendSize } from './sizing.js';
import { probabilityAbove } from './math.js';

/**
 * Paper trading, run against markets whose true behaviour is known.
 *
 * A backtest over real history is worth less than it looks: the engine gets to
 * see the same data its parameters were chosen on, and any strategy can be
 * bent until it fits. A simulation is stricter in the way that matters — the
 * process generating the prices is written down, so the honest answer is
 * knowable in advance and the engine can be caught claiming an edge that is
 * not there.
 *
 * Three experiments matter, and only one of them is flattering:
 *
 *   1. Price the market fairly. The engine should find nothing. If it finds
 *      edge here, it is hallucinating, and every other result is worthless.
 *   2. Price it with a real bias. The engine should find that, and roughly
 *      that much — no more.
 *   3. Generate paths the engine's model does NOT assume: jumps, volatility
 *      that clusters, fat tails. This is where a good-looking model dies, and
 *      it is the only test that resembles a real market.
 */

/** Deterministic RNG, so a surprising result can be reproduced exactly. */
export function makeRandom(seed = 42) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Box–Muller: uniform noise into the normal draws a price path needs. */
export function normalDraw(random) {
  const u = Math.max(1e-12, random());
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * A price path.
 *
 * `jumpChance` and `volClustering` exist to break the engine's own assumption
 * on purpose. A simulation that only produces the world the model believes in
 * proves nothing except that the arithmetic is consistent.
 */
export function generateWorld({
  start = 65000,
  steps = 30,
  volPerStep = 0.0008,
  jumpChance = 0,
  jumpSize = 0.004,
  volClustering = 0,
  random = makeRandom(),
} = {}) {
  const prices = [start];
  let vol = volPerStep;
  // The volatility in force at each point. Needed to price the market
  // honestly: an opponent who knows the model but not the future is the
  // strongest fair test, and it cannot be built from the prices alone.
  const vols = [vol];

  for (let i = 1; i <= steps; i += 1) {
    // Volatility that remembers: real markets go quiet and then wake up, and
    // an estimate built for a constant world is at its worst in the transition.
    if (volClustering > 0) {
      vol = vol * (1 - volClustering) + volPerStep * volClustering * (0.5 + random() * 1.5);
    }

    let move = normalDraw(random) * vol;
    if (jumpChance > 0 && random() < jumpChance) {
      move += (random() < 0.5 ? -1 : 1) * jumpSize;
    }
    prices.push(prices.at(-1) * Math.exp(move));
    vols.push(vol);
  }

  return { prices, vols, params: { volPerStep, jumpChance, jumpSize, volClustering } };
}

/** Just the prices, for callers that do not need the hidden state. */
export function generatePath(options = {}) {
  return generateWorld(options).prices;
}

/**
 * The market's price when the market is genuinely never wrong.
 *
 * With plain constant volatility the closed form is exact and this is not
 * needed. With jumps and clustering there is no closed form, and pricing the
 * contract off the BASE volatility instead would hand the engine an enormous
 * free edge: it reads the live volatility from the path while its opponent
 * refuses to. A backtest built that way reports a genius. This one instead
 * simulates the true remaining distribution from the true current state — the
 * market knows the model and the regime, and only the future is unknown.
 */
export function trueProbabilityAbove({
  spot,
  strike,
  stepsLeft,
  vol,
  volPerStep,
  jumpChance = 0,
  jumpSize = 0.004,
  volClustering = 0,
  paths = 300,
  random,
}) {
  if (!(stepsLeft > 0)) return spot > strike ? 1 : 0;

  let above = 0;
  for (let p = 0; p < paths; p += 1) {
    let price = spot;
    let v = vol;
    for (let s = 0; s < stepsLeft; s += 1) {
      if (volClustering > 0) {
        v = v * (1 - volClustering) + volPerStep * volClustering * (0.5 + random() * 1.5);
      }
      let move = normalDraw(random) * v;
      if (jumpChance > 0 && random() < jumpChance) {
        move += (random() < 0.5 ? -1 : 1) * jumpSize;
      }
      price *= Math.exp(move);
    }
    if (price > strike) above += 1;
  }
  return above / paths;
}

/**
 * How the market prices the contract.
 *
 * `fair` uses the true generating volatility, which is the hardest possible
 * opponent — a market that is never wrong. `bias` shifts it by a fixed number
 * of cents, which is what a real inefficiency looks like. `lag` prices off a
 * stale spot, which is the inefficiency a fast reader could genuinely capture.
 */
export function priceMarket({
  prices,
  index,
  strike,
  trueVolPerStep,
  stepsLeft,
  mode = 'fair',
  biasCents = 0,
  lagSteps = 3,
  fairProbabilities = null,
}) {
  const spotIndex = mode === 'lag' ? Math.max(0, index - lagSteps) : index;
  // A simulated true probability when one was worked out, the closed form when
  // the world is simple enough for it to be exact.
  const fair = fairProbabilities
    ? fairProbabilities[spotIndex]
    : probabilityAbove(
        prices[spotIndex],
        strike,
        trueVolPerStep * Math.sqrt(Math.max(1e-9, stepsLeft)),
      );
  if (fair === null || !Number.isFinite(fair)) return null;

  const cents = fair * 100 + (mode === 'bias' ? biasCents : 0);
  return Math.max(1, Math.min(99, cents));
}

/**
 * Runs the engine over one market, from open to bell, and books the trades.
 *
 * Fees come out of every leg, the position is sized the way the bot would size
 * it, and nothing is closed at a price the path never printed.
 */
export function runMarket({
  prices,
  strike,
  trueVolPerStep,
  sampleSeconds = 30,
  mode = 'fair',
  biasCents = 0,
  bankroll = 100,
  engine = {},
  sizing = {},
  history = [],
  fairProbabilities = null,
}) {
  const trades = [];
  let position = null;
  let cash = bankroll;

  for (let i = 0; i < prices.length; i += 1) {
    const stepsLeft = prices.length - 1 - i;
    const secondsLeft = stepsLeft * sampleSeconds;
    const marketCents = priceMarket({
      prices,
      index: i,
      strike,
      trueVolPerStep,
      stepsLeft,
      mode,
      biasCents,
      fairProbabilities,
    });
    if (marketCents === null) continue;

    // The engine only ever sees what the bot would see: the prices printed so
    // far, plus whatever history it was handed at the open.
    const seen = [...history, ...prices.slice(0, i + 1)];

    const result = evaluate(
      {
        prices: seen,
        spot: prices[i],
        strike,
        marketPriceCents: marketCents,
        secondsLeft,
        market: { liquidity_dollars: '1000' },
      },
      { sampleSeconds, ...engine },
    );

    // The price of the side actually held. A DOWN position is worth what NO
    // costs, not what YES costs, and confusing the two prices every exit.
    const heldCents = position
      ? position.side === 'up'
        ? marketCents
        : 100 - marketCents
      : (result.entryCents ?? marketCents);

    const call = scalpDecision({ position, nowCents: heldCents, signal: result, secondsLeft });

    if (call.action === SCALP_ACTIONS.ENTER && !position) {
      const sized = recommendSize({
        probability: result.winProbability,
        worstProbability: result.worstWinProbability,
        priceDollars: result.entryCents / 100,
        ...sizing,
      });
      const stake = cash * (sized?.suggested ?? 0);
      if (stake > 0) {
        position = { entryCents: result.entryCents, side: call.side, stake, at: i };
      }
    } else if (call.action === SCALP_ACTIONS.EXIT && position) {
      const exitCents = heldCents;
      const trip = roundTripReturn(position.entryCents, exitCents);
      const pnl = position.stake * ((trip?.percent ?? 0) / 100);
      cash += pnl;
      trades.push({
        side: position.side,
        entryCents: position.entryCents,
        exitCents,
        percent: trip?.percent ?? 0,
        // Before the exchange took its cut. The gap between this and `percent`
        // is the whole argument about whether a strategy is a strategy.
        grossPercent: ((exitCents - position.entryCents) / position.entryCents) * 100,
        reason: call.reason,
        pnl,
        heldSteps: i - position.at,
        probability: result.probability,
      });
      position = null;
    }
  }

  // Anything still open settles at the truth, fees already paid on entry.
  if (position) {
    const finishedAbove = prices.at(-1) > strike;
    const won = position.side === 'up' ? finishedAbove : !finishedAbove;
    const exitCents = won ? 100 : 0;
    const trip = roundTripReturn(position.entryCents, Math.max(1, exitCents));
    const pnl = won ? position.stake * ((trip?.percent ?? 0) / 100) : -position.stake;
    cash += pnl;
    trades.push({
      side: position.side,
      entryCents: position.entryCents,
      exitCents,
      percent: (pnl / position.stake) * 100,
      grossPercent: ((exitCents - position.entryCents) / position.entryCents) * 100,
      reason: 'settled',
      pnl,
      settled: true,
    });
  }

  return { trades, endBankroll: cash, returnPercent: ((cash - bankroll) / bankroll) * 100 };
}

/**
 * Many markets, one verdict.
 *
 * Reports the numbers that decide whether any of this is real: how often it
 * traded at all, how often it won, and — the one that matters — what a bankroll
 * did across the whole run after fees.
 */
export function runBacktest({
  markets = 200,
  stepsPerMarket = 30,
  volPerStep = 0.0008,
  jumpChance = 0,
  volClustering = 0,
  mode = 'fair',
  biasCents = 0,
  seed = 7,
  bankroll = 100,
  engine = {},
  sizing = {},
  // How many forward paths the fair price is worked out from when the world
  // has jumps or clustering. More is slower and less noisy.
  pricingPaths = 300,
  // Price by simulation even in a world where the closed form is exact.
  //
  // This exists to measure the harness rather than the engine. A simulated
  // price carries sampling noise, and noise IS mispricing — an engine reading
  // a market that is randomly wrong by a few cents can profit from nothing but
  // that. Running a world whose honest answer is already known through the
  // noisy pricer says how much of any jump-world profit is this artefact.
  forceSimulatedPricing = false,
} = {}) {
  const random = makeRandom(seed);
  // The market's pricing must not consume draws from the path's generator, or
  // pricing the contract would change the prices being priced.
  const pricingRandom = makeRandom(seed * 7919 + 13);
  let cash = bankroll;
  const all = [];
  let marketsTraded = 0;

  // A closed form is exact for a constant-volatility world, so the expensive
  // simulation is only worth running when the world breaks that assumption.
  const complexWorld = jumpChance > 0 || volClustering > 0 || forceSimulatedPricing;

  // A warm-up history so the first market is not refused for having none.
  let history = generatePath({ steps: 60, volPerStep, random });

  for (let m = 0; m < markets; m += 1) {
    const world = generateWorld({
      start: history.at(-1),
      steps: stepsPerMarket,
      volPerStep,
      jumpChance,
      volClustering,
      random,
    });
    const prices = world.prices;

    // The strike is set where the market opens, which is how these contracts
    // are actually written.
    const strike = prices[0];

    const fairProbabilities = complexWorld
      ? prices.map((spot, i) =>
          trueProbabilityAbove({
            spot,
            strike,
            stepsLeft: prices.length - 1 - i,
            vol: world.vols[i],
            volPerStep,
            jumpChance,
            jumpSize: world.params.jumpSize,
            volClustering,
            paths: pricingPaths,
            random: pricingRandom,
          }),
        )
      : null;

    const run = runMarket({
      prices,
      strike,
      trueVolPerStep: volPerStep,
      mode,
      biasCents,
      bankroll: cash,
      engine,
      sizing,
      history: history.slice(-60),
      fairProbabilities,
    });

    cash = run.endBankroll;
    if (run.trades.length > 0) marketsTraded += 1;
    all.push(...run.trades);
    history = [...history, ...prices].slice(-120);
  }

  const wins = all.filter((trade) => trade.pnl > 0).length;
  const losses = all.filter((trade) => trade.pnl < 0).length;

  return {
    markets,
    marketsTraded,
    tradeRate: marketsTraded / markets,
    trades: all.length,
    wins,
    losses,
    winRate: wins + losses === 0 ? null : wins / (wins + losses),
    startBankroll: bankroll,
    endBankroll: cash,
    returnPercent: ((cash - bankroll) / bankroll) * 100,
    averageTradePercent:
      all.length === 0 ? null : all.reduce((t, x) => t + x.percent, 0) / all.length,
  };
}
