// Passive paper comparison. These records never alter cash, size, or orders.
export const EXIT_STUDY_VERSION = 'paired-exits-v1';

const finite = Number.isFinite;
const match = (trial, trade) => trial.ticker === trade.ticker &&
  trial.openedAt === trade.openedAt && trial.side === trade.side;

export function captureStudyEntry(account, position) {
  if (!position?.ticker || !['up', 'down'].includes(position.side) || !(position.contracts > 0) || !finite(position.cost) ||
      !finite(position.openedAt) || !finite(position.closesAt)) return account;
  // A redeploy can occur mid-market. Do not relabel a legacy reentry as the first entry.
  if ((account.trades ?? []).some((trade) => trade.ticker === position.ticker)) return account;
  const study = account.exitStudy ?? { version: EXIT_STUDY_VERSION, startedAt: position.openedAt, trials: [] };
  if (study.trials.some((trial) => trial.ticker === position.ticker)) return account;
  const trial = {
    ticker: position.ticker, side: position.side, openedAt: position.openedAt,
    closesAt: position.closesAt, entryCents: position.entryCents,
    costCents: position.cost / position.contracts * 100,
    entryPolicy: position.entryEvidence?.policyVersion ?? null,
    actualProfitCents: null, actualClosedAt: null, actualReason: null,
    holdProfitCents: null, outcome: null, outcomeRecordedAt: null,
  };
  return { ...account, exitStudy: { ...study, trials: [...study.trials, trial] } };
}

export function recordStudyExit(account, trade) {
  if (!account.exitStudy || !(trade.contracts > 0) || !finite(trade.profit)) return account;
  let changed = false;
  const trials = account.exitStudy.trials.map((trial) => {
    if (!match(trial, trade) || trial.actualClosedAt != null) return trial;
    changed = true;
    return { ...trial, actualProfitCents: trade.profit / trade.contracts * 100,
      actualClosedAt: trade.at, actualReason: trade.reason };
  });
  return changed ? { ...account, exitStudy: { ...account.exitStudy, trials } } : account;
}

export function pendingStudyTickers(account, now) {
  return (account.exitStudy?.trials ?? [])
    .filter((trial) => trial.outcome == null && trial.closesAt <= now)
    .map((trial) => trial.ticker);
}

export function settleExitStudy(account, settlements, { now = Date.now() } = {}) {
  if (!account.exitStudy) return account;
  let changed = false;
  const trials = account.exitStudy.trials.map((trial) => {
    const result = settlements?.[trial.ticker]?.result;
    if (trial.outcome != null || trial.closesAt > now || !['yes', 'no'].includes(result)) return trial;
    changed = true;
    const outcome = result === 'yes' ? 1 : 0;
    const payout = (trial.side === 'up' ? outcome : 1 - outcome) * 100;
    return { ...trial, outcome, outcomeRecordedAt: now,
      outcomeSource: 'kalshi-market:official-result', holdProfitCents: payout - trial.costCents };
  });
  return changed ? { ...account, exitStudy: { ...account.exitStudy, trials } } : account;
}

export function exitStudySummary(account) {
  const study = account.exitStudy;
  const trials = study?.trials ?? [];
  const matched = trials.filter((trial) => finite(trial.actualProfitCents) && finite(trial.holdProfitCents));
  const actual = matched.reduce((sum, trial) => sum + trial.actualProfitCents, 0);
  const hold = matched.reduce((sum, trial) => sum + trial.holdProfitCents, 0);
  return { version: EXIT_STUDY_VERSION, startedAt: study?.startedAt ?? null,
    recordedEntries: trials.length, matchedMarkets: matched.length, pending: trials.length - matched.length,
    actualProfitDollars: actual / 100, holdProfitDollars: hold / 100,
    differenceDollars: (hold - actual) / 100,
    actualWins: matched.filter((t) => t.actualProfitCents > 1e-6).length,
    holdWins: matched.filter((t) => t.holdProfitCents > 1e-6).length,
    unit: 'one contract per market; first paper entry only',
    note: 'Passive comparison, not cash or a separately funded strategy. No reentries or capital reuse are simulated.' };
}
