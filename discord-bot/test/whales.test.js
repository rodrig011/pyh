import test from 'node:test';
import assert from 'node:assert/strict';

import { FLIP_RISK, fetchTrades, flipRisk, orderFlowSummary, whaleActivity, whaleLine } from '../src/picks/whales.js';
import {
  alertMessage,
  rememberAlert,
  shouldAlert,
  shouldAlertWhale,
  signalPanelAction,
  signalPanelMessage,
  whaleAlertMessage,
} from '../src/picks/signalPanel.js';

/**
 * There was already a `largePrints` in the indicators and it had never been
 * handed a single trade — every call site passed an empty array. It computed a
 * lean from nothing and reported zero, forever. The whale reading was
 * decoration. This reads the exchange's own tape.
 */

const trade = (count, side, price = 50, at = '2026-01-01T00:10:00Z') => ({
  count,
  taker_side: side,
  yes_price: price,
  created_time: at,
});

test('only prints big enough to be size are counted', () => {
  const whales = whaleActivity([trade(900, 'yes'), trade(3, 'yes'), trade(11, 'no')]);
  assert.equal(whales.count, 1);
  assert.equal(whales.yesContracts, 900);
  assert.equal(whales.noContracts, 0);
  // Every trade is still reported, so "quiet tape" and "busy tape with no size"
  // can be told apart.
  assert.equal(whales.trades, 3);
});

test('the aggressor is what counts, not the resting order', () => {
  // A resting order that got hit was not making a statement. The order that
  // reached across the spread was.
  const whales = whaleActivity([trade(400, 'no'), trade(400, 'yes')]);
  assert.equal(whales.lean, 0, 'equal size both ways cancels');
  assert.equal(whales.contracts, 800);
});

test('whales leaning one way produce a lean towards that side', () => {
  const whales = whaleActivity([trade(1000, 'yes'), trade(250, 'no')]);
  assert.ok(whales.lean > 0.5);
  assert.match(whaleLine(whales), /leaning UP/);
});

test('a trade with no side is not evidence and is dropped', () => {
  const whales = whaleActivity([{ count: 900, created_time: '2026-01-01T00:10:00Z' }]);
  assert.equal(whales.count, 0);
});

test('an empty tape reads as no size rather than as agreement', () => {
  const whales = whaleActivity([]);
  assert.equal(whales.count, 0);
  assert.equal(whales.lean, 0);
  assert.equal(whaleLine(whales), null);
});

test('notional is what makes a whale mean something to a person', () => {
  const whales = whaleActivity([trade(1000, 'yes', 40)]);
  assert.equal(Math.round(whales.notionalDollars), 400);
  assert.match(whaleLine(whales), /\$400/);
});

// orderFlowSummary: the dashboard's order-flow panel. Every print counts here,
// not just whale-sized ones -- this is a picture of the whole tape.

test('yes and no flow are dollars, not raw contract counts', () => {
  const now = Date.parse('2026-01-01T00:10:30Z');
  const flow = orderFlowSummary(
    [trade(100, 'yes', 60, '2026-01-01T00:10:00Z'), trade(50, 'no', 40, '2026-01-01T00:10:10Z')],
    { now },
  );

  assert.equal(flow.yesDollars, 60);
  assert.equal(flow.noDollars, 20);
  assert.equal(flow.netDollars, 40);
  assert.equal(flow.trades, 2);
});

test('dominance is null on an empty tape, not zero pretending to be a reading', () => {
  const flow = orderFlowSummary([], { now: Date.now() });
  assert.equal(flow.yesDominance, null);
  assert.equal(flow.netDollars, 0);
});

test('dominance leans toward whichever side actually paid more', () => {
  const now = Date.parse('2026-01-01T00:10:30Z');
  const flow = orderFlowSummary(
    [trade(900, 'yes', 50, '2026-01-01T00:10:00Z'), trade(100, 'no', 50, '2026-01-01T00:10:10Z')],
    { now },
  );
  assert.ok(flow.yesDominance > 0.8);
});

test('a trade outside the window does not count toward flow', () => {
  const now = Date.parse('2026-01-01T00:10:30Z');
  const flow = orderFlowSummary(
    [
      trade(500, 'yes', 50, '2026-01-01T00:00:00Z'), // 10m30s ago -- outside a 60s window
      trade(10, 'no', 50, '2026-01-01T00:10:20Z'),
    ],
    { now, windowMs: 60_000 },
  );
  assert.equal(flow.yesDollars, 0);
  assert.equal(flow.trades, 1);
});

test('the largest single print on each side is reported', () => {
  const now = Date.parse('2026-01-01T00:10:30Z');
  const flow = orderFlowSummary(
    [
      trade(10, 'yes', 50, '2026-01-01T00:10:00Z'),
      trade(400, 'yes', 50, '2026-01-01T00:10:05Z'),
      trade(50, 'no', 50, '2026-01-01T00:10:10Z'),
    ],
    { now },
  );
  assert.equal(flow.largestYesDollars, 200);
  assert.equal(flow.largestNoDollars, 25);
});

