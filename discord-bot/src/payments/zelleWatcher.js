import { EventEmitter } from 'node:events';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createLogger } from '../lib/logger.js';
import { parseZelleEmail } from './parseZelle.js';

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

  start() {
    if (!this.imap.enabled) {
      log.warn('IMAP disabled (IMAP_ENABLED=false): payments can only be confirmed manually');
      return;
    }
    if (!this.imap.host || !this.imap.user || !this.imap.password) {
      log.warn('IMAP_HOST/IMAP_USER/IMAP_PASSWORD missing: the mailbox will not be checked');
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
      await client.connect();
      const lock = await client.getMailboxLock(this.imap.mailbox);
      try {
        const since = new Date(Date.now() - this.imap.sinceDays * 86400 * 1000);
        const uids = await client.search({ since, seen: false });
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

          const parsed = parseZelleEmail(email, {
            allowedSenders: this.imap.allowedSenders,
            codePrefix: this.codePrefix,
            codeLength: this.codeLength,
          });

          this.store?.markEmailProcessed(messageId);
          if (this.imap.markSeen) {
            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }).catch(() => {});
          }

          if (parsed.isPayment) {
            payments += 1;
            log.info(`Payment detected: ${parsed.amountCents} cents, codes=${parsed.codes.join(',') || 'none'}`);
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
