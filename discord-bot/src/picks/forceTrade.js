/**
 * A floor on ACTIVITY, independent of whether the model sees an edge.
 *
 * Everything else this bot does refuses to trade without a real edge, because
 * a trade with no edge is not neutral — Kalshi's fee is charged whether the
 * call is right or not, so a coin-flip entry loses money to the fee on
 * average, every time. This file exists anyway, on explicit request, with
 * that cost understood and accepted.
 *
 * It is kept completely separate from the model-driven path on purpose: a
 * forced entry is never allowed to look like a signal in the record, and it
 * never touches the dollar rails in riskLimits.js — the daily cap, the
 * per-trade cap and the loss-streak stop apply to a forced trade exactly as
 * they apply to a real one.
 */

/** How many live orders were actually PLACED inside the trailing window. */
export function tradesInWindow(orders, { windowMs, now = Date.now() }) {
  if (!(windowMs > 0)) return 0;
  return (orders ?? []).filter(
    (order) => order?.result?.status === 'placed' && order.at >= now - windowMs,
  ).length;
}

/** Whether the quota still needs filling. */
export function shouldForceEntry({ ordersInWindow, targetPerWindow }) {
  if (!(targetPerWindow > 0)) return false;
  return (ordersInWindow ?? 0) < targetPerWindow;
}

/**
 * The least-bad contract the model had ANY opinion on — not a blind guess.
 *
 * A read with no clock, no price or no volatility history carries no
 * probability at all (see direction.js), and forcing an order onto one of
 * those would not be "trading without an edge", it would be trading on
 * nothing — there is no side to even name. Restricted to reads the model
 * actually formed a call on, ranked by the same net edge the real path ranks
 * by, so a forced trade is still the LEAST wrong thing on the board, even
 * though "wrong" is now allowed.
 */
export function leastBadCandidate(reads) {
  const withOpinion = (reads ?? []).filter(
    (entry) => entry?.read?.call && Number.isFinite(entry.read.entryCents),
  );
  if (withOpinion.length === 0) return null;

  return [...withOpinion].sort(
    (a, b) => (b.read.netEdgeCents ?? -Infinity) - (a.read.netEdgeCents ?? -Infinity),
  )[0];
}