test('recent trades come back newest first, capped', () => {
  const now = Date.parse('2026-01-01T00:10:30Z');
  const many = Array.from({ length: 25 }, (_, i) =>
    trade(10, 'yes', 50, new Date(Date.parse('2026-01-01T00:10:00Z') + i * 1000).toISOString()),
  );
  const flow = orderFlowSummary(many, { now, windowMs: 60_000 });
  assert.equal(flow.recent.length, 20);
  assert.ok(flow.recent[0].at > flow.recent[1].at, 'newest first');
});

test('flip risk combines the arithmetic with the pressure', () => {
  const whales = whaleActivity([trade(2000, 'no')]);
  const risk = flipRisk({ side: 'up', flipProbability: 0.55, whales, secondsLeft: 400 });
  assert.equal(risk.level, FLIP_RISK.HIGH);
  assert.ok(risk.reasons.length >= 2);
});

test('size on YOUR side is not counted as a risk', () => {
  const whales = whaleActivity([trade(2000, 'yes')]);
  const withFlow = flipRisk({ side: 'up', flipProbability: 0.35, whales, secondsLeft: 400 });
  const without = flipRisk({ side: 'up', flipProbability: 0.35, whales: null, secondsLeft: 400 });
  assert.ok(withFlow.score < without.score);
});

test('a flip needs a side to lose — with no position it is information', () => {
  const whales = whaleActivity([trade(2000, 'no')]);
  const risk = flipRisk({ side: null, flipProbability: 0.2, whales, secondsLeft: 400 });
  assert.equal(risk.level, FLIP_RISK.NONE);
});

test('close to the bell there is less room for it to turn', () => {
  const whales = whaleActivity([trade(2000, 'no')]);
  const early = flipRisk({ side: 'up', flipProbability: 0.55, whales, secondsLeft: 400 });
  const late = flipRisk({ side: 'up', flipProbability: 0.55, whales, secondsLeft: 30 });
  assert.ok(late.score < early.score);
});

