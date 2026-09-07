import test from 'node:test';
import assert from 'node:assert/strict';
import { scalpDecision, scalpEntryBudget } from '../src/signals/scalp.js';
import { evaluate } from '../src/signals/engine.js';
import { newAccount, paperTick, PROFILES, liveProfileOf } from '../src/picks/paper.js';
import { researchExport, tradeDiagnostics } from '../src/signals/research.js';
import { auditExecution } from '../scripts/audit-execution.mjs';
import { observeOnce } from '../src/signals/recorder.js';

const prices = Array.from({ length: 90 }, (_, i) => 65000 + Math.sin(i / 3) * 40);
const input = (bid, ask) => ({ prices, spot: 65000, strike: 65000, secondsLeft: 420,
  marketPriceCents: (bid + ask) / 2,
  market: { ticker: 'T', yes_bid: bid, yes_ask: ask, liquidity_dollars: 4000 } });

test('SCALP checks both fee legs without rounding a fractional-cent target to a whole cent', () => {
  assert.equal(scalpEntryBudget(50, 0.53).coversCosts, false);
  const enough = scalpEntryBudget(50, 0.543);
  assert.equal(enough.coversCosts, true);
  assert.ok(Math.abs(enough.netCents - 0.3) < 1e-8);
  assert.equal(scalpEntryBudget(50, null), null);
});

test('paper and live SCALP reject settlement-only edges on either side while retaining an exit valuation', () => {
  for (const [bid, ask] of [[46, 47], [53, 54]]) {
    const old = evaluate(input(bid, ask), { ...PROFILES.scalp.engine, scalpMarginCents: null });
    assert.notEqual(old.verdict, 'skip');
    for (const engine of [PROFILES.scalp.engine, liveProfileOf('scalp').engine]) {
      const read = evaluate(input(bid, ask), engine);
      assert.equal(read.reason, 'round_trip_cost');
      assert.ok(Number.isFinite(read.probability));
      assert.ok(read.quotes);
      assert.equal(read.scalpBudget.coversCosts, false);
    }
  }
  assert.equal(evaluate(input(42, 43), PROFILES.scalp.engine).verdict, 'up');
});

test('soft exits compare held value with net sale proceeds; hard stops and real reversals still exit', () => {
  for (const side of ['up', 'down']) {
    const state = { position: { side, entryCents: 50 }, nowCents: 50,
      signal: { verdict: 'skip', probability: 0.5 }, secondsLeft: 400 };
    const held = scalpDecision(state, { marginCents: 0.25 });
    assert.equal(held.action, 'wait');
    assert.equal(held.favoured, 2);
    assert.equal(scalpDecision({ ...state, secondsLeft: 20 }).reason, 'settling');
    const worse = { ...state, signal: { verdict: 'skip', probability: side === 'up' ? 0.46 : 0.54 } };
    assert.equal(scalpDecision(worse, { marginCents: 0.25 }).reason, 'cut');
    assert.equal(scalpDecision({ ...state, position: { side, entryCents: 80 } }, { maximumLossPercent: 20 }).reason, 'stop loss');
    assert.equal(scalpDecision({ ...state, signal: { verdict: side === 'up' ? 'down' : 'up', probability: side === 'up' ? 0.1 : 0.9 } }).reason, 'model flipped');
  }
});

test('paper closes retain exit evidence in exports without replacing earlier trades', () => {
  const now = 1788810000000;
  const legacy = { ticker: 'OLDER', side: 'up', profit: 1, fees: 0.02, reason: 'settled' };
  const account = { ...newAccount({ bankroll: 100, profile: 'scalp' }), trades: [legacy], cash: 93.8,
    position: { ticker: 'T', side: 'up', entryCents: 60, contracts: 10, cost: 6.2, entryFee: 0.2, openedAt: now - 30000 } };
  const context = { ...input(69, 71), sourceAt: now - 1000 };
  const closed = paperTick(account, context, { now });
  assert.equal(closed.event.kind, 'exit');
  assert.equal(closed.account.trades[0], legacy);
  const evidence = closed.event.trade.exitEvidence;
  assert.equal(evidence.bidCents, 69);
  assert.equal(evidence.liquidationNetCents, 67);
  assert.equal(evidence.sourceAt, now - 1000);
  assert.ok(Number.isFinite(evidence.probabilityYes));
  const exported = researchExport({ paperAccounts: () => ({ scalp: closed.account }), listQuotes: () => [] });
  assert.deepEqual(exported.profiles.scalp.trades.at(-1).exitEvidence, evidence);
});

test('execution audit separates real losses from floating-point noise, incomplete evidence and new trades', () => {
  const trade = { ticker: 'T', side: 'up', openedAt: 1000, at: 2000,
    contracts: 1, entryCents: 50, exitCents: 54, fees: 0.04,
    cost: 0.52, proceeds: 0.52, profit: -2e-16, reason: 'cut' };
  const second = { ...trade, openedAt: 3000, at: 4000, profit: -0.03, proceeds: 0.49, exitCents: 51 };
  const report = { observations: [], profiles: { scalp: { start: 100, cash: 99.97, trades: [trade, second] } } };
  const prior = { profiles: { scalp: { trades: [trade] } } };
  const out = auditExecution(report, prior).profiles.scalp;
  assert.equal(out.breakEven, 1);
  assert.equal(out.losses, 1);
  assert.equal(out.newTrades.trades, 1);
  assert.equal(out.entryBudgetCohorts.unknown.trades, 2);
  assert.equal(out.accountingErrors.length, 0);
  const bad = structuredClone(report);
  bad.profiles.scalp.trades[1].profit = 5;
  assert.equal(auditExecution(bad).profiles.scalp.accountingErrors.length, 1);
  assert.equal(tradeDiagnostics([trade]).groups[0].breakEven, 1);
  assert.equal(tradeDiagnostics([trade]).groups[0].losses, 0);
});

test('the research recorder includes the observed contract tape instead of silently losing CVD', () => {
  const now = 1788810000000;
  let rows = [];
  const store = { listSamples: () => prices.map((price, i) => ({ price, at: now - (prices.length - i) * 30000 })),
    listQuotes: () => rows, putQuotes: (_asset, next) => { rows = next; } };
  const market = { ...input(49, 51).market, floor_strike: 65000, close_time: new Date(now + 420000).toISOString() };
  const result = observeOnce(store, { contract: { market, price: 50, strike: 65000 }, spot: 65000, now,
    trades: [{ taker_side: 'yes', count_fp: '3' }, { taker_side: 'no', count_fp: '1' }], evaluateModel: evaluate });
  assert.equal(result.recorded, true);
  assert.equal(rows[0].evidence.features.cvd, 0.5);
  assert.equal(rows[0].evidence.tradeCount, 2);
});
