/**
 * Which build is actually running.
 *
 * The gap this closes has nothing to do with trading and everything to do with
 * not being able to tell whether a fix shipped.
 *
 * Pushing a commit and redeploying are two different events, and from inside
 * Discord they are indistinguishable: a bug that was fixed an hour ago behaves
 * exactly like a bug that was never fixed if the container is still running
 * last week's image. Every "it is still doing the thing" report has to be
 * answered with "which version is up?", and answering that has meant opening a
 * dashboard on a laptop — which is not always available, and is a strange
 * dependency for a system whose entire interface is a phone.
 *
 * Railway injects the git metadata into the container at build time, so the
 * answer is already here. It just was not being read.
 *
 * Nothing here is a secret: a commit SHA and a branch name are public facts
 * about a repository, and the deployment id identifies a build rather than
 * granting anything. Tokens and connection strings live in other variables and
 * are deliberately not touched.
 */

const SHORT = 7;

/**
 * What the platform says it built, or an honest blank when it says nothing.
 *
 * `env` is injected so this is testable without pretending to be a deployment.
 */
export function buildInfo(env = process.env, { now = Date.now(), startedAt = null } = {}) {
  const value = (name) => {
    const raw = env[name];
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  const commit = value('RAILWAY_GIT_COMMIT_SHA') ?? value('GIT_COMMIT_SHA') ?? value('SOURCE_COMMIT');
  const started = startedAt ?? now - Math.round(process.uptime() * 1000);

  return {
    commit,
    shortCommit: commit ? commit.slice(0, SHORT) : null,
    branch: value('RAILWAY_GIT_BRANCH') ?? value('GIT_BRANCH'),
    // Only the first line. A commit body in this repository runs to forty lines
    // and would bury everything under it.
    message: (value('RAILWAY_GIT_COMMIT_MESSAGE') ?? '').split('\n')[0] || null,
    author: value('RAILWAY_GIT_AUTHOR'),
    deploymentId: value('RAILWAY_DEPLOYMENT_ID'),
    service: value('RAILWAY_SERVICE_NAME'),
    environment: value('RAILWAY_ENVIRONMENT_NAME'),
    node: process.version,
    startedAt: started,
    uptimeMs: Math.max(0, now - started),
    // Whether the platform told us anything at all. Distinguishes "running an
    // old build" from "cannot tell", and those need different responses.
    known: commit !== null,
  };
}

/** "3d 4h", "12m", "40s" — the coarsest unit that is still informative. */
export function humanDuration(ms) {
  if (!(ms >= 0)) return '—';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** One line for the boot log, so a restart says what it is running. */
export function buildLine(info = buildInfo()) {
  if (!info.known) {
    return `Running an unidentified build (no git metadata in the environment) on Node ${info.node}`;
  }
  return (
    `Running ${info.shortCommit}${info.branch ? ` on ${info.branch}` : ''}` +
    `${info.message ? ` — "${info.message}"` : ''} (Node ${info.node})`
  );
}

/**
 * The Discord answer to "did my fix actually ship?".
 *
 * Written to be read on a phone: the commit first, because that is the whole
 * question, and the uptime beside it because a deploy that landed and then
 * crash-looped shows up as a suspiciously small number and nothing else.
 */
export function buildMessage(info = buildInfo()) {
  if (!info.known) {
    return [
      '🤷 **This build did not identify itself.**',
      '',
      'No git metadata reached the container, so the running commit cannot be named.',
      'On Railway that normally arrives by itself; if it is missing, the service may be',
      'deploying from an uploaded image rather than from the repository.',
      '',
      `Up for **${humanDuration(info.uptimeMs)}** · Node ${info.node}`,
    ].join('\n');
  }

  return [
    `🚀 **Running \`${info.shortCommit}\`**${info.branch ? ` · \`${info.branch}\`` : ''}`,
    info.message ? `_${info.message}_` : null,
    '',
    `Up for **${humanDuration(info.uptimeMs)}**` +
      (info.environment ? ` · ${info.environment}` : '') +
      (info.service ? ` · ${info.service}` : ''),
    '',
    '_Compare that commit against the latest one pushed. If they match, the fix is live —',
    'if they do not, the push landed but the deploy did not, and nothing in Discord will',
    'show the change until it does._',
  ]
    .filter((line) => line !== null)
    .join('\n');
}
