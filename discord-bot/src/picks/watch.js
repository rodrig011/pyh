import { SCALP_ACTIONS, roundTripReturn, scalpDecision } from '../signals/scalp.js';
import { directionalRead } from '../signals/direction.js';

/**
 * Watching a position somebody actually holds, and telling them when to leave.
 *
 * The gap this closes: the engine could say "get in at 34%" and then nothing.
 * Whoever took it was left staring at a phone deciding for themselves when to
 * leave, which is the hard half — the entry is a decision made calmly with all
 * the time in the world, and the exit is made in ninety seconds while the
 * number moves.
 *
 * So the bot holds the exit. One person registers what they are in, and gets a
 * direct message the moment it is time to leave. A DM and not a channel post,
 * because an exit belongs to whoever is in the trade: posting "CASH OUT" to a
 * room where half the people never entered is noise for them and pressure on
 * everyone else.
 *
 * It fires ONCE per position. A second alert on the same trade is not more
 * helpful, it is somebody being told to sell something they already sold.
 */

/** A watch, or null if the request does not describe a real position. */
export function makeWatch({ userId, ticker, side, entryCents, at = Date.now() }) {
  if (!userId || !ticker) return null;
  if (side !== 'up' && side !== 'down') return null;
  const entry = Number(entryCents);
  if (!(entry > 0) || entry >= 100) return null;

  return { userId, ticker, side, entryCents: entry, at, alerted: false };
}

/** One watch per person per market. Re-registering updates rather than stacks. */
export function addWatch(watches, watch) {
  if (!watch) return watches ?? [];
  const others = (watches ?? []).filter(
    (existing) => !(existing.userId === watch.userId && existing.ticker === watch.ticker),
  );
  return [...others, watch];
}

export function removeWatches(watches, userId) {
  return (watches ?? []).filter((watch) => watch.userId !== userId);
}

/**
 * Drops watches whose market has long since closed.
 *
 * Without this the list grows for as long as the bot runs, and every entry in
 * it is a position somebody is being told, wrongly, that they still hold.
 */
export function pruneWatches(watches, { now = Date.now(), maxAgeMs = 2 * 60 * 60 * 1000 } = {}) {
  return (watches ?? []).filter((watch) => now - watch.at < maxAgeMs && !watch.alerted);
}

/**
 * What to say, in the two seconds somebody will spend reading it.
 *
 * The first line is the whole message. Everything after it is for the person
 * who wants to know why, after they have already acted.
 */
