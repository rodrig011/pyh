/**
 * Splitting every real payment across the team, and letting each person see
 * their own running share without anyone doing the math by hand.
 *
 * Reads the same payment ledger `/vip-admin stats` already reads —
 * `recordPayment()` is called from every path that actually grants access,
 * Zelle or card alike — so there is nowhere for a separate wallet ledger to
 * drift out of sync with what the room actually paid. Nothing here writes to
 * the store; the balance is recomputed from the payments every time it is
 * asked for, which is cheap at this scale and can never go stale.
 */

/** One payment's cents, split evenly, remainder to the first people in line. */
export function splitCents(amountCents, teamSize) {
  if (!(amountCents > 0) || !(teamSize > 0)) return [];
  const base = Math.floor(amountCents / teamSize);
  const remainder = amountCents - base * teamSize;
  return Array.from({ length: teamSize }, (_, index) => base + (index < remainder ? 1 : 0));
}

/** Every team member's running share of every payment on record. */
export function walletBalances(payments, team) {
  const roster = team ?? [];
  const shares = new Map(roster.map((member) => [member.id, 0]));
  let paidCount = 0;
  let totalCents = 0;

  for (const payment of payments ?? []) {
    const amount = payment?.amountCents;
    if (!(amount > 0) || roster.length === 0) continue;
    paidCount += 1;
    totalCents += amount;
    const split = splitCents(amount, roster.length);
    roster.forEach((member, index) => {
      shares.set(member.id, shares.get(member.id) + split[index]);
    });
  }

  return {
    paidCount,
    totalCents,
    balances: roster.map((member) => ({ ...member, cents: shares.get(member.id) })),
  };
}
