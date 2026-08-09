import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldNudge, staleSinceMs } from '../src/picks/consistency.js';

test('staleSinceMs reads the most recent pick, not the oldest', () => {
  const now = 1_000_000;
  const picks = [{ createdAt: now - 5000 }, { createdAt: now - 500_000 }, { createdAt: now - 1000 }];
  assert.equal(staleSinceMs(picks, now), 1000);
});

test('staleSinceMs is null when there has never been a pick', () => {
  assert.equal(staleSinceMs([], 1000), null);
});

test('shouldNudge is off with no threshold configured', () => {
  assert.equal(shouldNudge({ staleMs: 999_999_999, thresholdMs: 0 }), false);
});

test('shouldNudge is silent while never-posted (null) rather than treating it as instantly stale', () => {
  assert.equal(shouldNudge({ staleMs: null, thresholdMs: 3_600_000 }), false);
});

test('shouldNudge fires once the gap crosses the threshold', () => {
  const thresholdMs = 6 * 3_600_000;
  assert.equal(shouldNudge({ staleMs: thresholdMs - 1, thresholdMs }), false);
  assert.equal(shouldNudge({ staleMs: thresholdMs + 1, thresholdMs }), true);
});

test('shouldNudge does not repeat inside the same quiet stretch', () => {
  const now = 10_000_000;
  const thresholdMs = 3_600_000;
  const lastNudgeAt = now - 1000; // nudged a second ago
  assert.equal(shouldNudge({ staleMs: thresholdMs + 1, thresholdMs, lastNudgeAt, now }), false);
});

test('shouldNudge fires again once a full threshold has passed since the last nudge', () => {
  const now = 10_000_000;
  const thresholdMs = 3_600_000;
  const lastNudgeAt = now - thresholdMs - 1;
  assert.equal(shouldNudge({ staleMs: thresholdMs * 2, thresholdMs, lastNudgeAt, now }), true);
});
