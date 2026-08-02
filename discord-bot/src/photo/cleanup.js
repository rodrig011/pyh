import { evaluateMessage } from './photoOnly.js';

/** Discord refuses to bulk-delete anything older than this. */
export const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Sorts a channel's history into what stays and what goes, using the very same
 * rule the live bot applies to new messages — a cleanup that disagreed with the
 * enforcement would delete things the channel then allows straight back in.
 *
 * Pure, because it decides what to destroy: the decision has to be checkable
 * against fixed input rather than trusted after the fact.
 *
 * @param {Array<{id: string, createdTimestamp: number, pinned?: boolean}>} messages
 * @param {object} config the photo-only options
 * @param {{now?: number, keepPinned?: boolean}} [options]
 * @returns {{remove: object[], keep: object[], recent: object[], old: object[]}}
 */
export function planCleanup(messages, config, { now = Date.now(), keepPinned = true } = {}) {
  const remove = [];
  const keep = [];

  for (const message of messages) {
    // A pinned message was put there on purpose by somebody with the rights to
    // do it. Sweeping those away as ordinary text loses channel rules and
    // announcements that were meant to outlast everything else.
    if (keepPinned && message.pinned) {
      keep.push(message);
      continue;
    }
    if (evaluateMessage(message, config).allowed) keep.push(message);
    else remove.push(message);
  }

  // Discord will bulk-delete recent messages in one call and refuses the rest,
  // which have to go one at a time.
  const cutoff = now - BULK_DELETE_MAX_AGE_MS;
  return {
    remove,
    keep,
    recent: remove.filter((message) => message.createdTimestamp > cutoff),
    old: remove.filter((message) => message.createdTimestamp <= cutoff),
  };
}
