import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureStudyEntry, recordStudyExit, settleExitStudy, pendingStudyTickers, exitStudySummary } from '../src/signals/exitStudy.js';
import { compareExitPolicies, replayExit, entryEligible } from '../src/signals/exitReplay.js';
import { newAccount, paperTick } from '../src/picks/paper.js';
import { sweepPaper } from '../src/picks/watch.js';
import { createStore } from '../src/lib/store.js';
import { researchExport } from '../src/signals/research.js';
import { paperSummary } from '../src/dashboard/read.js';

const now = 1788899400000;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const position = (extra = {}) => ({ ticker: 'T', side: 'up', openedAt: now,
  closesAt: now + 300000, entryCents: 40, cost: 4.2, contracts: 10, ...extra });
const quote = (seconds, bid, ask = bid + 1, extra = {}) => ({ ticker: 'T', at: now + seconds * 1000,
  secondsLeft: 300 - seconds, bid, ask,
  evidence: { bookAt: now + seconds * 1000, features: { ofi: 0.5, cvd: 0.5, bookImbalance: 0.5 } }, ...extra });

test('passive capture preserves cash and records only the first entry of each market', () => {
  const initial = newAccount({ bankroll: 100, at: now });
  const captured = captureStudyEntry(initial, position());
  assert.equal(initial.exitStudy, undefined);
  assert.equal(captured.cash, 100);
  near(captured.exitStudy.trials[0].costCents, 42);
  assert.equal(captureStudyEntry(captured, position({ openedAt: now + 50000, side: 'down' })), captured);
  assert.equal(captured.position, null);
  const legacy = { ...initial, trades: [{ ticker: 'T', openedAt: now - 10000 }] };
  assert.equal(captureStudyEntry(legacy, position()), legacy, 'mid-market redeploy cannot invent a first entry');
});

test('actual exits and official outcomes are paired without adding hypothetical profit to cash', () => {
  let account = captureStudyEntry(newAccount({ bankroll: 100, at: now }), position());
  const other = recordStudyExit(account, { ...position(), openedAt: now + 10000, profit: 99, at: now + 20000 });
  assert.equal(other, account);
  account = recordStudyExit(account, { ...position(), profit: -1, at: now + 20000, reason: 'cut' });
  const premature = settleExitStudy(account, { T: { result: 'yes' } }, { now: now + 10000 });
  assert.equal(premature, account);
  assert.deepEqual(pendingStudyTickers(account, now + 300000), ['T']);
  const missing = settleExitStudy(account, { T: { price: 999999, result: '' } }, { now: now + 400000 });
  assert.equal(missing, account);
  const settled = settleExitStudy(account, { T: { result: 'yes' } }, { now: now + 400000 });
  const summary = exitStudySummary(settled);
  assert.equal(summary.matchedMarkets, 1);
  assert.equal(summary.actualProfitDollars, -0.1);
  assert.equal(summary.holdProfitDollars, 0.58);
  assert.equal(settled.cash, 100);
  assert.deepEqual(pendingStudyTickers(settled, now + 400000), []);
  assert.equal(settleExitStudy(settled, { T: { result: 'yes' } }, { now: now + 500000 }), settled);
});

test('DOWN shadow payout follows the exact official result, not local BTC or another ticker', () => {
  const a = captureStudyEntry(newAccount({ at: now }), position({ side: 'down' }));
  const wrong = settleExitStudy(a, { OTHER: { result: 'no' } }, { now: now + 400000 });
  assert.equal(wrong, a);
  near(settleExitStudy(a, { T: { result: 'yes' } }, { now: now + 400000 }).exitStudy.trials[0].holdProfitCents, -42);
  near(settleExitStudy(a, { T: { result: 'no' } }, { now: now + 400000 }).exitStudy.trials[0].holdProfitCents, 58);
});

test('paper entry and settlement populate the study through the actual engine path', () => {
  const input = { prices: Array.from({ length: 120 }, (_, i) => 80000 + Math.sin(i) * 15),
    spot: 80000, strike: 80000, secondsLeft: 400, now, sourceAt: now - 1000,
    feedVersion: 'brti-latest-v2', marketPriceCents: 40.5,
    market: { ticker: 'T', close_time: new Date(now + 400000).toISOString(), yes_bid: 40,
      yes_ask: 41, yes_ask_size: 100, liquidity_dollars: '1000', microstructure: { ofi: 0, bookComplete: true } },
    trades: [{ taker_side: 'yes', count: 30 }, { taker_side: 'no', count: 30 }] };
  const opened = paperTick(newAccount({ bankroll: 100, profile: 'scalp', at: now }), input, { now });
  assert.equal(opened.event.kind, 'enter');
  assert.equal(opened.account.exitStudy.trials.length, 1);
  const closed = paperTick(opened.account, { ...input, secondsLeft: -10 }, { now: now + 410000,
    candidates: [], officialSettlements: { T: { result: 'yes' } } });
  assert.equal(closed.event.kind, 'settled');
  const study = exitStudySummary(closed.account);
  assert.equal(study.matchedMarkets, 1);
  assert.equal(study.actualProfitDollars, study.holdProfitDollars);
});