export function cashOutMessage({ watch, nowCents, reason, trip, action = 'cash_out', asset = 'BTC' }) {
  const side = watch.side === 'up' ? 'UP' : 'DOWN';

  if (action === 'warn') {
    const down = trip?.percent;
    return [
      `⚠️ **DOWN ${Number.isFinite(down) ? Math.abs(down).toFixed(0) : '?'}% — ${asset} ${side}**`,
      '',
      `In at **${Math.round(watch.entryCents)}%**, now **${Math.round(nowCents)}%**.`,
      '',
      'The model still likes this side, so the bot is NOT telling you to sell — ' +
        'cutting binaries at a fixed loss was measured and it turns a winning ' +
        'strategy into a losing one, because these prices rebound.',
      '**But that is also exactly what a wrong model says. Your call.**',
      '',
      '_You will still get the CASH OUT when it comes. Sent only to you._',
    ].join('\n');
  }

  if (action === 'settle') {
    return [
      `⏳ **HOLD — ${asset} ${side} @ ${Math.round(nowCents)}%**`,
      '',
      `In at **${Math.round(watch.entryCents)}%**. Do NOT sell — the model still likes this side, ` +
        'and selling costs a fee that letting it expire does not.',
      'It settles by itself. Nothing more to do.',
      '',
      '_Sent only to you._',
    ].join('\n');
  }

  const why =
    {
      'model flipped': 'the model has changed sides — do not hold this',
      bell: 'out of time, and this was never a settlement bet',
      'move banked': 'the move is paid for and the edge is gone',
      cut: 'it is bleeding and the model has stopped defending it',
    }[reason] ?? reason;

  const net = trip?.percent;
  const won = (trip?.netCents ?? 0) > 0;

  return [
    `🚨 **CASH OUT — ${asset} ${watch.side === 'up' ? 'UP' : 'DOWN'} @ ${Math.round(nowCents)}%**`,
    '',
    `In at **${Math.round(watch.entryCents)}%**, out at **${Math.round(nowCents)}%** — ${why}.`,
    Number.isFinite(net)
      ? `${won ? '💸' : '❌'} **${net >= 0 ? '+' : ''}${net.toFixed(1)}%** net of both fees.`
      : null,
    '',
    '_Sent only to you. Nobody else in the server saw this._',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Checks one watch against the live market.
 *
 * Pure: the market read is handed in, so the decision can be replayed and
 * tested without a network or a clock.
 */
export function checkWatch(watch, input, options = {}) {
  const read = directionalRead(input, options);

  // The price of the side actually held. A DOWN position is sold at the NO
  // bid, and measuring it against the YES price misreads every exit — a
  // mistake this codebase has now made twice, so it is written once here.
  const quotes = read.result?.quotes;
  if (!quotes) return { action: 'wait', reason: 'no price' };

  const nowCents = watch.side === 'up' ? quotes.yesBidCents : quotes.noBidCents;
  if (!(nowCents > 0)) return { action: 'wait', reason: 'no price' };

  const call = scalpDecision({
    position: { entryCents: watch.entryCents, side: watch.side },
    nowCents,
    signal: read.result,
    secondsLeft: input?.secondsLeft,
  });

  // "Hold to settlement" is an answer, not silence. Selling costs a fee and
  // letting it expire does not, so when the model still likes the side the
  // right move is to do nothing — and somebody watching a number move needs to
  // be TOLD to do nothing, or they will sell out of impatience and pay for it.
  if (call.reason === 'settling') {
    return { action: 'settle', reason: call.reason, nowCents };
  }

  // Deeply underwater, and the numbers say closing it is worse than holding.
  // The person holding it still gets told, once, and gets to disagree — a stop
  // measured at −58% against +68% is not a decision a bot should make for
  // somebody, and "the model still likes it" is also what a wrong model says.
  if (call.deeplyDown) {
    return { action: 'warn', reason: call.reason, nowCents, trip: call.trip };
  }

  if (call.action !== SCALP_ACTIONS.EXIT) {
    return { action: 'wait', reason: call.reason, nowCents };
  }

  return {
    action: 'cash_out',
    reason: call.reason,
    nowCents,
    trip: call.trip ?? roundTripReturn(watch.entryCents, nowCents),
  };
}

/**
 * One sweep over every watched position, DMing the ones that are done.
 *
 * Everything that can fail is caught per watch. This runs on the same process
 * that handles people's payments, and a market that returns nonsense must not
 * be able to stop it — nor may one person's closed DMs cost somebody else
 * their exit alert.
 */
export async function sweepWatches(client, store, config, deps = {}) {
  const {
    currentContract,
    fetchSpotPrice,
    now = Date.now(),
    log = { debug() {}, warn() {} },
  } = deps;

  const watches = pruneWatches(store.listWatches(), { now });
  if (watches.length === 0) {
    if (watches.length !== store.listWatches().length) store.putWatches(watches);
    return { checked: 0, alerted: 0 };
  }

  const settings = config.picks ?? {};
  const asset = settings.defaultAsset ?? 'BTC';
  let alerted = 0;

  // One market read shared by everyone watching it, rather than one per
  // person: the exchange sees a single request whether one member is in or ten.
  const seen = new Map();

  for (const watch of watches) {
    try {
      if (!seen.has(watch.ticker)) {
        const [contract, quote] = await Promise.all([
          currentContract(settings.kalshi, { ticker: watch.ticker }).catch(() => null),
          fetchSpotPrice(asset),
        ]);
        seen.set(watch.ticker, { contract, quote });
      }

      const { contract, quote } = seen.get(watch.ticker);
      if (!contract?.market || !(quote?.price > 0)) continue;

      const closesAt = Date.parse(contract.market.close_time ?? '');
      const samples = store.listSamples(asset);
      const result = checkWatch(watch, {
        prices: samples
          .filter((sample) => sample?.at >= now - 60 * 60 * 1000 && sample?.price > 0)
          .map((sample) => sample.price),
        spot: quote.price,
        strike: Number(contract.market.floor_strike ?? contract.market.cap_strike),
        marketPriceCents: contract.price,
        market: contract.market,
        secondsLeft: Number.isFinite(closesAt) ? (closesAt - now) / 1000 : null,
      });

      if (
        result.action !== 'cash_out' &&
        result.action !== 'settle' &&
        result.action !== 'warn'
      ) {
        continue;
      }

      // A warning is not the end of the position, so the watch stays live and
      // the eventual cash-out still arrives. Sending it twice would be nagging.
      if (result.action === 'warn') {
        if (watch.warned) continue;
        watch.warned = true;
      }

      const user = await client.users.fetch(watch.userId).catch(() => null);
      if (user) {
        await user
          .send(cashOutMessage({ watch, asset, ...result }))
          .catch((error) => log.warn(`Could not DM ${watch.userId}: ${error.message}`));
      }

      // Marked whether or not the DM landed. A person with DMs closed cannot
      // be reached, and retrying every few seconds for the rest of the market
      // helps nobody and floods the log.
      if (result.action !== 'warn') watch.alerted = true;
      alerted += 1;
    } catch (error) {
      log.debug(`Watch on ${watch.ticker} failed: ${error.message}`);
    }
  }

  store.putWatches(pruneWatches(watches, { now }));
  return { checked: watches.length, alerted };
}
