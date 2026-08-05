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

// A signal shaped the way the engine actually emits one. `probability` is
// always the chance of finishing ABOVE the strike — never the chance the side
// being held wins — and keeping that straight is the whole point of several
// tests below.
const edge = (verdict, edgeCents, probability = null) => ({ verdict, edgeCents, probability });

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

test('a banked swing is taken once the price has caught up with the model', () => {
  const call = scalpDecision({
    position: { entryCents: 65, side: 'up' },
    nowCents: 85,
    // The model says 85 and the contract costs 85. There is nothing left.
    signal: edge('up', 0.5, 0.85),
    secondsLeft: 400,
  });

  assert.equal(call.action, SCALP_ACTIONS.EXIT);
  assert.equal(call.reason, 'move banked');
  assert.ok(call.trip.percent > 25);
});

test('a winner is held while the model still prices it above the market', () => {
  const call = scalpDecision({
    position: { entryCents: 65, side: 'up' },
    nowCents: 78,
    signal: edge('up', 9, 0.87),
    secondsLeft: 400,
  });

  assert.equal(call.action, SCALP_ACTIONS.WAIT);
  assert.equal(call.reason, 'holding');
});

test('silence from the engine is not a reason to sell', () => {
  // The engine skips a market whenever the edge falls under its ENTRY
  // threshold, which is most ticks of most markets. Reading that as "get out"
  // made every position a guaranteed round trip that captured nothing and paid
  // two fees — in the paper runs it was every single trade, and it turned a
  // known six-cent edge into a 70% loss.
  const call = scalpDecision({
    position: { entryCents: 65, side: 'up' },
    nowCents: 72,
    signal: { verdict: 'skip', reason: 'no_edge', probability: 0.74 },
    secondsLeft: 400,
  });

  assert.equal(call.action, SCALP_ACTIONS.WAIT);
  assert.equal(call.reason, 'holding');
});

