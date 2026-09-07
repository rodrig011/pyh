import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateSettlementProbability } from '../src/signals/quantEngine.js';
import { evaluate } from '../src/signals/engine.js';
import { entryRiskBudget, quotedEntrySize } from '../src/signals/executionRisk.js';
import { scalpDecision } from '../src/signals/scalp.js';
import { recommendSize } from '../src/signals/sizing.js';
import { contractsFor, newAccount, paperTick, PROFILES, LIVE_PROFILES } from '../src/picks/paper.js';
import { createStore } from '../src/lib/store.js';
import { researchExport } from '../src/signals/research.js';
import { captureReplayInput } from '../src/signals/replayInput.js';
import { decisionSnapshots, fitMarketAnchor, forwardResearch, lockedHoldout } from '../src/signals/modelLab.js';

const now = 1788764375000;
const history = Array.from({ length: 120 }, (_, i) => 80000 + Math.sin(i) * 15);
const input = (extra = {}) => ({ prices: history, spot: 80000, strike: 80000, secondsLeft: 400,
  now, marketPriceCents: 40.5, sourceAt: now - 1000, feedVersion: 'brti-latest-v2',
  market: { ticker: 'T', yes_bid: 40, yes_ask: 41, liquidity_dollars: '1000',
    yes_bid_size: 100, yes_ask_size: 100, microstructure: { ofi: 0, bookComplete: true } },
  trades: [{ taker_side: 'yes', count: 30 }, { taker_side: 'no', count: 30 }], ...extra });

test('probability caps constrain actual forecasts, while not inventing an opposite-side bargain', () => {
  const read = estimateSettlementProbability(input({ strike: 79000 }), { settlementAveraging: false });
  assert.ok(read.rawPYes > 0.99);
  assert.ok(read.fairPYes <= 0.70);
  assert.ok(Math.abs(read.fairPYes + read.fairPNo - 1) < 1e-12);
  assert.ok(read.edge.no.netCents < 0, 'cap does not turn tiny raw NO probability into an executable edge');
  assert.ok(read.probabilityRange[1] >= read.rawPYes);
});

test('a calibration boolean cannot authorize exceptional probabilities without historical evidence', () => {
  const prices = Array.from({ length: 120 }, (_, i) => 80000 + i * 2 + Math.sin(i) * 10);
  const read = estimateSettlementProbability(input({ prices, spot: prices.at(-1), strike: 79000,
    historicallyCalibrated: true, microstructure: { ofi: 1, cvd: 1, bookImbalance: 1, bookComplete: true } }));
  assert.ok(read.fairPYes <= 0.9);
  assert.equal(read.confidence.calibrated, false);
});

test('both live and paper use the actual declared entry deadlines', () => {
  for (const profile of ['careful', 'scalp']) {
    assert.equal(PROFILES[profile].engine.minimumSecondsLeft, PROFILES[profile].scalp.noEntryWithinSeconds);
    assert.equal(LIVE_PROFILES[profile].engine.minimumSecondsLeft, PROFILES[profile].scalp.noEntryWithinSeconds);
    const read = evaluate(input({ secondsLeft: PROFILES[profile].engine.minimumSecondsLeft - 1 }),
      { ...PROFILES[profile].engine, settlementAveraging: false });
    assert.equal(read.reason, 'too_late');
  }
  assert.equal(paperTick(newAccount({ bankroll: 100, profile: 'scalp' }), input({ secondsLeft: 25 }), { now }).event, null);
});

test('default size budgets include fees and a per-market turnover budget survives closes', () => {
  const account = newAccount({ bankroll: 100, profile: 'scalp', at: now });
  const opened = paperTick(account, input(), { now }).account;
  assert.ok(opened.position, 'normal priced opportunity still enters');
  assert.ok(opened.position.cost <= 2 + 1e-8);
  assert.equal(opened.marketRisk.committedDollars, opened.position.cost);
  const budget = entryRiskBudget({ cash: 110, marketRisk: { ticker: 'T', basisCash: 100, committedDollars: 4.9 } }, 'T');
  assert.ok(Math.abs(budget.availableDollars - 0.1) < 1e-8, 'profit does not refill a spent market budget');
  assert.equal(contractsFor(2, 50, { feeRate: 0.07 }), 3);
  assert.equal(entryRiskBudget({ cash: 90, marketRisk: { ticker: 'T', basisCash: 100, committedDollars: 5 } }, 'T').availableDollars, 0);
  assert.equal(entryRiskBudget({ cash: 90, marketRisk: { ticker: 'T', basisCash: 100, committedDollars: 5 } }, 'NEXT').availableDollars, 1.8);
});

test('Kelly does not size a positive stake when the apparent edge is only the entry fee', () => {
  const size = recommendSize({ probability: 0.51, priceDollars: 0.50, entryFeeDollars: 0.02 });
  assert.equal(size.suggested, 0);
});

test('paper cannot fill more contracts than the quoted entry level offers', () => {
  assert.equal(quotedEntrySize({ yes_bid_size: '2.5' }, 'down'), 2);
  assert.equal(quotedEntrySize({}, 'up'), null);
  const state = input();
  state.market.yes_ask_size = 1;
  const entered = paperTick(newAccount({ bankroll: 100, profile: 'scalp' }), state, { now });
  assert.equal(entered.event.trade.contracts, 1);
  assert.equal(entered.event.trade.entryEvidence.quotedSize, 1);
});

