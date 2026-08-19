import test from 'node:test';
import assert from 'node:assert/strict';
import { ZelleWatcher } from '../src/payments/zelleWatcher.js';

// A watcher that is misconfigured behaves exactly like an inbox with no mail:
// silence. These pin the difference down to a sentence a mod can act on.

const working = {
  enabled: true,
  host: 'imap.gmail.com',
  user: 'investotecho@gmail.com',
  password: 'appspecificpw',
  pollSeconds: 60,
  providers: [{ provider: 'zelle', allowedSenders: ['huntington.com'] }],
};

function watcher(overrides = {}) {
  return new ZelleWatcher({ imap: { ...working, ...overrides }, store: null });
}

test('a fully configured mailbox reports nothing wrong', () => {
  assert.deepEqual(watcher().diagnose(), []);
});

test('IMAP_ENABLED=false is named, not left as silence', () => {
  const problems = watcher({ enabled: false }).diagnose();
  assert.equal(problems.length, 1);
  assert.match(problems[0], /IMAP_ENABLED/);
});

test('an empty password is named', () => {
  assert.ok(watcher({ password: '' }).diagnose().some((p) => /IMAP_PASSWORD/.test(p)));
});

test('the REPLACE_ME placeholder is caught before it looks like a login failure', () => {
  assert.ok(watcher({ password: 'REPLACE_ME' }).diagnose().some((p) => /REPLACE_ME/.test(p)));
});

test('no sender allowlist is reported, because it silently rejects every email', () => {
  const problems = watcher({ providers: [{ provider: 'zelle', allowedSenders: [] }] }).diagnose();
  assert.ok(problems.some((p) => /IMAP_ALLOWED_SENDERS/.test(p)));
});

test('several problems are all reported at once, not one per redeploy', () => {
  const problems = watcher({ enabled: false, password: '', providers: [] }).diagnose();
  assert.ok(problems.length >= 3, `expected several, got ${problems.length}`);
});

// "Command failed" is ImapFlow's generic wording; the server's real complaint
// lives in fields the default message discards. Losing them means a mod is told
// nothing and goes checking the wrong setting.

test('the server response is put back into the message', () => {
  const error = Object.assign(new Error('Command failed'), {
    responseText: 'Invalid credentials (Failure)',
    serverResponseCode: 'AUTHENTICATIONFAILED',
  });

  const described = ZelleWatcher.describeError(error, 'auth');
  assert.match(described, /Invalid credentials/);
  assert.match(described, /AUTHENTICATIONFAILED/);
  assert.match(described, /signing in/);
});

test('an error with no detail still reads as a sentence', () => {
  assert.match(ZelleWatcher.describeError(new Error('Command failed'), 'search'), /searching for new mail/);
});

test('a rejected password is reported as sign-in, not as a connection problem', async () => {
  const error = Object.assign(new Error('Command failed'), { authenticationFailed: true });

  await assert.rejects(
    () => ZelleWatcher.at('connect', () => Promise.reject(error)),
    (thrown) => {
      assert.equal(thrown.stage, 'auth');
      assert.match(thrown.described, /signing in/);
      return true;
    },
  );
});

test('at() tags the stage and leaves the error otherwise intact', async () => {
  await assert.rejects(
    () => ZelleWatcher.at('mailbox', () => Promise.reject(new Error('No such mailbox'))),
    (thrown) => {
      assert.equal(thrown.stage, 'mailbox');
      assert.equal(thrown.message, 'No such mailbox');
      return true;
    },
  );
});

test('at() passes the value straight through when nothing fails', async () => {
  const value = await ZelleWatcher.at('search', () => Promise.resolve([1, 2, 3]));
  assert.equal(value.length, 3);
});
