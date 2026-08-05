import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { subscriptionKey } from './subscriptions.js';

const EMPTY = {
  version: 1,
  orders: {},
  subscriptions: {},
  tickets: {},
  processedEmails: [],
  payments: [],
  welcomes: [],
  unassigned: [],
  picks: [],
  dmReplies: {},
  votes: [],
  follows: [],
  kalshiSince: null,
  samples: {},
  quotes: {},
  watches: [],
  paper: null,
  // Where the signals panel lives, and what has already been announced there.
  // Kept in the store rather than an environment variable on purpose: setting
  // an env var needs a redeploy and someone at a dashboard, and this has to be
  // settable from a phone by the person running the room.
  signalPanel: null,
  alerts: null,
  // Who asked for the calls in their DMs. Opt-in, one entry per person, with a
  // failure count so a closed inbox stops being retried instead of costing a
  // write every three minutes forever.
  signalDms: null,
};

/**
 * JSON store with atomic writes. Plenty for a single-process bot; if you ever
 * outgrow it, this module is the only thing that needs replacing.
 */
export function createStore(filePath) {
  const path = resolve(filePath);
  // The copy of the last good state, written before every overwrite. Cheap
  // insurance against the two ways this file dies that a volume does not
  // cover: a write interrupted mid-flight, and a file that parses as garbage.
  const backupPath = `${path}.bak`;
  let data = structuredClone(EMPTY);
  let recoveredFrom = null;

  // Whether anything was on disk when this started. On a host with no volume
  // mounted, every deploy hands the bot an empty file and silently drops the
  // open calls and memberships that were there a minute earlier.
  const existedAtBoot = existsSync(path);

  const readFrom = (from) => ({
    ...structuredClone(EMPTY),
    ...JSON.parse(readFileSync(from, 'utf8')),
  });

  if (existedAtBoot) {
    try {
      data = readFrom(path);
    } catch (error) {
      // Refusing to start would be the safe move for a database. Here it takes
      // the whole server down — no calls, no payments, nobody let in — over a
      // file the bot can rebuild from its own backup.
      if (existsSync(backupPath)) {
        try {
          data = readFrom(backupPath);
          recoveredFrom = backupPath;
        } catch {
          throw new Error(`Could not read the store at ${path}: ${error.message}`);
        }
      } else {
        throw new Error(`Could not read the store at ${path}: ${error.message}`);
      }
    }
  } else if (existsSync(backupPath)) {
    // The store is gone but its backup is not: a wiped or half-mounted volume.
    // Coming back with yesterday's memberships beats coming back with none.
    try {
      data = readFrom(backupPath);
      recoveredFrom = backupPath;
    } catch {
      // A backup that will not parse either is no worse than no backup.
    }
  }

  // A store that cannot be written is worse than no store: the bot logs in,
  // answers commands, posts calls, and then throws on the first save — which
  // in practice means the first sale. A mounted volume owned by root does
  // exactly this. One probe at boot turns it into something the owner can read
  // and act on, instead of an EACCES in front of a paying customer.
  let writeError = null;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const probe = `${path}.probe`;
    writeFileSync(probe, '');
    unlinkSync(probe);
  } catch (error) {
    writeError = error.message;
  }

  function save() {
    mkdirSync(dirname(path), { recursive: true });

    // Keep the last good state before replacing it. copyFile, not rename, so
    // there is never an instant where neither file is complete.
    if (existsSync(path)) {
      try {
        copyFileSync(path, backupPath);
      } catch {
        // A backup that cannot be written must never block the real write.
      }
    }

    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  }

  return {
    path,
    backupPath,
    existedAtBoot,
    /** Set when this booted from the backup instead of the store itself. */
    recoveredFrom,
    /** null when the store can be written; the reason it cannot, otherwise. */
    writeError,

    /** What is actually on disk, for a startup line worth reading. */
    summary() {
      return {
        orders: Object.keys(data.orders).length,
        subscriptions: Object.keys(data.subscriptions).length,
        picks: data.picks.length,
        payments: data.payments.length,
      };
    },

    get data() {
      return data;
    },
    save,

    getOrder(code) {
      return data.orders[code] ?? null;
    },

    putOrder(order) {
      data.orders[order.code] = order;
      save();
      return order;
    },

    listOrders(filter = () => true) {
      return Object.values(data.orders).filter(filter);
    },

    /** A user's pending orders, newest first. */
    pendingOrdersFor(userId) {
      return Object.values(data.orders)
        .filter((order) => order.userId === userId && order.status === 'pending')
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    getSubscription(guildId, userId) {
      return data.subscriptions[subscriptionKey(guildId, userId)] ?? null;
    },

    putSubscription(subscription) {
      data.subscriptions[subscriptionKey(subscription.guildId, subscription.userId)] = subscription;
      save();
      return subscription;
    },

    listSubscriptions(filter = () => true) {
      return Object.values(data.subscriptions).filter(filter);
    },

    isEmailProcessed(messageId) {
      return data.processedEmails.includes(messageId);
    },

    markEmailProcessed(messageId, { keep = 2000 } = {}) {
      if (!messageId || data.processedEmails.includes(messageId)) return;
      data.processedEmails.push(messageId);
      if (data.processedEmails.length > keep) {
        data.processedEmails = data.processedEmails.slice(-keep);
      }
      save();
    },

    recordPayment(payment) {
      data.payments.push(payment);
      save();
    },

    /**
     * Every new arrival and whether the welcome DM reached them. A blocked DM
     * is invisible from inside Discord, so without this there is no way to tell
     * "nobody joined" from "everybody joined and heard nothing".
     */
    recordWelcome(entry, { keep = 500 } = {}) {
      data.welcomes.push(entry);
      if (data.welcomes.length > keep) data.welcomes = data.welcomes.slice(-keep);
      save();
      return entry;
    },

    listWelcomes(filter = () => true) {
      return data.welcomes.filter(filter);
    },

    /**
     * A real payment that arrived with no code and no order to tie it to, kept
     * so a mod can attach it to a member later. Stored rather than left in the
     * Discord message alone, because the message stays clickable forever and
     * one payment must not be able to buy two people a membership.
     */
    recordUnassignedPayment(entry, { keep = 200 } = {}) {
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const record = { id, assignedTo: null, assignedAt: null, ...entry };
      data.unassigned.push(record);
      if (data.unassigned.length > keep) data.unassigned = data.unassigned.slice(-keep);
      save();
      return record;
    },

    getUnassignedPayment(id) {
      return data.unassigned.find((entry) => entry.id === id) ?? null;
    },

    recordPick(pick) {
      data.picks.push(pick);
      save();
      return pick;
    },

    getPick(id) {
      return data.picks.find((pick) => pick.id === id) ?? null;
    },

    putPick(pick) {
      const index = data.picks.findIndex((item) => item.id === pick.id);
      if (index === -1) data.picks.push(pick);
      else data.picks[index] = pick;
      save();
      return pick;
    },

    listPicks(filter = () => true) {
      return data.picks.filter(filter);
    },

    /**
     * When this user was last answered in a DM. Kept so a stranger who writes
     * three times in a row gets one storefront, not three.
     */
    lastDmReplyAt(userId) {
      return data.dmReplies[userId] ?? null;
    },

    markDmReplied(userId, at = Date.now()) {
      data.dmReplies[userId] = at;
      save();
      return at;
    },

    /**
     * A member taking a call, at the price they saw. Kept flat rather than on
     * the call itself so a busy room does not rewrite one growing object on
     * every press.
     */
    /**
     * The newest fill already turned into a call. Kept on disk because the
     * alternative — trusting process uptime — republished the whole recent
     * history as fresh calls on every deploy.
     */
    /**
     * Price history for the signal engine, per asset.
     *
     * Written every thirty seconds, so it is flushed on a timer rather than on
     * every tick — two thousand writes a day of a growing file, on the same
     * volume that holds the payments, is not a trade worth making.
     */
    listSamples(asset) {
      return data.samples[asset] ?? [];
    },

    putSamples(asset, samples, { flush = false } = {}) {
      data.samples[asset] = samples;
      if (flush) save();
      return samples;
    },

    /**
     * Recorded market quotes, for measuring whether the market is ever wrong.
     *
     * Kept beside the price samples and flushed on the same timer, for the
     * same reason: this writes all day, on the volume that also holds the
     * payments, and one write per observation is not a trade worth making.
     */
    /**
     * Every paper account, keyed by profile.
     *
     * Two running side by side is the only clean way to answer whether the
     * aggressive settings are worth it: same markets, same instant, same
     * prices, one difference. A careful run from Tuesday against a scalp run
     * from Thursday compares two weeks of weather, not two strategies.
     *
     * Migrates the old single-account shape in place, so a run already going is
     * not thrown away by a deploy.
     */
    paperAccounts() {
      const stored = data.paper;
      if (!stored) return {};
      // Old shape: one bare account. It has `cash`; a map of accounts does not.
      if (typeof stored.cash === 'number') return { [stored.profile ?? 'careful']: stored };
      return stored;
    },

    putPaperAccounts(accounts, { flush = true } = {}) {
      data.paper = accounts;
      if (flush) save();
      return accounts;
    },

    /** One account by profile, or the most aggressive one running. */
    paperAccount(profile = null) {
      const accounts = this.paperAccounts();
      if (profile) return accounts[profile] ?? null;
      const all = Object.values(accounts);
      return accounts.scalp ?? all[0] ?? null;
    },

    signalPanel() {
      return data.signalPanel ?? null;
    },

    putSignalPanel(panel, { flush = true } = {}) {
      data.signalPanel = panel;
      if (flush) save();
      return panel;
    },

    alerts() {
      return data.alerts ?? {};
    },

    signalDms() {
      return data.signalDms ?? {};
    },

    putSignalDms(subs, { flush = true } = {}) {
      data.signalDms = subs;
      if (flush) save();
      return subs;
    },

    putAlerts(alerts, { flush = false } = {}) {
      data.alerts = alerts;
      if (flush) save();
      return alerts;
    },

    putPaperAccount(account, { flush = true } = {}) {
      const accounts = { ...this.paperAccounts() };
      accounts[account?.profile ?? 'careful'] = account;
      this.putPaperAccounts(accounts, { flush });
      return account;
    },

    listWatches() {
      return data.watches ?? [];
    },

    putWatches(watches, { flush = true } = {}) {
      data.watches = watches;
      if (flush) save();
      return watches;
    },

    listQuotes(asset) {
      return data.quotes[asset] ?? [];
    },

    putQuotes(asset, quotes, { flush = false } = {}) {
      data.quotes[asset] = quotes;
      if (flush) save();
      return quotes;
    },

    kalshiSince() {
      return data.kalshiSince ?? null;
    },

    markKalshiSince(at) {
      data.kalshiSince = at;
      save();
      return at;
    },

    addFollow(follow) {
      data.follows.push(follow);
      save();
      return follow;
    },

    listFollows(filter = () => true) {
      return data.follows.filter(filter);
    },

    recordVote(vote) {
      data.votes.push(vote);
      save();
      return vote;
    },

    getVote(pickId) {
      return data.votes.find((vote) => vote.pickId === pickId) ?? null;
    },

    putVote(vote) {
      const index = data.votes.findIndex((item) => item.pickId === vote.pickId);
      if (index === -1) data.votes.push(vote);
      else data.votes[index] = vote;
      save();
      return vote;
    },

    listVotes(filter = () => true) {
      return data.votes.filter(filter);
    },

    /** Deletes matching calls. Used to undo a record the bot scored wrongly. */
    removePicks(filter) {
      const before = data.picks.length;
      data.picks = data.picks.filter((pick) => !filter(pick));
      save();
      return before - data.picks.length;
    },

    markPaymentAssigned(id, userId) {
      const entry = data.unassigned.find((item) => item.id === id);
      if (!entry) return null;
      entry.assignedTo = userId;
      entry.assignedAt = Date.now();
      save();
      return entry;
    },
  };
}
