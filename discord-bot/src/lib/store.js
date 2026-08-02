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
};

/**
 * JSON store with atomic writes. Plenty for a single-process bot; if you ever
 * outgrow it, this module is the only thing that needs replacing.
 */
export function createStore(filePath) {
  const path = resolve(filePath);
  let data = structuredClone(EMPTY);

  if (existsSync(path)) {
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
  };
}
