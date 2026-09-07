import { strategyResult } from './validation.js';

const clamp = (p) => Math.max(0.0001, Math.min(0.9999, p));
const logit = (p) => Math.log(clamp(p) / (1 - clamp(p)));
const logistic = (x) => 1 / (1 + Math.exp(-x));
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

/** First available observation after the specified decision time. Selecting
 * the best-looking tick or using many ticks as independent labels is forbidden. */
export function decisionSnapshots(observations, { horizon = 300, tolerance = 35 } = {}) {
  const byTicker = new Map();
  const sorted = [...(observations ?? [])].sort((a, b) => a.at - b.at);
  for (const r of sorted) {
    if (!r?.ticker || byTicker.has(r.ticker) || !(r.at > 0)) continue;
    if (r.outcomeSource !== 'kalshi-market:official-result' || ![0, 1].includes(r.outcome)) continue;
    if (!Number.isFinite(r.model) || r.model < 0 || r.model > 1) continue;
    if (!Number.isFinite(r.bid) || !Number.isFinite(r.ask) || r.bid < 0 || r.ask > 100 || r.bid > r.ask) continue;
    if (!Number.isFinite(r.secondsLeft) || r.secondsLeft > horizon || r.secondsLeft < horizon - tolerance) continue;
    const age = r.at - r.evidence?.sourceAt;
    if (r.evidence?.feedVersion !== 'brti-latest-v2' || !Number.isFinite(age) || age < -5000 || age > 15000) continue;
    byTicker.set(r.ticker, { ...r, market: (r.bid + r.ask) / 200,
      closesAt: r.at + r.secondsLeft * 1000 });
  }
  return [...byTicker.values()];
}

/** Learn only how much of the model/market disagreement to retain. No
 * additional indicators or labels from the test period enter this fit. */
export function anchorProbability(raw, market, weight) {
  return logistic(logit(market) + weight * (logit(raw) - logit(market)));
}

export function fitMarketAnchor(rows, { minimumMarkets = 20 } = {}) {
  const unique = [...new Map(rows.map((r) => [r.ticker, r])).values()];
  if (unique.length < minimumMarkets) return { ready: false, markets: unique.length, weight: 0 };
  const candidates = [0, 0.25, 0.5, 0.75, 1].map((weight) => {
    const logLoss = mean(unique.map((r) => {
      const p = anchorProbability(r.model, r.market, weight);
      return -r.outcome * Math.log(p) - (1 - r.outcome) * Math.log(1 - p);
    }));
    return { weight, logLoss, objective: logLoss + 0.001 * weight ** 2 };
  });
  const best = [...candidates].sort((a, b) => a.objective - b.objective || a.weight - b.weight)[0];
  return { ready: true, markets: unique.length, weight: best.weight, candidates,
    trainedThrough: Math.max(...unique.map((r) => r.closesAt)) };
}

function score(rows, probabilities) {
  return {
    markets: rows.length,
    brier: mean(rows.map((r, i) => (probabilities[i] - r.outcome) ** 2)),
    logLoss: mean(rows.map((r, i) => -r.outcome * Math.log(clamp(probabilities[i])) -
      (1 - r.outcome) * Math.log(1 - clamp(probabilities[i])))),
    correctSides: rows.filter((r, i) => (probabilities[i] >= 0.5 ? 1 : 0) === r.outcome).length,
    strategy: strategyResult(rows.map((r, i) => ({ ...r, calibrated: probabilities[i] }))),
  };
}

/** Frozen earlier-report fit, later-report test. Overlapping tickers and
 * outcomes not available before the first test decision are excluded. */
export function lockedHoldout(trainingObservations, testObservations, { horizon = 300 } = {}) {
  const train = decisionSnapshots(trainingObservations, { horizon });
  const trainingTickers = new Set(train.map((r) => r.ticker));
  const test = decisionSnapshots(testObservations, { horizon }).filter((r) => !trainingTickers.has(r.ticker));
  const cutoff = test.length ? Math.min(...test.map((r) => r.at)) : Infinity;
  const before = train.filter((r) => r.closesAt + 60_000 < cutoff &&
    (r.outcomeRecordedAt == null || r.outcomeRecordedAt < cutoff));
  const fit = fitMarketAnchor(before);
  const model = score(test, test.map((r) => r.model));
  const market = score(test, test.map((r) => r.market));
  const candidate = fit.ready ? score(test, test.map((r) => anchorProbability(r.model, r.market, fit.weight))) : null;
  return { horizon, trainingMarkets: before.length, testMarkets: test.length, fit, model, market, candidate,
    promoted: false,
    limitations: [
      'Research experiment, not a replay of the production scalper or proof of profitability.',
      'One hypothetical contract per eligible market; actual queue, depth and latency are not reconstructed.',
      'Earlier labels without receipt timestamps assume availability 60 seconds after close.',
      'Multiple horizons are correlated experiments; do not choose a winner from this test report and call it validation.',
    ] };
}

/** At each test decision only already closed markets can train the candidate. */
export function forwardResearch(observations, { horizon = 300, minimumMarkets = 20 } = {}) {
  const rows = decisionSnapshots(observations, { horizon });
  const tested = [];
  for (const r of rows) {
    const previous = rows.filter((prior) => prior.ticker !== r.ticker &&
      prior.closesAt + 60_000 < r.at && (prior.outcomeRecordedAt == null || prior.outcomeRecordedAt < r.at));
    const fit = fitMarketAnchor(previous, { minimumMarkets });
    if (fit.ready) tested.push({ row: r, probability: anchorProbability(r.model, r.market, fit.weight),
      weight: fit.weight, trainingMarkets: fit.markets, trainedThrough: fit.trainedThrough });
  }
  return {
    horizon, totalMarkets: rows.length, outOfSampleMarkets: tested.length, promoted: false,
    model: score(tested.map((t) => t.row), tested.map((t) => t.row.model)),
    market: score(tested.map((t) => t.row), tested.map((t) => t.row.market)),
    candidate: score(tested.map((t) => t.row), tested.map((t) => t.probability)),
    decisions: tested.map((t) => ({ ticker: t.row.ticker, at: t.row.at, probability: t.probability,
      weight: t.weight, trainingMarkets: t.trainingMarkets, trainedThrough: t.trainedThrough })),
    note: 'Market-anchored candidate trains only on earlier settled markets. Research only; no automatic live promotion.',
  };
}
