/**
 * The moment somebody becomes an analyst is the one moment they are actually
 * paying attention to how the panel works — same reasoning as the welcome DM
 * for new VIP members. Waiting for them to ask, or for a mod to explain it
 * live, is how a new analyst's first pick ends up typed by hand in the
 * channel instead of run through the console that tracks it.
 */

/** Whether this role update just added one of the watched (analyst) roles. */
export function gainedWatchedRole(beforeRoleIds, afterRoleIds, watchedRoleIds) {
  const watched = new Set((watchedRoleIds ?? []).filter(Boolean));
  if (watched.size === 0) return false;

  const had = new Set(beforeRoleIds ?? []);
  return (afterRoleIds ?? []).some((id) => watched.has(id) && !had.has(id));
}

export const ANALYST_GUIDE_MESSAGE = [
  "👋 **You're an analyst now — here's the whole thing, four steps.**",
  '',
  '**1. Find the panel.** In the picks channel there\'s a pinned message called "Analyst console" with colored buttons. That\'s your control — never type a pick by hand, it won\'t be tracked or scored.',
  '',
  '**2. Up or down?**\n🟢 **BUY UP** = you think the price is going UP\n🔴 **BUY DOWN** = you think it\'s going DOWN\n\nTap one. The bot already knows the current price and the clock.',
  '',
  '**3. How much?**\nAfter direction, size buttons show up (25% / 50% / 75% / FULL PORT). Tap one — a pick needs a size before it sends.',
  '',
  '**4. Closing it out.**\nBack on the same panel: 💸 **CASH OUT** (exit in profit), ❌ **CUT LOSS** (exit at a loss), ✋ **HOLD** (do nothing, still running). No half-exits. If you never touch it, it grades itself automatically when the window closes.',
  '',
  "That's it. Questions go to the mods, not into the picks channel.",
].join('\n');
