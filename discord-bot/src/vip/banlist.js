/**
 * A short list of specific people who are never let in, by Discord user id —
 * never by name or avatar, both of which a banned person can simply change
 * before rejoining.
 *
 * This only catches the same account coming back. Discord gives a bot no way
 * to see the device or network behind a brand-new account, so a determined
 * person who registers a fresh id is invisible to this check — there is no
 * fingerprint here, only a list of ids already known to be them.
 */

/** Whether this member is one of the specific people the list bans on sight. */
export function isBanned(userId, banUserIds) {
  return (banUserIds ?? []).includes(userId);
}

/** The mod-channel alert sent before the ban, so it is on record even if the ban call fails. */
export function banAlertText(member) {
  return `🚫 <@${member.id}> (**${member.user.tag}**, \`${member.id}\`) just joined and is on the ban list — banning now.`;
}
