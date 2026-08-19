import { EventEmitter } from 'node:events';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createLogger } from '../lib/logger.js';
import { htmlToText, parsePaymentEmail } from './parseZelle.js';

const log = createLogger('zelle');

/**
 * Polls the mailbox where the bank drops its Zelle notifications and emits an
 * event for every incoming payment.
 *
 * Events:
 *   'payment'  -> (payment, email)   valid payment detected
 *   'skipped'  -> (parsed, email)    email discarded (with the reason)
 *   'error'    -> (error)
 */
export class ZelleWatcher extends EventEmitter {
  constructor({ imap, codePrefix = 'VIP', codeLength = 6, store }) {
    super();
    this.imap = imap;
    this.codePrefix = codePrefix;
    this.codeLength = codeLength;
    this.store = store;
    this.timer = null;
    this.running = false;
    this.stopped = false;
  }

  /**
   * Everything standing between the current settings and automatic detection,
   * in plain words. Nothing here talks to the network: it is what can be known
   * without waiting for a real payment to arrive and fail silently.
   *
   * @returns {string[]} empty when detection is fully configured
   */
  diagnose() {
    const problems = [];
    if (!this.imap.enabled) {
      problems.push('`IMAP_ENABLED` is not `true`, so the mailbox is never read.');
    }
    for (const [key, value] of [
      ['IMAP_HOST', this.imap.host],
      ['IMAP_USER', this.imap.user],
      ['IMAP_PASSWORD', this.imap.password],
    ]) {
      if (!value) problems.push(`\`${key}\` is empty.`);
    }
    if (this.imap.password === 'REPLACE_ME') {
      problems.push('`IMAP_PASSWORD` is still the placeholder `REPLACE_ME`.');
    }

    // Without an allowlist the parser refuses every email on purpose, so this
    // looks exactly like "no payments arriving" while the inbox fills up.
    const configured = (this.imap.providers ?? []).filter(
      (entry) => entry.allowedSenders?.length > 0,
    );
    if (configured.length === 0) {
      problems.push(
        'No trusted senders configured (`IMAP_ALLOWED_SENDERS`), so every email is ignored.',
      );
    }
    return problems;
  }

