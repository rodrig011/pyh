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
 * @param {Array<{id: string, createdTimestamp: number, pinned?: boolean, memberRoleIds?: string[], authorId?: string}>} messages
 * @param {object} config the photo-only options
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {boolean} [options.keepPinned=true]
 * @param {string[]} [options.onlyRoleIds] only touch messages from members holding one of these
 * @param {string[]} [options.exceptRoleIds] never touch messages from members holding one of these
 * @param {string[]} [options.onlyUserIds] only touch messages from these people
 * @param {string[]} [options.exceptUserIds] never touch messages from these people
 * @returns {{remove: object[], keep: object[], recent: object[], old: object[], skipped: number}}
 */
export function planCleanup(
  messages,
  config,
  {
    now = Date.now(),
    keepPinned = true,
    onlyRoleIds = [],
    exceptRoleIds = [],
    onlyUserIds = [],
    exceptUserIds = [],
  } = {},
) {
  const remove = [];
  const keep = [];
  let skipped = 0;

  const holds = (message, roleIds) =>
    (message.memberRoleIds ?? []).some((roleId) => roleIds.includes(roleId));
  const isOneOf = (message, userIds) => Boolean(message.authorId) && userIds.includes(message.authorId);

  for (const message of messages) {
    // A pinned message was put there on purpose by somebody with the rights to
    // do it. Sweeping those away as ordinary text loses channel rules and
    // announcements that were meant to outlast everything else.
    if (keepPinned && message.pinned) {
      keep.push(message);
      continue;
    }

    // Whose messages are in scope at all. All four filters answer that before
    // the photo rule gets a say, so an exempt member's text survives and an
    // out-of-scope member is never touched — including someone who has since
    // left, who carries no roles and so can never match `only`.
    //
    // Naming a person beats naming a role and is checked first: somebody who
    // left the server, or who never had the role, is still exactly who they
    // are, and "spare Kenson" should not depend on Kenson's role list.
    if (exceptUserIds.length > 0 && isOneOf(message, exceptUserIds)) {
      keep.push(message);
      skipped += 1;
      continue;
    }
    if (exceptRoleIds.length > 0 && holds(message, exceptRoleIds)) {
      keep.push(message);
      skipped += 1;
      continue;
    }
    // With both `only` filters set, belonging to either one is enough to be in
    // scope: they read as "clean up tier 1 and also this one guy".
    if (onlyUserIds.length > 0 || onlyRoleIds.length > 0) {
      const inScope =
        (onlyUserIds.length > 0 && isOneOf(message, onlyUserIds)) ||
        (onlyRoleIds.length > 0 && holds(message, onlyRoleIds));
      if (!inScope) {
        keep.push(message);
        skipped += 1;
        continue;
      }
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
    skipped,
    recent: remove.filter((message) => message.createdTimestamp > cutoff),
    old: remove.filter((message) => message.createdTimestamp <= cutoff),
  };
}
