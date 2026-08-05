import test from 'node:test';
import assert from 'node:assert/strict';

import { buildInfo, buildLine, buildMessage, humanDuration } from '../src/lib/build.js';

/**
 * Which build is running, answerable from a phone.
 *
 * A push and a deploy are separate events, and from inside Discord they are
 * indistinguishable: a bug fixed an hour ago behaves exactly like a bug never
 * fixed if the container is still on last week's image.
 */

const RAILWAY = {
  RAILWAY_GIT_COMMIT_SHA: '0565b0f9a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6',
  RAILWAY_GIT_BRANCH: 'claude/discord-zelle-vip-tiers-kqxhln',
  RAILWAY_GIT_COMMIT_MESSAGE: 'Read the whole ladder of strikes\n\nA long body that must not appear.',
  RAILWAY_ENVIRONMENT_NAME: 'production',
  RAILWAY_SERVICE_NAME: 'discord-bot',
};

test('the running commit is read from what the platform injected', () => {
  const info = buildInfo(RAILWAY, { now: 1_000_000, startedAt: 900_000 });
  assert.equal(info.shortCommit, '0565b0f');
  assert.equal(info.branch, 'claude/discord-zelle-vip-tiers-kqxhln');
  assert.equal(info.known, true);
});

test('only the first line of the commit message survives', () => {
  // The bodies in this repository run to forty lines and would bury the answer.
  const info = buildInfo(RAILWAY);
  assert.equal(info.message, 'Read the whole ladder of strikes');
  assert.doesNotMatch(buildMessage(info), /must not appear/);
});

test('a build with no metadata says so rather than inventing a version', () => {
  const info = buildInfo({}, { now: 1_000_000, startedAt: 900_000 });
  assert.equal(info.known, false);
  assert.equal(info.shortCommit, null);
  assert.match(buildMessage(info), /did not identify itself/);
});

test('blank environment variables count as absent, not as a commit', () => {
  const info = buildInfo({ RAILWAY_GIT_COMMIT_SHA: '   ' });
  assert.equal(info.known, false);
});

test('the message names the commit first, because that is the whole question', () => {
  const text = buildMessage(buildInfo(RAILWAY, { now: 1_000_000, startedAt: 900_000 }));
  assert.match(text.split('\n')[0], /0565b0f/);
});

test('uptime is shown, so a crash loop is not read as a successful deploy', () => {
  // A deploy that landed and then crash-looped shows up as a suspiciously small
  // number and nothing else.
  const text = buildMessage(buildInfo(RAILWAY, { now: 1_000_000, startedAt: 999_000 }));
  assert.match(text, /Up for \*\*1s\*\*/);
});

test('no secret is ever read, whatever is sitting in the environment', () => {
  const info = buildInfo({
    ...RAILWAY,
    DISCORD_TOKEN: 'super-secret',
    IMAP_PASSWORD: 'also-secret',
    STRIPE_SECRET_KEY: 'sk_live_nope',
    KALSHI_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----',
  });
  const text = `${buildMessage(info)}\n${buildLine(info)}\n${JSON.stringify(info)}`;

  for (const secret of ['super-secret', 'also-secret', 'sk_live_nope', 'BEGIN PRIVATE KEY']) {
    assert.doesNotMatch(text, new RegExp(secret));
  }
});

test('durations read as the coarsest unit that is still informative', () => {
  assert.equal(humanDuration(40_000), '40s');
  assert.equal(humanDuration(12 * 60_000), '12m');
  assert.equal(humanDuration(2 * 3_600_000 + 38 * 60_000), '2h 38m');
  assert.equal(humanDuration(3 * 86_400_000 + 4 * 3_600_000), '3d 4h');
  assert.equal(humanDuration(-1), '—');
});

test('the boot line names the build, or admits it cannot', () => {
  assert.match(buildLine(buildInfo(RAILWAY)), /0565b0f/);
  assert.match(buildLine(buildInfo({})), /unidentified build/);
});

test('a non-Railway host that sets the usual variables is still read', () => {
  const info = buildInfo({ GIT_COMMIT_SHA: 'abcdef1234567890', GIT_BRANCH: 'main' });
  assert.equal(info.shortCommit, 'abcdef1');
  assert.equal(info.branch, 'main');
});