test('a DOWN position is judged on the odds that DOWN wins', () => {
  // The model's probability is the chance of finishing above the strike, so a
  // DOWN position is doing well when that number is LOW. Comparing the raw
  // probability against the price sells every winning down position.
  const winning = scalpDecision({
    position: { entryCents: 45, side: 'down' },
    // NO trades at 70, and the model says NO is worth 80.
    nowCents: 70,
    signal: edge('down', 10, 0.2),
    secondsLeft: 400,
  });

  assert.equal(winning.action, SCALP_ACTIONS.WAIT);
  assert.ok(winning.favoured > 0);
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

test('a position the model has turned against is sold before the bell', () => {
  const call = scalpDecision({
    position: { entryCents: 65, side: 'up' },
    nowCents: 70,
    // The contract costs 70 and the model says it is worth 65.
    signal: edge('up', 15, 0.65),
    secondsLeft: 30,
  });

  assert.equal(call.action, SCALP_ACTIONS.EXIT);
  assert.equal(call.reason, 'bell');
});

test('a position the model still likes is settled, not sold', () => {
  // Settlement is the one exit the exchange does not charge for. Selling at
  // 70 costs a fee; letting it settle costs nothing and pays the same on
  // average. "Always flatten before expiry" is advice from venues that do not
  // charge per leg, and following it here gives away a fee on every trade.
  const liked = scalpDecision({
    position: { entryCents: 65, side: 'up' },
    nowCents: 70,
    signal: edge('up', 15, 0.8),
    secondsLeft: 30,
  });

  assert.equal(liked.action, SCALP_ACTIONS.WAIT);
  assert.equal(liked.reason, 'settling');

  // And with no read at all — which is what the engine returns this close to
  // the bell — the contract's own price is the best estimate of what it
  // settles at, so the fee is the only difference and holding still wins.
  const blind = scalpDecision({
    position: { entryCents: 65, side: 'up' },
    nowCents: 70,
    signal: { verdict: 'skip', reason: 'too_late' },
    secondsLeft: 30,
  });

  assert.equal(blind.action, SCALP_ACTIONS.WAIT);
  assert.equal(blind.reason, 'settling');
});

test('a losing position the model no longer defends is cut', () => {
  const call = scalpDecision({
    position: { entryCents: 65, side: 'up' },
    nowCents: 55,
    signal: edge('up', 1, 0.55),
    secondsLeft: 400,
  });

  assert.equal(call.action, SCALP_ACTIONS.EXIT);
  assert.equal(call.reason, 'cut');
  assert.ok(call.trip.netCents < 0);
});

test('a loser the model still defends is held, not cut at the bottom', () => {
  const call = scalpDecision({
    position: { entryCents: 65, side: 'up' },
    nowCents: 55,
    signal: edge('up', 12, 0.67),
    secondsLeft: 400,
  });

  assert.equal(call.action, SCALP_ACTIONS.WAIT);
  assert.equal(call.reason, 'holding');
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

test('an automatic stop is OFF, because measuring it showed it destroys the edge', () => {
  // The obvious answer to a 95% loss, and the wrong one on this instrument.
  // Across six seeds in a six-cent mispriced market: +68% with no stop, −58%
  // with a stop at −35%. The price of a binary IS a probability and
  // probabilities rebound, so cutting means closing the ones about to recover
  // and paying to re-enter.
  //
  // It still gets flagged, so a human can override on any single trade.
  const call = scalpDecision({
    position: { entryCents: 28, side: 'up' },
    nowCents: 15,
    signal: edge('up', 20, 0.9),
    secondsLeft: 400,
  });

  assert.equal(call.action, SCALP_ACTIONS.WAIT);
  assert.equal(call.deeplyDown, true, 'held, but the holder is told');
});

test('the stop can be switched on by anyone who wants it', () => {
  // The failure that cost real money: a position ran from 28% to 4%, a 95%
  // loss, while the model insisted the whole way down that the side was worth
  // more than it cost. The cut rule asked the model first, the model kept
  // defending, and it never fired.
  //
  // That is not a rare failure. "The model still likes it" is exactly what a
  // wrong model says. A stop that can be argued with is not a stop.
  const call = scalpDecision(
    {
      position: { entryCents: 28, side: 'up' },
      nowCents: 15,
      // The model is enthusiastic. It is also wrong, and with the stop on it
      // does not get a vote.
      signal: edge('up', 20, 0.9),
      secondsLeft: 400,
    },
    { maximumLossPercent: 35 },
  );

  assert.equal(call.action, SCALP_ACTIONS.EXIT);
  assert.equal(call.reason, 'stop loss');
});

test('the stop outranks holding to settlement', () => {
  // Settlement is free and that is a real saving — but a position already down
  // two thirds is not something to carry to expiry because the exit is cheap.
  const call = scalpDecision(
    {
      position: { entryCents: 28, side: 'up' },
      nowCents: 8,
      signal: edge('up', 15, 0.85),
      secondsLeft: 30,
    },
    { maximumLossPercent: 35 },
  );

  assert.equal(call.action, SCALP_ACTIONS.EXIT);
  assert.equal(call.reason, 'stop loss');
});

test('an ordinary drawdown is still allowed to breathe', () => {
  // The stop must not fire on noise, or it becomes a machine for locking in
  // small losses. Down about a fifth, model still behind it: hold.
  const call = scalpDecision({
    position: { entryCents: 50, side: 'up' },
    nowCents: 44,
    signal: edge('up', 12, 0.62),
    secondsLeft: 400,
  });

  assert.equal(call.action, SCALP_ACTIONS.WAIT);
});

test('the worst case is bounded by the stop, whatever the model says', () => {
  // Walking a position down one point at a time with a model that never stops
  // defending it. Something has to fire, and well before it is worthless.
  let firedAt = null;
  for (let price = 27; price >= 1; price -= 1) {
    const call = scalpDecision(
      {
        position: { entryCents: 28, side: 'up' },
        nowCents: price,
        signal: edge('up', 20, 0.95),
        secondsLeft: 400,
      },
      { maximumLossPercent: 35 },
    );
    if (call.action === SCALP_ACTIONS.EXIT) {
      firedAt = price;
      break;
    }
  }

  assert.ok(firedAt !== null, 'it never fired at all');
  assert.ok(firedAt >= 15, `only fired at ${firedAt}%, which is most of the money gone`);
});
