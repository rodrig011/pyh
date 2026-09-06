import { feePerContract } from './math.js';

const clamp = (value, low = 0.01, high = 0.99) => Math.min(high, Math.max(low, value));
const logit = (p) => Math.log(clamp(p) / (1 - clamp(p)));
const logistic = (x) => 1 / (1 + Math.exp(-x));

/** One independent, five-minutes-to-close snapshot per settled market. */
export function marketSnapshots(observations, { targetSecondsLeft = 300 } = {}) {
  const byTicker = new Map();
  for (const row of observations ?? []) {
    if (!row?.ticker || !Number.isFinite(row.model) || row.model < 0 || row.model > 1) continue;
    if (row.outcomeSource !== 'kalshi-market:official-result') continue;
    if (!(row.at > 0) || !Number.isFinite(row.secondsLeft) || row.secondsLeft <= 0) continue;
    if (row.outcome !== 0 && row.outcome !== 1) continue;
    if (!Number.isFinite(row.bid) || !Number.isFinite(row.ask) || row.ask < row.bid || row.bid < 0 || row.ask > 100) continue;
    const distance = Math.abs((Number(row.secondsLeft) || 0) - targetSecondsLeft);
    const previous = byTicker.get(row.ticker);
    if (!previous || distance < previous.distance || (distance === previous.distance && row.at < previous.row.at)) {
      byTicker.set(row.ticker, { distance, row });
    }
  }
  return [...byTicker.values()]
    .map(({ row }) => ({ ...row, closesAt: row.at + row.secondsLeft * 1000 }))
    .sort((a, b) => a.closesAt - b.closesAt || a.ticker.localeCompare(b.ticker));
}

/**
 * Small regularised Platt calibrator. Grid fitting is intentionally boring:
 * deterministic, dependency-free and difficult to overfit with two parameters.
 */
export function fitProbabilityCalibrator(rows, { minimumMarkets = 50 } = {}) {
  if ((rows?.length ?? 0) < minimumMarkets) {
    return { ready: false, markets: rows?.length ?? 0, slope: 1, intercept: 0 };
  }
  let best = { loss: Infinity, slope: 1, intercept: 0 };
  for (let slopeStep = 4; slopeStep <= 16; slopeStep += 1) {
    const slope = slopeStep / 10;
    for (let interceptStep = -8; interceptStep <= 8; interceptStep += 1) {
      const intercept = interceptStep / 10;
      let loss = 0;
      for (const row of rows) {
        const p = logistic(intercept + slope * logit(row.model));
        loss += (p - row.outcome) ** 2;
      }
      // Weak pull toward identity; the data must earn extreme recalibration.
      loss = loss / rows.length + 0.002 * ((slope - 1) ** 2 + intercept ** 2);
      if (loss < best.loss) best = { loss, slope, intercept };
    }
  }
  return { ready: true, markets: rows.length, ...best };
}

