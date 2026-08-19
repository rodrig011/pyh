/**
 * The room's own verdict on a call.
 *
 * The bot scores a call against the price, which answers "was the direction
 * right". It cannot answer "did the room make money" — that depends on when
 * each person got in, how much they sized, and whether they saw the exit. So
 * the members are asked, and both numbers are published side by side.
 *
 * The two disagreeing is the useful signal, not a contradiction: a call graded
 * a win where most of the room lost money means the entry or the exit was
 * called too late to act on.
 */

export const VOTES = { PROFIT: 'profit', LOSS: 'loss' };

export function emptyVote(pickId, { closesAt }) {
  return { pickId, ballots: {}, closesAt, resultPostedAt: null, messageId: null, channelId: null };
}

/**
 * Records one member's answer. A changed mind replaces the old answer rather
 * than adding to it — one member, one voice, however many times they press.
 */
export function castVote(vote, userId, choice) {
  if (!Object.values(VOTES).includes(choice)) throw new Error(`Unknown vote: ${choice}`);
  const previous = vote.ballots[userId] ?? null;
  vote.ballots[userId] = choice;
  return { changed: previous !== choice, previous };
}

export function tallyVote(vote) {
  const answers = Object.values(vote.ballots ?? {});
  const profit = answers.filter((answer) => answer === VOTES.PROFIT).length;
  const loss = answers.filter((answer) => answer === VOTES.LOSS).length;
  const total = profit + loss;

  return {
    profit,
    loss,
    total,
    // Null rather than zero: nobody voting is not the same as everybody losing,
    // and a bar drawn at 0% would say the second.
    profitShare: total === 0 ? null : profit / total,
  };
}

/** Votes whose window has closed and whose result has not been published. */
export function votesDue(votes, now = Date.now()) {
  return votes.filter((vote) => !vote.resultPostedAt && vote.closesAt <= now);
}

/** A ten-segment bar. Reads at a glance on a phone, which is where this lands. */
export function shareBar(share, width = 10) {
  if (share === null) return '—';
  const filled = Math.round(share * width);
  return `${'🟩'.repeat(filled)}${'🟥'.repeat(width - filled)}`;
}

export function formatShare(share) {
  return share === null ? '—' : `${Math.round(share * 100)}%`;
}
