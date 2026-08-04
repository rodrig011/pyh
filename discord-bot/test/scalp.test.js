import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCALP_ACTIONS,
  minimumProfitableMoveCents,
  roundTripCostCents,
  roundTripReturn,
  scalpDecision,
  tripsSupported,
} from '../src/signals/scalp.js';

// Trading the same market four times is four times the compounding at the same
// size — and the reason nobody should do it blindly is priced in here.

test('the exchange is paid on the way in and on the way out', () => {
  // Both legs, always. This is the cost most scalping advice never mentions.
  assert.ok(roundTripCostCents(65, 65) > 0);
  assert.ok(roundTripCostCents(50, 50) >= roundTripCostCents(10, 10));

  // The fee peaks at 50c, but it is rounded up to the cent per contract, so
  // for a single contract the difference between a mid trip and an extreme one
  // mostly disappears. Worth knowing before optimising for it.
  assert.ok(roundTripCostCents(20, 80) <= roundTripCostCents(45, 55));
});

test('a small swing is a losing trade that looks like a winning one', () => {
  const big = roundTripReturn(65, 85);
  const small = roundTripReturn(65, 67);

  assert.ok(big.netCents > 15);
  assert.ok(big.percent > 25);

  // Two cents of "profit" on a screen that ignores fees. It is a loss.
  assert.equal(small.worthTaking, false);
  assert.ok(small.netCents < 0);
});

test('the minimum profitable move is about five cents at mid prices', () => {
  for (const entry of [30, 45, 60, 75]) {
    const needed = minimumProfitableMoveCents(entry);
    assert.ok(needed >= 3 && needed <= 7, `entry ${entry} needed ${needed}`);
  }
});

test('a market only supports as many trips as its movement can fund', () => {
  // A market that swings 25c can pay for a handful of round trips.
  assert.ok(tripsSupported(25, 50) >= 4);
  // One that barely moves cannot pay for even one.
  assert.equal(tripsSupported(3, 50), 0);
});

const edge = (verdict, edgeCents) => ({ verdict, edgeCents });

test('entry needs an edge bigger than the round trip, not just an edge', () => {
  const thin = scalpDecision({
    position: null,
    nowCents: 50,
    signal: edge('up', 4),
    secondsLeft: 600,
  });
  const real = scalpDecision({
    position: null,
    nowCents: 50,
    signal: edge('up', 12),
    secondsLeft: 600,
  });

  // Four cents of edge is a real edge and still not a trade.
  assert.equal(thin.action, SCALP_ACTIONS.WAIT);
  assert.match(thin.reason, /round trip/);
  assert.equal(real.action, SCALP_ACTIONS.ENTER);
  assert.equal(real.side, 'up');
});

test('nothing is opened with no room left for a round trip', () => {
  const late = scalpDecision({
    position: null,
    nowCents: 50,
    signal: edge('up', 20),
    secondsLeft: 60,
  });

  assert.equal(late.action, SCALP_ACTIONS.WAIT);
  assert.match(late.reason, /bell/);
});

test('a banked swing is taken once the edge is gone', () => {
  const call = scalpDecision({
    position: { entryCents: 65, side: 'up' },
    nowCents: 85,
    signal: edge('up', 0.5),
    secondsLeft: 400,
  });

  assert.equal(call.action, SCALP_ACTIONS.EXIT);
  assert.equal(call.reason, 'move banked');
  assert.ok(call.trip.percent > 25);
});

test('a winner is held while the model still likes it', () => {
  const call = scalpDecision({
    position: { entryCents: 65, side: 'up' },
    nowCents: 78,
    signal: edge('up', 9),
    secondsLeft: 400,
  });

  assert.equal(call.action, SCALP_ACTIONS.WAIT);
  assert.equal(call.reason, 'holding');
});

test('the model changing its mind ends the position, profit or not', () => {
  const call = scalpDecision({
    position: { entryCents: 65, side: 'up' },
    nowCents: 58,
    signal: edge('down', 11),
    secondsLeft: 400,
  });

  // Holding a position the model has stopped believing in is how a scalp
  // becomes a bag.
  assert.equal(call.action, SCALP_ACTIONS.EXIT);
  assert.equal(call.reason, 'model flipped');
});

test('a position is never carried into the bell', () => {
  const call = scalpDecision({
    position: { entryCents: 65, side: 'up' },
    nowCents: 70,
    signal: edge('up', 15),
    secondsLeft: 30,
  });

  // It was sized as a scalp, not as a settlement bet.
  assert.equal(call.action, SCALP_ACTIONS.EXIT);
  assert.equal(call.reason, 'bell');
});

test('a losing position the model no longer defends is cut', () => {
  const call = scalpDecision({
    position: { entryCents: 65, side: 'up' },
    nowCents: 55,
    signal: edge('up', 1),
    secondsLeft: 400,
  });

  assert.equal(call.action, SCALP_ACTIONS.EXIT);
  assert.equal(call.reason, 'cut');
  assert.ok(call.trip.netCents < 0);
});

test('no price is a wait, never a guess', () => {
  assert.equal(scalpDecision({ nowCents: null, signal: edge('up', 20), secondsLeft: 500 }).action, SCALP_ACTIONS.WAIT);
  assert.equal(scalpDecision({ nowCents: 0, signal: edge('up', 20), secondsLeft: 500 }).action, SCALP_ACTIONS.WAIT);
});

test('the live alert leads with what to do, because it is read on a lock screen', async () => {
  const { liveMessage } = await import('../src/bots/signalBot.js');

  const enter = liveMessage('enter', {
    entry: {
      asset: 'BTC',
      ticker: 'KXBTC15M-X',
      result: { probability: 0.71, edgeCents: 11, flipProbability: 0.22 },
    },
    call: { nowCents: 60, side: 'up', needed: 5 },
    sizing: { suggested: 0.042 },
  });

  assert.match(enter.content, /IN NOW/);
  assert.match(enter.content, /BTC UP @ 60%/);
  assert.match(enter.content, /4.2% of bankroll/);
  // The reasoning is underneath, not in the notification.
  assert.match(JSON.stringify(enter.embeds[0]), /71%/);
  assert.match(JSON.stringify(enter.embeds[0]), /round trip/);
});

test('the exit alert states the net, never the gross', async () => {
  const { liveMessage } = await import('../src/bots/signalBot.js');

  const exit = liveMessage('exit', {
    entry: { asset: 'BTC', ticker: 'KXBTC15M-X', result: {} },
    call: {
      nowCents: 85,
      reason: 'move banked',
      trip: { grossCents: 20, feeCents: 3, netCents: 17, percent: 26.2 },
    },
    position: { entryCents: 65 },
  });

  assert.match(exit.content, /OUT NOW/);
  // The headline number is after fees. A room told the gross is being flattered.
  assert.match(exit.content, /\+26\.2%\*\* net of fees/);
  assert.match(JSON.stringify(exit.embeds[0]), /fees \*\*3\.0¢\*\*/);
  assert.match(JSON.stringify(exit.embeds[0]), /the move is paid for/);
});

test('a losing exit says so plainly', async () => {
  const { liveMessage } = await import('../src/bots/signalBot.js');

  const exit = liveMessage('exit', {
    entry: { asset: 'BTC', ticker: 'X', result: {} },
    call: { nowCents: 55, reason: 'cut', trip: { grossCents: -10, feeCents: 3, netCents: -13, percent: -20 } },
    position: { entryCents: 65 },
  });

  assert.match(exit.content, /❌/);
  assert.match(exit.content, /-20\.0%/);
  assert.match(JSON.stringify(exit.embeds[0]), /stopped defending/);
});
