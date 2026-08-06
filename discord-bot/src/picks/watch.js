import { SCALP_ACTIONS, roundTripReturn, scalpDecision } from '../signals/scalp.js';
import { directionalRead } from '../signals/direction.js';
import { readBoard, nearestTheMoney } from '../signals/board.js';
import { flipRisk, whaleActivity } from './whales.js';
import {
  alertMessage,
  dmAlertMessage,
  noteDmFailure,
  noteDmSuccess,
  rememberAlert,
  shouldAlert,
  shouldAlertWhale,
  whaleAlertMessage,
} from './signalPanel.js';
import { compareReport, newAccount, paperTick, report, reportDue, equity } from './paper.js';
import { closeTimeOf } from './kalshi.js';

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

      const closesAt = closeTimeOf(contract.market);
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


/**
 * One pass of the paper account against the live market, plus the six-hourly
 * report.
 *
 * Runs on the same sweep as the exit alerts, so it sees the market exactly as
 * often as a person watching would. Never throws: this shares a process with
 * the part that handles real payments.
 */
export async function sweepPaper(client, store, config, deps = {}) {
  const {
    openBoard,
    fetchSpotPrice,
    now = Date.now(),
    log = { debug() {}, info() {} },
  } = deps;

  const settings = config.picks ?? {};
  if (!settings.kalshi?.enabled || !settings.kalshi.seriesTicker) return { ran: false };

  const accounts = store.paperAccounts();
  const running = Object.entries(accounts).filter(([, account]) => account?.userId);
  if (running.length === 0) return { ran: false };

  // One epoch per account, captured before the network call. A reset landing
  // while the request is in flight must not be undone by writing back the copy
  // fetched before it.
  const epochs = Object.fromEntries(running.map(([profile, a]) => [profile, a.epoch ?? null]));

  try {
    const asset = settings.defaultAsset ?? 'BTC';
    // The whole ladder of strikes closing in this window, not one of them.
    // Fetched ONCE and handed to every account, which is what makes running two
    // profiles a controlled experiment rather than two anecdotes: same markets,
    // same instant, same quoted prices, one difference between them.
    const [board, quote] = await Promise.all([
      openBoard(settings.kalshi, { now }).catch(() => null),
      fetchSpotPrice(asset),
    ]);

    const candidates = board?.contracts ?? [];
    if (candidates.length === 0 || !(quote?.price > 0)) return { ran: false };

    const first = candidates[0].market;
    const closesAt = closeTimeOf(first);
    const context = {
      prices: store
        .listSamples(asset)
        .filter((s) => s?.at >= now - 60 * 60 * 1000 && s?.price > 0)
        .map((s) => s.price),
      spot: quote.price,
      secondsLeft: Number.isFinite(closesAt) ? (closesAt - now) / 1000 : null,
    };

    // Re-read after the awaits, and drop any account whose epoch moved.
    const latest = store.paperAccounts();
    const stepped = {};
    const events = [];
    let userId = null;

    for (const [profile] of running) {
      const current = latest[profile];
      if (!current?.userId || (current.epoch ?? null) !== epochs[profile]) {
        log.debug(`Paper account ${profile} changed mid-sweep; dropping this tick`);
        continue;
      }
      userId = userId ?? current.userId;
      const result = paperTick(current, context, { now, candidates });
      stepped[profile] = result.account;
      if (result.event) events.push(`${profile}:${result.event.kind}`);
    }

    if (Object.keys(stepped).length === 0) return { ran: false };

    // Marks for whatever each account happens to be holding.
    const marks = {};
    for (const [profile, account] of Object.entries(stepped)) {
      if (!account.position) continue;
      marks[profile] = candidates.find((c) => c.market?.ticker === account.position.ticker)?.price ?? null;
    }

    // Both report together, on one clock. Two messages arriving separately make
    // a person do the subtraction themselves, and the subtraction is the point.
    const due = Object.values(stepped).some((account) => reportDue(account, { now }));
    if (due && userId) {
      const user = await client.users.fetch(userId).catch(() => null);
      if (user) {
        await user
          .send(compareReport(stepped, { now, marks }))
          .catch((error) => log.debug(`Paper report DM failed: ${error.message}`));
      }
      for (const profile of Object.keys(stepped)) {
        stepped[profile] = { ...stepped[profile], lastReportAt: now };
      }
    }

    // Same epoch guard on the far side of the DM, which is also a network call.
    const afterwards = store.paperAccounts();
    const merged = { ...afterwards };
    for (const [profile, account] of Object.entries(stepped)) {
      if ((afterwards[profile]?.epoch ?? null) !== epochs[profile]) continue;
      merged[profile] = account;
    }

    store.putPaperAccounts(merged, { flush: events.length > 0 || due });
    return { ran: true, event: events[0] ?? null, events, looked: candidates.length };
  } catch (error) {
    log.debug(`Paper sweep failed: ${error.message}`);
    return { ran: false };
  }
}


