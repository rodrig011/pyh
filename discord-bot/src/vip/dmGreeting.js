/**
 * Answering a stranger who writes to the bot.
 *
 * Somebody who messages a sales bot is asking one question — how do I get in —
 * so the storefront and the invite are the answer, and making them wait for a
 * human loses most of them. The decision is kept separate from Discord so the
 * cases that matter can be checked: the bot must never answer itself, never
 * answer inside a server, and never send a second storefront to somebody who
 * simply typed three messages in a row.
 *
 * @param {object} message  {authorId, authorIsBot, isDirectMessage}
 * @param {object} config
 * @param {number|null} lastRepliedAt
 * @returns {{reply: boolean, reason: string}}
 */
export function shouldGreetDm(message, config, lastRepliedAt, now = Date.now()) {
  if (!config.dmAutoReply) return { reply: false, reason: 'DM_AUTO_REPLY is off' };
  if (!message.isDirectMessage) return { reply: false, reason: 'not a DM' };

  // Without this the bot answers its own storefront and then answers that.
  if (message.authorIsBot) return { reply: false, reason: 'written by a bot' };
  if (message.authorId === config.clientId) return { reply: false, reason: 'written by this bot' };

  const cooldownMs = Math.max(0, config.dmReplyCooldownHours ?? 24) * 3600 * 1000;
  if (lastRepliedAt && now - lastRepliedAt < cooldownMs) {
    return { reply: false, reason: 'already answered recently' };
  }

  return { reply: true, reason: 'a new conversation' };
}
