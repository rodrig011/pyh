/**
 * Whether the picks channel has gone quiet, and whether anyone has been told.
 *
 * A room where analysts post whenever they feel like it looks fine from the
 * inside — somebody always remembers eventually. From the outside, a member
 * who joined for the calls and saw nothing in six hours has already decided
 * the room is dead, and nobody on staff finds out unless they happen to be
 * watching the same clock. This turns "has it been quiet" from a feeling
 * into a number, and only speaks up once per quiet stretch rather than every
 * time it is checked.
 */

/** Milliseconds since the last pick, or null if there has never been one. */
export function staleSinceMs(picks, now = Date.now()) {
  const last = (picks ?? []).reduce((max, pick) => Math.max(max, pick?.createdAt ?? 0), 0);
  return last === 0 ? null : now - last;
}

/**
 * Whether it is time to say something.
 *
 * Silent when there is no threshold configured (the feature is off), when
 * the gap has not actually crossed it yet, or when the same quiet stretch was
 * already flagged — a nudge every fifteen minutes for the same six hours of
 * silence would train everyone to ignore it.
 */
export function shouldNudge({ staleMs, thresholdMs, lastNudgeAt = null, now = Date.now() }) {
  if (!(thresholdMs > 0)) return false;
  if (staleMs === null || !(staleMs >= thresholdMs)) return false;
  if (lastNudgeAt !== null && now - lastNudgeAt < thresholdMs) return false;
  return true;
}