/**
 * One pass over the board looking for something worth interrupting a room for.
 *
 * Separate from the paper sweep and from the exit alerts, because it answers a
 * different question: not "what should this account do" but "is anything
 * happening that the people in this channel would want to know about".
 *
 * The bar is deliberately higher than the engine's own. The engine decides
 * whether a trade is worth taking; this decides whether a trade is worth a
 * notification, and those are not the same threshold. A channel that posts
 * every signal is a channel nobody reads by Wednesday.
 *
 * Never throws: this shares a process with the part that handles payments.
 */
export async function sweepSignalAlerts(client, store, config, deps = {}) {
  const {
    openBoard,
    fetchSpotPrice,
    fetchTrades,
    now = Date.now(),
    log = { debug() {}, info() {} },
  } = deps;

  const settings = config.picks ?? {};
  if (!settings.kalshi?.enabled || !settings.kalshi.seriesTicker) return { posted: 0 };

  const panel = store.signalPanel();
  if (!panel?.channelId) return { posted: 0 };

  try {
    const asset = settings.defaultAsset ?? 'BTC';
    const [board, quote] = await Promise.all([
      openBoard(settings.kalshi, { now }).catch(() => null),
      fetchSpotPrice(asset),
    ]);

    const candidates = board?.contracts ?? [];
    if (candidates.length === 0 || !(quote?.price > 0)) return { posted: 0 };

    const closesAt = closeTimeOf(candidates[0].market);
    const context = {
      prices: store
        .listSamples(asset)
        .filter((s) => s?.at >= now - 60 * 60 * 1000 && s?.price > 0)
        .map((s) => s.price),
      spot: quote.price,
      secondsLeft: Number.isFinite(closesAt) ? (closesAt - now) / 1000 : null,
    };

    const ladder = readBoard(candidates, context);
    let alerts = store.alerts();

    // The best tradeable strike, if there is one. Only ever one alert per pass:
    // announcing three strikes of the same ladder at once is one idea posted
    // three times, and the room reads it as noise.
    const best = ladder.best;
    const channel = await client.channels.fetch(panel.channelId).catch(() => null);
    if (!channel) return { posted: 0 };

    if (best) {
      const decision = shouldAlert(best.read, { ticker: best.ticker, alerts, now });
      if (decision.alert) {
        // Only now is the tape worth a request: one fetch, for the one contract
        // about to be announced, rather than a fetch per strike per sweep.
        const tape = fetchTrades
          ? await fetchTrades(settings.kalshi, best.ticker, { limit: 100 }).catch(() => null)
          : null;
        const whales = tape ? whaleActivity(tape.trades, { since: now - 15 * 60 * 1000 }) : null;
        const risk = flipRisk({
          side: best.read.call,
          flipProbability: best.read.result?.flipProbability,
          whales,
          secondsLeft: context.secondsLeft,
        });

        const body = alertMessage({
          read: best.read,
          asset,
          ticker: best.ticker,
          strike: best.strike,
          whales,
          risk,
          spot: quote.price,
        });

        await channel.send(body);
        alerts = rememberAlert(alerts, { ticker: best.ticker, kind: 'signal', now });
        store.putAlerts(alerts, { flush: true });

        // And to everyone who asked for it in their DMs. Booked to the store
        // BEFORE this, so a crash mid-delivery cannot cause the same contract
        // to be announced to the channel twice.
        //
        // Everyone DM'd an entry is also put on watch for the exit, at the
        // price the alert named. That closes the loop the whole thing was built
        // around: the buzz that says GET IN is followed, without anybody doing
        // anything, by the one that says GET OUT. Requiring a command in
        // between meant the exit — the half that is actually hard, decided in
        // ninety seconds while the number moves — depended on somebody
        // remembering to type while their money was on the table.
        const dmd = await deliverDms(client, store, dmAlertMessage(body), log, {
          watch: {
            ticker: best.ticker,
            side: best.read.call,
            entryCents: best.read.entryCents,
            now,
          },
        });
        log.info(`Signal alert posted for ${best.ticker}${dmd ? ` (+${dmd} DM)` : ''}`);
        return { posted: 1, kind: 'signal', dms: dmd };
      }
    }

    // No trade worth announcing. Size moving into the contract nearest the
    // money is still the most useful thing anyone will see this minute, and it
    // is posted with "this is not a trade call" written on it.
    if (!fetchTrades) return { posted: 0 };
    const near = nearestTheMoney(ladder.reads);
    if (!near?.ticker) return { posted: 0 };

    const tape = await fetchTrades(settings.kalshi, near.ticker, { limit: 100 }).catch(() => null);
    if (!tape) return { posted: 0 };

    const whales = whaleActivity(tape.trades, { since: now - 15 * 60 * 1000 });
    const decision = shouldAlertWhale(whales, { ticker: near.ticker, alerts, now });
    if (!decision.alert) return { posted: 0 };

    const risk = flipRisk({
      side: whales.lean > 0 ? 'up' : 'down',
      flipProbability: near.read.result?.flipProbability,
      whales,
      secondsLeft: context.secondsLeft,
    });

    await channel.send(
      whaleAlertMessage({ whales, asset, ticker: near.ticker, strike: near.strike, risk }),
    );
    store.putAlerts(rememberAlert(alerts, { ticker: near.ticker, kind: 'whale', now }), {
      flush: true,
    });
    log.info(`Whale alert posted for ${near.ticker}`);
    return { posted: 1, kind: 'whale' };
  } catch (error) {
    log.debug(`Signal alert sweep failed: ${error.message}`);
    return { posted: 0 };
  }
}

