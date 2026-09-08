// Fixed hypotheses: changing these after inspecting a test set starts a new experiment.
import { feePerContract } from './math.js';

export const EXIT_HYPOTHESES = Object.freeze(['recorded', 'settle', 'target_10', 'timed_120', 'flow_reversal']);
export const EXIT_REPLAY_VERSION = 'exit-replay-v1';
export const ENTRY_HYPOTHESES = Object.freeze(['all', 'flow_aligned', 'trend_aligned', 'edge_6', 'middle_prices']);
const sum = (rows, fn) => rows.reduce((total, row) => total + fn(row), 0);

export function entryEligible(trade, policy) {
  const f = trade.entryEvidence?.features ?? {}, sign = trade.side === 'up' ? 1 : -1;
  if (policy === 'all') return true;
  if (policy === 'flow_aligned') {
    const flow = [f.ofi, f.cvd, f.bookImbalance];
    return flow.every(Number.isFinite) && flow.filter((x) => x * sign > 0.2).length >= 2;
  }
  if (policy === 'trend_aligned') return f.trendStrength >= 0.3 && f.trendDirection === sign;
  if (policy === 'edge_6') return Number.isFinite(trade.entryEvidence?.netEdgeCents) && trade.entryEvidence.netEdgeCents >= 6;
  if (policy === 'middle_prices') return trade.entryCents >= 25 && trade.entryCents <= 75;
  throw new Error('Unknown entry hypothesis');
}

export function summarizeExitTrials(trials) {
  const rows = trials.filter((r) => Number.isFinite(r.profitCents));
  const n = rows.length, profit = sum(rows, (r) => r.profitCents);
  const mean = n ? profit / n : null;
  const variance = n > 1 ? sum(rows, (r) => (r.profitCents - mean) ** 2) / (n - 1) : null;
  let equity = 0, peak = 0, drawdown = 0;
  for (const row of [...rows].sort((a, b) => a.closedAt - b.closedAt || a.openedAt - b.openedAt)) {
    equity += row.profitCents; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity);
  }
  return { markets: n, unresolved: trials.length - n,
    wins: rows.filter((r) => r.profitCents > 1e-6).length,
    losses: rows.filter((r) => r.profitCents < -1e-6).length,
    netProfitDollars: profit / 100, meanProfitCents: mean,
    mean95Low: variance === null ? null : mean - 1.96 * Math.sqrt(variance / n),
    maximumDrawdownDollars: drawdown / 100,
    // Neighboring BTC windows can be correlated: the normal interval is descriptive only.
    intervalNote: 'Normal approximation by market; not adjusted for serial dependence or multiple hypotheses.' };
}

const validQuote = (r) => Number.isFinite(r.at) && Number.isFinite(r.secondsLeft) && r.secondsLeft > 0 &&
  Number.isFinite(r.bid) && Number.isFinite(r.ask) && r.bid >= 0 && r.ask <= 100 && r.bid <= r.ask &&
  Number.isFinite(r.evidence?.bookAt) && r.at - r.evidence.bookAt >= -5000 && r.at - r.evidence.bookAt <= 15000;
const heldBid = (row, side) => side === 'up' ? row.bid : 100 - row.ask;

export function replayExit(trade, observations, policy, { slippageCents = 1, outcome = null } = {}) {
  if (!EXIT_HYPOTHESES.includes(policy)) throw new Error('Unknown exit hypothesis');
  if (!['up', 'down'].includes(trade.side) || !(trade.contracts > 0) ||
      !Number.isFinite(trade.cost) || !Number.isFinite(trade.openedAt)) return null;
  const quotes = observations.filter((r) => r.ticker === trade.ticker && r.at > trade.openedAt && validQuote(r))
    .sort((a, b) => a.at - b.at);
  const closeFromEntry = trade.entryEvidence?.features?.secondsLeft;
  const closesAt = Number.isFinite(closeFromEntry) ? trade.openedAt + closeFromEntry * 1000 :
    quotes[0] ? quotes[0].at + quotes[0].secondsLeft * 1000 : null;
  const base = { ticker: trade.ticker, openedAt: trade.openedAt, side: trade.side, policy,
    closesAt, closedAt: closesAt, profitCents: null, reason: 'missing official result',
    observedFlowQuotes: quotes.filter((r) => ['ofi', 'cvd', 'bookImbalance'].every((k) =>
      Number.isFinite(r.evidence?.features?.[k]))).length };
  const cost = trade.cost / trade.contracts * 100 + slippageCents;
  if (policy === 'recorded') {
    return Number.isFinite(trade.profit) ? { ...base, closedAt: trade.at,
      profitCents: trade.profit / trade.contracts * 100 - slippageCents * (trade.reason === 'settled' ? 1 : 2),
      reason: trade.reason } : base;
  }
  for (let i = 0; policy !== 'settle' && i < quotes.length; i += 1) {
    const r = quotes[i], bid = heldBid(r, trade.side);
    const net = bid - feePerContract(bid / 100) * 100 - slippageCents;
    const f = r.evidence?.features ?? {}, direction = trade.side === 'up' ? 1 : -1;
    const flow = [f.ofi, f.cvd, f.bookImbalance];
    const trigger = policy === 'target_10' ? net - cost >= 10 :
      policy === 'timed_120' ? r.at >= trade.openedAt + 120_000 :
      flow.every(Number.isFinite) && flow.filter((v) => v * direction < -0.2).length >= 2;
    if (!trigger) continue;
    // Decision first, execution at the NEXT recorded book. Never sell at the signal's bid.
    const next = quotes[i + 1];
    if (!next || next.at - r.at > 45_000) return { ...base, reason: 'exit execution not observed', decisionAt: r.at };
    const execution = Math.max(0, heldBid(next, trade.side) - slippageCents);
    const proceeds = execution - feePerContract(execution / 100) * 100;
    if (proceeds <= 0) continue;
    return { ...base, closedAt: next.at, decisionAt: r.at, exitCents: execution,
      profitCents: proceeds - cost, reason: policy };
  }
  if (![0, 1].includes(outcome) || !Number.isFinite(closesAt)) return base;
  return { ...base, profitCents: (trade.side === 'up' ? outcome : 1 - outcome) * 100 - cost, reason: 'settled' };
}