test('a tape that is down costs the whale reading, not the signal', async () => {
  const result = await fetchTrades({}, 'KXBTC-1', {
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.deepEqual(result.trades, []);
  assert.match(result.error, /503/);
});

test('trades are read from the ticker asked for', async () => {
  let seen = null;
  await fetchTrades({}, 'KXBTC-65000', {
    fetchImpl: async (url) => {
      seen = url;
      return { ok: true, json: async () => ({ trades: [] }) };
    },
  });
  assert.match(seen, /ticker=KXBTC-65000/);
});

/** The bar to interrupt a room is higher than the bar to answer a question. */

const goodRead = { tradeable: true, netEdgeCents: 6, call: 'up', entryCents: 44, winProbability: 0.6 };

test('a signal the engine would not take never interrupts anyone', () => {
  const decision = shouldAlert({ tradeable: false, netEdgeCents: 9 }, { ticker: 'T' });
  assert.equal(decision.alert, false);
});

test('a thin edge does not earn a notification even when it is a trade', () => {
  const decision = shouldAlert({ ...goodRead, netEdgeCents: 1.2 }, { ticker: 'T' });
  assert.equal(decision.alert, false);
  assert.match(decision.reason, /thin/);
});

test('one alert per contract, ever — announcing twice is entering twice', () => {
  const first = shouldAlert(goodRead, { ticker: 'T', alerts: {}, now: 1_000_000 });
  assert.equal(first.alert, true);

  const alerts = rememberAlert({}, { ticker: 'T', now: 1_000_000 });
  const second = shouldAlert(goodRead, { ticker: 'T', alerts, now: 5_000_000 });
  assert.equal(second.alert, false);
  assert.match(second.reason, /already/);
});

test('a floor between alerts stops a volatile hour flooding the room', () => {
  const alerts = rememberAlert({}, { ticker: 'A', now: 1_000_000 });
  const soon = shouldAlert(goodRead, { ticker: 'B', alerts, now: 1_060_000 });
  assert.equal(soon.alert, false);

  const later = shouldAlert(goodRead, { ticker: 'B', alerts, now: 1_000_000 + 4 * 60_000 });
  assert.equal(later.alert, true);
});

test('whales that disagree are a market, not an alert', () => {
  const whales = whaleActivity([trade(1000, 'yes'), trade(1000, 'no')]);
  assert.equal(shouldAlertWhale(whales, { ticker: 'T' }).alert, false);
});

test('a whale alert needs real size, not merely a lean', () => {
  const small = whaleActivity([trade(300, 'yes')]);
  assert.equal(shouldAlertWhale(small, { ticker: 'T' }).alert, false);

  const big = whaleActivity([trade(4000, 'yes')]);
  assert.equal(shouldAlertWhale(big, { ticker: 'T' }).alert, true);
});

test('the whale alert says outright that it is not a trade call', () => {
  const whales = whaleActivity([trade(4000, 'no', 30)]);
  const text = whaleAlertMessage({ whales, ticker: 'T', strike: 65_000 });
  assert.match(text, /not\*\* calling this a trade/);
  assert.match(text, /DOWN/);
});

test('the alert leads with the trade and carries the flip warning', () => {
  const whales = whaleActivity([trade(2000, 'no')]);
  const risk = flipRisk({ side: 'up', flipProbability: 0.6, whales, secondsLeft: 400 });
  const text = alertMessage({ read: goodRead, ticker: 'T', strike: 65_000, whales, risk });

  assert.match(text.split('\n')[0], /BUY UP @ 44%/);
  assert.match(text, /HIGH FLIP RISK/);
  // And the thing that stops people panicking out of a winner.
  assert.match(text, /roughly twice/);
});

test('the alert memory stays bounded, since tickers roll all day', () => {
  let alerts = {};
  for (let i = 0; i < 400; i += 1) {
    alerts = rememberAlert(alerts, { ticker: `T-${i}`, now: 1_000_000 + i });
  }
  assert.ok(Object.keys(alerts.seen).length <= 300);
});

/** The panel reports the record; it never promises one. */

test('the panel shows the measured record with its sample size', () => {
  const { embeds } = signalPanelMessage({ record: { wins: 7, settled: 10 } });
  const text = embeds[0].data.description;
  assert.match(text, /7W 3L — 70%/);
  // A 70% record over ten calls is not a 70% record, and the panel says so.
  assert.match(text, /noise, not a track record/);
});

test('a real sample loses the noise warning', () => {
  const { embeds } = signalPanelMessage({ record: { wins: 40, settled: 60 } });
  assert.doesNotMatch(embeds[0].data.description, /noise, not a track record/);
});

test('no settled calls is stated, not padded out', () => {
  const { embeds } = signalPanelMessage({});
  assert.match(embeds[0].data.description, /No settled calls yet/);
});

test('panel buttons are recognised, and other buttons are left alone', () => {
  const { components } = signalPanelMessage({});
  const ids = components[0].components.map((button) => button.data.custom_id);
  for (const id of ids) assert.ok(signalPanelAction(id));
  assert.equal(signalPanelAction('pick:panel:cash_out'), null);
  assert.equal(signalPanelAction(undefined), null);
});

/**
 * The calls in a direct message, for whoever asked.
 *
 * Opt-in and per person: a channel post is for the room, a DM is a phone
 * buzzing in somebody's pocket, and those need different consent.
 */

import {
  DM_FAILURE_LIMIT,
  dmAlertMessage,
  isSubscribed,
  noteDmFailure,
  noteDmSuccess,
  subscribeDm,
  unsubscribeDm,
} from '../src/picks/signalPanel.js';

test('nobody is subscribed by being present', () => {
  assert.equal(isSubscribed({}, 'u1'), false);
  assert.equal(isSubscribed(undefined, 'u1'), false);
});

test('subscribing and unsubscribing is per person', () => {
  let subs = subscribeDm({}, 'u1');
  subs = subscribeDm(subs, 'u2');
  assert.equal(isSubscribed(subs, 'u1'), true);

  subs = unsubscribeDm(subs, 'u1');
  assert.equal(isSubscribed(subs, 'u1'), false);
  assert.equal(isSubscribed(subs, 'u2'), true, 'one person leaving does not remove another');
});

test('a closed inbox is dropped after a few tries, not retried forever', () => {
  // Retrying every alert for the rest of the month costs a write and a log line
  // each time while helping nobody.
  let subs = subscribeDm({}, 'u1');
  for (let i = 0; i < DM_FAILURE_LIMIT - 1; i += 1) {
    subs = noteDmFailure(subs, 'u1');
    assert.equal(isSubscribed(subs, 'u1'), true, 'one failure is usually Discord, not the person');
  }
  subs = noteDmFailure(subs, 'u1');
  assert.equal(isSubscribed(subs, 'u1'), false);
});

test('a success clears the count, so an outage does not accumulate', () => {
  let subs = subscribeDm({}, 'u1');
  subs = noteDmFailure(subs, 'u1');
  subs = noteDmSuccess(subs, 'u1');
  subs = noteDmFailure(subs, 'u1');
  subs = noteDmFailure(subs, 'u1');
  assert.equal(isSubscribed(subs, 'u1'), true);
});

test('failures against somebody who never subscribed change nothing', () => {
  assert.deepEqual(noteDmFailure({}, 'ghost'), {});
});

test('the DM says how to stop, every time', () => {
  const text = dmAlertMessage('🟢 **BUY UP @ 44%**');
  assert.match(text, /BUY UP @ 44%/);
  assert.match(text, /picks dm on:False/);
});

test('the panel carries the button members press to subscribe', () => {
  const { components } = signalPanelMessage({});
  const labels = components[0].components.map((button) => button.data.label);
  assert.ok(labels.some((label) => /DM me the calls/.test(label)));
});