export function calibratedProbability(probability, calibrator) {
  if (!Number.isFinite(probability) || !calibrator?.ready) return probability;
  return logistic(calibrator.intercept + calibrator.slope * logit(probability));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function brier(rows, field) {
  return mean(rows.map((row) => (row[field] - row.outcome) ** 2));
}

export function strategyResult(rows, { minimumEdgeCents = 6, slippageCents = 1 } = {}) {
  const trades = [];
  let equity = 0;
  let peak = 0;
  let maximumDrawdown = 0;
  for (const row of rows ?? []) {
    const yesEntry = row.ask;
    const noEntry = 100 - row.bid;
    const yesFee = Math.ceil(feePerContract(yesEntry / 100) * 100);
    const noFee = Math.ceil(feePerContract(noEntry / 100) * 100);
    const yesEdge = row.calibrated * 100 - yesEntry - yesFee - slippageCents;
    const noEdge = (1 - row.calibrated) * 100 - noEntry - noFee - slippageCents;
    const side = yesEdge >= noEdge ? 'yes' : 'no';
    const edge = Math.max(yesEdge, noEdge);
    if (!(edge >= minimumEdgeCents)) continue;
    const entry = side === 'yes' ? yesEntry : noEntry;
    const fee = side === 'yes' ? yesFee : noFee;
    const won = side === 'yes' ? row.outcome === 1 : row.outcome === 0;
    const profitCents = (won ? 100 : 0) - entry - fee - slippageCents;
    equity += profitCents;
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.max(maximumDrawdown, peak - equity);
    trades.push({ ticker: row.ticker, side, entryCents: entry, edgeCents: edge, won, profitCents });
  }
  const profits = trades.map((trade) => trade.profitCents);
  const averageProfitCents = mean(profits);
  const variance = profits.length > 1
    ? profits.reduce((sum, value) => sum + (value - averageProfitCents) ** 2, 0) / (profits.length - 1)
    : null;
  const standardError = Number.isFinite(variance) ? Math.sqrt(variance / profits.length) : null;
  return {
    trades: trades.length,
    wins: trades.filter((trade) => trade.won).length,
    losses: trades.filter((trade) => !trade.won).length,
    winRate: trades.length ? trades.filter((trade) => trade.won).length / trades.length : null,
    netProfitCents: profits.reduce((sum, value) => sum + value, 0),
    averageProfitCents,
    profitCi95Low: Number.isFinite(standardError) ? averageProfitCents - 1.96 * standardError : null,
    maximumDrawdownCents: maximumDrawdown,
    minimumEdgeCents,
    slippageCents,
    ledger: trades,
  };
}

/** Every test prediction is calibrated only with markets that closed earlier. */
export function walkForwardValidation(
  observations,
  { minimumTrainingMarkets = 50, minimumOutOfSampleMarkets = 200, minimumTrades = 30, minimumEdgeCents = 6, slippageCents = 1, requireVerifiedFeed = false } = {},
) {
  const usable = requireVerifiedFeed ? (observations ?? []).filter((row) =>
    row.evidence?.feedVersion === 'brti-latest-v2' && Number.isFinite(row.evidence?.sourceAt) &&
    row.at - row.evidence.sourceAt >= -5000 && row.at - row.evidence.sourceAt <= 15000) : observations;
  const snapshots = marketSnapshots(usable);
  const tested = [];
  for (let index = minimumTrainingMarkets; index < snapshots.length; index += 1) {
    const row = snapshots[index];
    const training = snapshots.slice(0, index).filter((prior) => prior.closesAt + 60_000 < row.at);
    if (training.length < minimumTrainingMarkets) continue;
    const calibrator = fitProbabilityCalibrator(training, {
      minimumMarkets: minimumTrainingMarkets,
    });
    tested.push({
      ...row,
      raw: row.model,
      calibrated: calibratedProbability(row.model, calibrator),
      market: (row.bid + row.ask) / 200,
    });
  }
  const strategy = strategyResult(tested, { minimumEdgeCents, slippageCents });
  const rawBrier = brier(tested, 'raw');
  const calibratedBrier = brier(tested, 'calibrated');
  const marketBrier = brier(tested, 'market');
  const reasons = [];
  if (tested.length < minimumOutOfSampleMarkets) reasons.push(`need ${minimumOutOfSampleMarkets} out-of-sample markets`);
  if (!(calibratedBrier < marketBrier)) reasons.push('calibrated model does not beat Kalshi Brier score');
  if (strategy.trades < minimumTrades) reasons.push(`need ${minimumTrades} out-of-sample trades`);
  if (!(strategy.winRate > 0.5)) reasons.push('out-of-sample win rate is not above 50%');
  if (!(strategy.profitCi95Low > 0)) reasons.push('net profit after fees/slippage is not statistically above zero');
  return {
    ready: tested.length > 0,
    excludedUnverifiedObservations: requireVerifiedFeed ? (observations?.length ?? 0) - usable.length : 0,
    trainingMarkets: Math.min(minimumTrainingMarkets, snapshots.length),
    outOfSampleMarkets: tested.length,
    totalMarkets: snapshots.length,
    rawBrier,
    calibratedBrier,
    marketBrier,
    strategy,
    promotion: { eligible: reasons.length === 0, reasons },
    limitations: ['Quote replay assumes one-contract fills; historical depth is unavailable.', 'Costs include rounded fees and assumed 1 cent slippage.', 'Results are research evidence, not a guarantee or automatic live promotion.'],
  };
}