  start() {
    const problems = this.diagnose();
    if (problems.length > 0) {
      log.warn(`Automatic detection is OFF: ${problems.join(' ')}`);
      return;
    }
    this.stopped = false;
    const tick = () => {
      this.poll().catch((error) => {
        log.error(`Mailbox check failed: ${error.message}`);
        this.emit('error', error);
      });
    };
    tick();
    this.timer = setInterval(tick, Math.max(15, this.imap.pollSeconds) * 1000);
    log.info(`Watching ${this.imap.user} every ${this.imap.pollSeconds}s`);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * IMAP failures arrive as a bare "Command failed": the server's actual
   * complaint sits in fields the default message throws away. This puts the
   * stage and the server's own words back together, because "it failed" is not
   * something anyone can act on.
   */
  static describeError(error, stage) {
    const detail = [
      error.responseText,
      error.serverResponseCode ? `code ${error.serverResponseCode}` : null,
      error.code && error.code !== error.serverResponseCode ? error.code : null,
    ]
      .filter(Boolean)
      .join(' — ');

    const where = {
      connect: 'connecting to the mail server',
      auth: 'signing in',
      mailbox: `opening the mailbox`,
      search: 'searching for new mail',
    }[stage];

    const message = detail ? `${error.message} (${detail})` : error.message;
    return where ? `while ${where}: ${message}` : message;
  }

  /** Tags an error with the step that produced it, then rethrows. */
  static async at(stage, run) {
    try {
      return await run();
    } catch (error) {
      // ImapFlow signs in inside connect(), so a rejected password arrives
      // tagged as a connection problem and sends people to check the hostname.
      const actual = error.authenticationFailed ? 'auth' : stage;
      error.stage = actual;
      error.described = ZelleWatcher.describeError(error, actual);
      throw error;
    }
  }

  /**
   * Read-only look at what is actually in the mailbox and what the parser makes
   * of each message.
   *
   * poll() is deliberately blind for diagnosis: it only looks at unread mail,
   * skips anything already processed, and marks what it reads as seen — so once
   * a payment has gone by, re-running it shows an empty mailbox no matter what
   * went wrong. This looks at everything in the window, marks nothing, and
   * keeps the rejection reason for each message. That reason is the whole
   * answer when a bank's real sending domain is not the one in the allowlist:
   * every alert is dropped, and silence looks identical to no payments.
   */
  async inspect({ limit = 8 } = {}) {
    const client = new ImapFlow({
      host: this.imap.host,
      port: this.imap.port,
      secure: this.imap.secure,
      auth: { user: this.imap.user, pass: this.imap.password },
      logger: false,
    });

    const seen = [];
    let total = 0;

    try {
      await ZelleWatcher.at('connect', () => client.connect());
      const lock = await ZelleWatcher.at('mailbox', () =>
        client.getMailboxLock(this.imap.mailbox),
      );
      try {
        const since = new Date(Date.now() - this.imap.sinceDays * 86400 * 1000);
        const uids = (await ZelleWatcher.at('search', () => client.search({ since }, { uid: true }))) ?? [];
        total = uids.length;

        for (const uid of uids.slice(-limit).reverse()) {
          const message = await client.fetchOne(uid, { source: true }, { uid: true });
          if (!message) continue;

          const parsedMail = await simpleParser(message.source);
          const email = {
            from: parsedMail.from?.value?.[0]?.address ?? parsedMail.from?.text ?? '',
            subject: parsedMail.subject ?? '',
            text: parsedMail.text ?? '',
            html: typeof parsedMail.html === 'string' ? parsedMail.html : '',
            messageId: parsedMail.messageId ?? `uid:${this.imap.mailbox}:${uid}`,
            date: parsedMail.date ?? new Date(),
          };

          const parsed = parsePaymentEmail(email, {
            providers: this.imap.providers,
            codePrefix: this.codePrefix,
            codeLength: this.codeLength,
          });

          // When a payment parses but the payer does not, the wording is the
          // only thing that can fix it — matching by name is dead without that
          // field, and no amount of guessing at the regex substitutes for
          // seeing what the bank actually wrote.
          const body = email.text?.trim() || htmlToText(email.html);
          seen.push({
            from: email.from,
            subject: email.subject,
            date: email.date,
            isPayment: parsed.isPayment,
            reason: parsed.reason ?? null,
            amountCents: parsed.amountCents,
            senderName: parsed.senderName,
            codes: parsed.codes ?? [],
            excerpt:
              parsed.isPayment && !parsed.senderName
                ? body.replace(/\s+/g, ' ').slice(0, 220)
                : null,
            alreadyProcessed: this.store?.isEmailProcessed(email.messageId) ?? false,
          });
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }

    return { total, seen };
  }

  /** One pass over the mailbox. Can be triggered by hand (/vip-admin sync). */
  async poll() {
    if (this.running || this.stopped) return { checked: 0, payments: 0 };
    this.running = true;

    const client = new ImapFlow({
      host: this.imap.host,
      port: this.imap.port,
      secure: this.imap.secure,
      auth: { user: this.imap.user, pass: this.imap.password },
      logger: false,
    });

    let checked = 0;
    let payments = 0;

    try {
      await ZelleWatcher.at('connect', () => client.connect());
      const lock = await ZelleWatcher.at('mailbox', () =>
        client.getMailboxLock(this.imap.mailbox),
      );
      try {
        const since = new Date(Date.now() - this.imap.sinceDays * 86400 * 1000);
        // `{ uid: true }` is not optional: without it IMAP answers with sequence
        // numbers, which renumber as the mailbox changes, and every fetch below
        // asks by UID. Mixing the two reads the wrong message or none at all —
        // and a payment that is silently never read looks like no payment.
        const uids = await ZelleWatcher.at('search', () =>
          client.search({ since, seen: false }, { uid: true }),
        );
        for (const uid of uids ?? []) {
          const message = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
          if (!message) continue;
          checked += 1;

          const parsedMail = await simpleParser(message.source);
          const messageId = parsedMail.messageId ?? `uid:${this.imap.mailbox}:${uid}`;

          if (this.store?.isEmailProcessed(messageId)) continue;

          const email = {
            from: parsedMail.from?.value?.[0]?.address ?? parsedMail.from?.text ?? '',
            subject: parsedMail.subject ?? '',
            text: parsedMail.text ?? '',
            html: typeof parsedMail.html === 'string' ? parsedMail.html : '',
            messageId,
            date: parsedMail.date ?? new Date(),
          };

          const parsed = parsePaymentEmail(email, {
            providers: this.imap.providers,
            codePrefix: this.codePrefix,
            codeLength: this.codeLength,
          });

          this.store?.markEmailProcessed(messageId);
          if (this.imap.markSeen) {
            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }).catch(() => {});
          }

          if (parsed.isPayment) {
            payments += 1;
            log.info(
              `${parsed.provider} payment detected: ${parsed.amountCents} cents, codes=${parsed.codes.join(',') || 'none'}`,
            );
            this.emit('payment', parsed, email);
          } else {
            log.debug(`Email skipped (${parsed.reason}): ${email.subject}`);
            this.emit('skipped', parsed, email);
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
      this.running = false;
    }

    return { checked, payments };
  }
}