function corpus(reports) {
  const rows = new Map(), profiles = new Map(), outcomes = new Map(), tickers = new Set();
  for (const report of reports) {
    for (const r of report.observations ?? []) {
      tickers.add(r.ticker); rows.set(`${r.ticker}:${r.at}`, r);
      if ([0, 1].includes(r.outcome) && r.outcomeSource === 'kalshi-market:official-result') {
        const prior = outcomes.get(r.ticker);
        outcomes.set(r.ticker, { outcome: r.outcome,
          conflict: Boolean(prior?.conflict || (prior && prior.outcome !== r.outcome)),
          recordedAt: r.outcomeRecordedAt ?? report.exportedAt });
      }
    }
    for (const [profile, account] of Object.entries(report.profiles ?? {})) {
      const first = profiles.get(profile) ?? new Map();
      for (const trade of account.trades ?? []) {
        const prior = first.get(trade.ticker);
        if (!prior || trade.openedAt < prior.openedAt) first.set(trade.ticker, trade);
      }
      profiles.set(profile, first);
    }
  }
  return { observations: [...rows.values()], profiles, outcomes, tickers };
}

/** Select a policy on earlier files, then evaluate later, disjoint markets.
 * These files have already been inspected: historical evidence, not a pristine lockbox. */
export function compareExitPolicies(trainingReports, laterReport, { slippageCents = 1 } = {}) {
  if (!trainingReports.length || trainingReports.some((r) => !(r.exportedAt < laterReport.exportedAt))) {
    throw new Error('Training reports must precede the later export');
  }
  const train = corpus(trainingReports), test = corpus([laterReport]);
  const cutoff = Math.max(...trainingReports.map((r) => r.exportedAt));
  const profiles = {};
  for (const [profile, testFirst] of test.profiles) {
    const phase = (data, first, isTest) => {
      const entries = [...(first ?? new Map()).values()].filter((trade) => {
        const result = data.outcomes.get(trade.ticker);
        return result && !result.conflict && (!isTest || (!train.tickers.has(trade.ticker) && trade.openedAt > cutoff)) &&
          (isTest || (trade.at <= cutoff && result.recordedAt <= cutoff));
      });
      const ledgers = Object.fromEntries(EXIT_HYPOTHESES.map((policy) => [policy, entries.map((trade) =>
        replayExit(trade, data.observations, policy, { slippageCents,
          outcome: data.outcomes.get(trade.ticker).outcome })).filter(Boolean)]));
      const common = new Set(entries.map((t) => t.ticker).filter((ticker) =>
        EXIT_HYPOTHESES.every((policy) => ledgers[policy].some((r) => r.ticker === ticker && Number.isFinite(r.profitCents)))));
      return { entries: entries.length, commonMarkets: common.size,
        entryPolicies: Object.fromEntries(ENTRY_HYPOTHESES.map((policy) => [policy,
          summarizeExitTrials(entries.filter((trade) => entryEligible(trade, policy)).map((trade) =>
            replayExit(trade, data.observations, 'settle', { slippageCents,
              outcome: data.outcomes.get(trade.ticker).outcome })).filter(Boolean))])),
        policies: Object.fromEntries(EXIT_HYPOTHESES.map((policy) => [policy, {
          ...summarizeExitTrials(ledgers[policy]),
          common: summarizeExitTrials(ledgers[policy].filter((r) => common.has(r.ticker))),
          ledger: ledgers[policy],
        }])) };
    };
    const training = phase(train, train.profiles.get(profile), false);
    const later = phase(test, testFirst, true);
    const ranked = EXIT_HYPOTHESES.map((policy) => ({ policy, ...training.policies[policy].common }))
      .filter((r) => r.markets >= 20).sort((a, b) => b.meanProfitCents - a.meanProfitCents || a.policy.localeCompare(b.policy));
    // Equal universe of entry opportunities; skipped entries contribute zero, not a fabricated win.
    const entryRanked = ENTRY_HYPOTHESES.map((policy) => ({ policy, ...training.entryPolicies[policy] }))
      .filter((r) => r.markets >= 20).sort((a, b) => b.netProfitDollars - a.netProfitDollars || a.policy.localeCompare(b.policy));
    profiles[profile] = { training, later, selectedOnTraining: ranked[0]?.policy ?? null,
      entrySelectedOnTraining: entryRanked[0]?.policy ?? null,
      promoted: false, futureConfirmationRequired: true };
  }
  return { version: EXIT_REPLAY_VERSION, slippageCents, trainingThrough: cutoff, profiles,
    limitations: ['First retained entry per ticker; missing earlier trades can change that selection.',
      'One contract, no compounding or account-capital simulation. Entries are inherited from the original paper strategy.',
      'Alternative exits use the next recorded book within 45 seconds; unpriced executions remain unresolved.',
      'Order depth, queues, actual fills and impact are unavailable. Observations are roughly 30 seconds apart.',
      'Flow reversal waits when OFI/CVD/depth are missing. Entry flow confirmation instead rejects missing inputs.',
      'Historical comparisons are exploratory. No automatic promotion or claim of a newly validated trading strategy.'] };
}