/**
 * Sends one alert to everyone who opted in, and forgets the ones who cannot be
 * reached.
 *
 * Sequential rather than parallel on purpose: Discord rate-limits direct
 * messages hard, and a burst to fifty people gets the bot throttled at exactly
 * the moment the rest of the system is trying to work. A signal channel this
 * size is a handful of subscribers, so the cost is a second at most.
 *
 * One person's closed inbox must never cost somebody else their alert, so every
 * send is caught individually.
 */
async function deliverDms(client, store, body, log, { watch = null } = {}) {
  let subs = store.signalDms();
  const userIds = Object.keys(subs);
  if (userIds.length === 0) return 0;

  let sent = 0;
  let watches = store.listWatches();

  for (const userId of userIds) {
    try {
      const user = await client.users.fetch(userId);
      await user.send(body);
      subs = noteDmSuccess(subs, userId);
      sent += 1;

      // On watch for the exit, at the price the alert named. Only for people
      // the message actually reached: watching somebody who never got told to
      // enter would DM them a CASH OUT for a position they never heard of.
      if (watch) {
        const made = makeWatch({ userId, ...watch, at: watch.now });
        if (made) watches = addWatch(watches, made);
      }
    } catch (error) {
      const before = Object.keys(subs).length;
      subs = noteDmFailure(subs, userId);
      if (Object.keys(subs).length < before) {
        log.debug(`Dropped ${userId} from call DMs after repeated failures: ${error.message}`);
      }
    }
  }

  store.putSignalDms(subs, { flush: true });
  if (watch && sent > 0) store.putWatches(watches);
  return sent;
}
