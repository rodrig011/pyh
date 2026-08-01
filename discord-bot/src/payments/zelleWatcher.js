import { EventEmitter } from 'node:events';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createLogger } from '../lib/logger.js';
import { parseZelleEmail } from './parseZelle.js';

const log = createLogger('zelle');

/**
 * Revisa cada cierto tiempo el buzon donde el banco deja las notificaciones de
 * Zelle y emite un evento por cada pago recibido.
 *
 * Eventos:
 *   'payment'  -> (payment, email)   pago valido detectado
 *   'skipped'  -> (parsed, email)    correo descartado (con el motivo)
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
      log.warn('IMAP deshabilitado (IMAP_ENABLED=false): los pagos solo se podran confirmar a mano');
      return;
    }
    if (!this.imap.host || !this.imap.user || !this.imap.password) {
      log.warn('Faltan IMAP_HOST/IMAP_USER/IMAP_PASSWORD: no se revisara el correo');
      return;
    }
    this.stopped = false;
    const tick = () => {
      this.poll().catch((error) => {
        log.error(`Fallo la revision del correo: ${error.message}`);
        this.emit('error', error);
      });
    };
    tick();
    this.timer = setInterval(tick, Math.max(15, this.imap.pollSeconds) * 1000);
    log.info(`Vigilando ${this.imap.user} cada ${this.imap.pollSeconds}s`);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Una pasada por el buzon. Se puede llamar a mano (comando /vip-admin sincronizar). */
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
            log.info(`Pago detectado: ${parsed.amountCents} centavos, codigos=${parsed.codes.join(',') || 'ninguno'}`);
            this.emit('payment', parsed, email);
          } else {
            log.debug(`Correo ignorado (${parsed.reason}): ${email.subject}`);
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
