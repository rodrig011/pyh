import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
};

/**
 * JSON store with atomic writes. Plenty for a single-process bot; if you ever
 * outgrow it, this module is the only thing that needs replacing.
 */
export function createStore(filePath) {
  const path = resolve(filePath);
  let data = structuredClone(EMPTY);
  // Whether anything was on disk when this started. On a host with no volume
  // mounted, every deploy hands the bot an empty file and silently drops the
  // open calls and memberships that were there a minute earlier.
  const existedAtBoot = existsSync(path);

  if (existedAtBoot) {
    try {
      data = { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(path, 'utf8')) };
    } catch (error) {
      throw new Error(`Could not read the store at ${path}: ${error.message}`);
    }
  }

  function save() {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  }

  return {
    path,
    existedAtBoot,

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