test('a contradictory entry verdict cannot sell a held position at inferior net value', () => {
  const state = { position: { side: 'down', entryCents: 50 }, nowCents: 50, secondsLeft: 400,
    signal: { verdict: 'up', probability: 0.1 } };
  assert.equal(scalpDecision(state).action, 'wait');
  const worse = { ...state, signal: { verdict: 'up', probability: 0.8 } };
  assert.equal(scalpDecision(worse).action, 'exit');
});

test('soft exits require a margin beyond the uncertainty band; hard stops remain decisive', () => {
  const state = { position: { side: 'up', entryCents: 60 }, nowCents: 55, secondsLeft: 300,
    signal: { verdict: 'down', probability: 0.5, quant: { probabilityRange: [0.45, 0.56] } } };
  assert.equal(scalpDecision(state).action, 'wait');
  assert.equal(scalpDecision({ ...state, nowCents: 59 }).reason, 'model flipped');
  assert.equal(scalpDecision(state, { maximumLossPercent: 10 }).reason, 'stop loss');
  assert.equal(scalpDecision({ ...state, nowCents: 0.6 }).reason, 'sale proceeds consumed by fee');
});

test('paper exit uses its own ticker tape and exports open capital separately from cash', () => {
  const account = { ...newAccount({ bankroll: 100, profile: 'scalp', at: now }), cash: 93.8,
    position: { ticker: 'T', side: 'up', entryCents: 60, cost: 6.2, entryFee: 0.2, contracts: 10, openedAt: now - 30000 } };
  const state = paperTick(account, input({ marketPriceCents: 75.5,
    market: { ...input().market, yes_bid: 75, yes_ask: 76 }, trades: [],
    tradesByTicker: { T: [{ taker_side: 'no', count: 10 }], OTHER: [{ taker_side: 'yes', count: 10 }] },
  }), { now });
  assert.equal(state.event.kind, 'exit');
  assert.equal(state.event.trade.exitEvidence.features.cvd, -1);
  const exported = researchExport({ listQuotes: () => [], paperAccounts: () => ({ scalp: account }) });
  assert.equal(exported.profiles.scalp.position.cost, 6.2);
  assert.equal(exported.profiles.scalp.closedProfit, 0);
});

test('a paper reset archives the previous run across restart without exporting private store fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-risk-'));
  try {
    const path = join(dir, 'store.json');
    const store = createStore(path);
    const old = { ...newAccount({ bankroll: 100, profile: 'scalp', at: now }), secret: 'NEVER_EXPORT',
      trades: [{ ticker: 'OLD', profit: -5, reason: 'settled', fees: 0.2 }] };
    store.putPaperAccounts({ scalp: old });
    store.putPaperAccounts({ scalp: newAccount({ bankroll: 100, profile: 'scalp', at: now + 1000 }) });
    const restored = createStore(path);
    const report = researchExport(restored);
    assert.equal(report.archivedRuns.length, 1);
    assert.equal(report.archivedRuns[0].profiles.scalp.trades[0].profit, -5);
    assert.ok(!JSON.stringify(report).includes('NEVER_EXPORT'));
    assert.equal(restored.paperAccount('scalp').trades.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('captured replay data reproduces the quantitative read and excludes arbitrary nested data', () => {
  const state = input();
  state.market.secret = 'NEVER_EXPORT';
  state.market.microstructure.secret = 'NEVER_EXPORT';
  state.trades[0].secret = 'NEVER_EXPORT';
  const recorded = captureReplayInput(state);
  assert.ok(!JSON.stringify(recorded).includes('NEVER_EXPORT'));
  const original = evaluate(state), replayed = evaluate(recorded);
  assert.equal(replayed.probability, original.probability);
  assert.equal(replayed.verdict, original.verdict);
});

function row(i, { outcome = i % 2, model = 0.8, market = 0.5, secondsLeft = 290 } = {}) {
  const at = now + i * 900000;
  return { ticker: `R${i}`, at, secondsLeft, model, bid: market * 100 - 1, ask: market * 100 + 1,
    outcome, outcomeSource: 'kalshi-market:official-result', evidence: { sourceAt: at - 1000, feedVersion: 'brti-latest-v2' } };
}

test('model lab chooses the first available decision and rejects stale feeds and duplicate labels', () => {
  const a = row(1);
  const picked = decisionSnapshots([{ ...a, at: a.at + 10000, secondsLeft: 280, model: 0.99 }, a,
    { ...row(2), evidence: { sourceAt: now, feedVersion: 'old' } }, row(3, { secondsLeft: 100 })]);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].model, 0.8);
  assert.equal(fitMarketAnchor([...picked, ...picked], { minimumMarkets: 2 }).ready, false);
});

test('market anchor learns to distrust overconfidence using past labels only', () => {
  const train = Array.from({ length: 25 }, (_, i) => row(i));
  const testRows = Array.from({ length: 10 }, (_, i) => row(i + 30));
  const first = lockedHoldout(train, testRows);
  const flipped = lockedHoldout(train, testRows.map((r) => ({ ...r, outcome: 1 - r.outcome })));
  assert.equal(first.fit.ready, true);
  assert.equal(first.fit.weight, 0);
  assert.equal(first.fit.weight, flipped.fit.weight, 'test results cannot change training');
  assert.equal(first.promoted, false);
});

test('forward research excludes outcomes recorded after the decision and survives an empty report', () => {
  const rows = Array.from({ length: 25 }, (_, i) => row(i));
  assert.ok(forwardResearch(rows).outOfSampleMarkets > 0);
  assert.equal(forwardResearch(rows.map((r) => ({ ...r, outcomeRecordedAt: now + 1000000000 }))).outOfSampleMarkets, 0);
  assert.equal(forwardResearch([]).outOfSampleMarkets, 0);
});