test('a sold position is still queried for the shadow result; restart and reset retain its evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exit-study-'));
  try {
    const path = join(dir, 'store.json'); let store = createStore(path);
    let account = captureStudyEntry({ ...newAccount({ bankroll: 100, at: now }), background: true }, position());
    account = recordStudyExit(account, { ...position(), profit: -1, at: now + 20000, reason: 'cut' });
    store.putPaperAccounts({ scalp: account }); store = createStore(path);
    const queried = [];
    const result = await sweepPaper(null, store, { picks: { kalshi: { enabled: true, seriesTicker: 'BTC' } } }, {
      now: now + 400000, openBoard: async () => ({ contracts: [] }),
      fetchSpotPrice: async () => ({ price: 80000 }), fetchMarket: async (_, ticker) => {
        queried.push(ticker); return { market: { ticker, result: 'yes', status: 'settled' } };
      },
    });
    assert.equal(result.ran, true);
    assert.deepEqual(queried, ['T']);
    store = createStore(path);
    assert.equal(exitStudySummary(store.paperAccounts().scalp).matchedMarkets, 1);
    assert.equal(store.paperAccounts().scalp.cash, 100);
    const summary = paperSummary(store.paperAccounts())[0];
    assert.equal(summary.exitStudy.holdProfitDollars, 0.58);
    const accounts = store.paperAccounts(); accounts.scalp.exitStudy.trials[0].privateKey = 'never exported';
    store.putPaperAccounts(accounts);
    assert.ok(!JSON.stringify(researchExport(store)).includes('never exported'));
    store.putPaperAccounts({ scalp: newAccount({ profile: 'scalp', at: now + 500000 }) });
    const exported = researchExport(createStore(path));
    assert.equal(exported.archivedRuns[0].profiles.scalp.exitStudy.matchedMarkets, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('target exits execute on the next book, so a target observation can still lose money', () => {
  const trade = { ...position(), entryEvidence: { features: { secondsLeft: 300 } } };
  const result = replayExit(trade, [quote(30, 60), quote(60, 45)], 'target_10', { outcome: 1 });
  assert.equal(result.decisionAt, now + 30000);
  assert.equal(result.closedAt, now + 60000);
  near(result.profitCents, -1);
});

test('unobserved executions and missing official results never become fabricated profits', () => {
  const trade = { ...position(), entryEvidence: { features: { secondsLeft: 300 } } };
  const missing = replayExit(trade, [quote(30, 60), quote(100, 60)], 'target_10', { outcome: 1 });
  assert.equal(missing.profitCents, null);
  assert.equal(missing.reason, 'exit execution not observed');
  assert.equal(replayExit(trade, [], 'settle').profitCents, null);
  near(replayExit(trade, [quote(30, 60)], 'settle', { outcome: 0 }).profitCents, -43);
});

test('future labels cannot select an exit price or change the policy selected on earlier files', () => {
  const training = { exportedAt: now + 500000, profiles: { careful: { trades: [] } }, observations: [] };
  for (let i = 0; i < 25; i += 1) {
    const ticker = 'OLD' + i;
    training.profiles.careful.trades.push({ ...position({ ticker }), at: now + 90000, profit: -1, reason: 'cut',
      entryEvidence: { features: { secondsLeft: 300 } } });
    training.observations.push(...[quote(30, 60), quote(60, 45), quote(120, 45), quote(150, 45)]
      .map((r) => ({ ...r, ticker, outcome: 1, outcomeSource: 'kalshi-market:official-result',
        evidence: { ...r.evidence, features: { ofi: -0.5, cvd: -0.5, bookImbalance: -0.5 } } })));
  }
  const later = { exportedAt: now + 2000000, profiles: { careful: { trades: [{ ...position({ ticker: 'NEW', openedAt: now + 600000 }),
    at: now + 700000, profit: -1, reason: 'cut', entryEvidence: { features: { secondsLeft: 300 } } }] } },
    observations: [{ ...quote(650, 60), ticker: 'NEW', secondsLeft: 250, outcome: 0, outcomeSource: 'kalshi-market:official-result' }] };
  const first = compareExitPolicies([training], later);
  const changed = structuredClone(later); changed.observations[0].outcome = 1;
  const second = compareExitPolicies([training], changed);
  assert.equal(first.profiles.careful.selectedOnTraining, 'settle');
  assert.equal(second.profiles.careful.selectedOnTraining, first.profiles.careful.selectedOnTraining);
  assert.deepEqual(second.profiles.careful.training, first.profiles.careful.training);
  assert.equal(first.profiles.careful.later.entries, 1);
  assert.equal(first.profiles.careful.promoted, false);
  assert.throws(() => compareExitPolicies([later], training));
});

test('entry hypotheses require measured flow and do not count missing values as confirmation', () => {
  const trade = { ...position(), entryEvidence: { features: { ofi: 0.6, cvd: null, bookImbalance: 0.7 } } };
  assert.equal(entryEligible(trade, 'flow_aligned'), false);
  trade.entryEvidence.features.cvd = 0.8;
  assert.equal(entryEligible(trade, 'flow_aligned'), true);
  assert.equal(entryEligible({ ...trade, side: 'down' }, 'flow_aligned'), false);
  assert.equal(entryEligible(trade, 'edge_6'), false);
});
