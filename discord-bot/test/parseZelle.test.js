import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, parseAmountToCents, parseZelleEmail } from '../src/payments/parseZelle.js';

const CHASE = {
  from: 'no.reply.alerts@chase.com',
  subject: 'You received $50.00 from JUAN PEREZ with Zelle®',
  text: 'JUAN PEREZ sent you $50.00 with Zelle®.\nMemo: VIP-7K3QDM\nThe money is in your account.',
  messageId: '<abc@chase.com>',
  date: new Date('2026-01-05T10:00:00Z'),
};

test('parseAmountToCents understands thousand separators', () => {
  assert.equal(parseAmountToCents('50.00'), 5000);
  assert.equal(parseAmountToCents('1,234.50'), 123450);
  assert.equal(parseAmountToCents('200'), 20000);
  assert.equal(parseAmountToCents('abc'), null);
});

test('reads a typical Zelle received notification', () => {
  const parsed = parseZelleEmail(CHASE);
  assert.equal(parsed.isPayment, true);
  assert.equal(parsed.amountCents, 5000);
  assert.deepEqual(parsed.codes, ['VIP-7K3QDM']);
  assert.equal(parsed.senderName, 'JUAN PEREZ');
  assert.equal(parsed.memo, 'VIP-7K3QDM');
  assert.equal(parsed.source, 'zelle-email');
});

test('reads notifications written in Spanish', () => {
  const parsed = parseZelleEmail({
    from: 'alertas@banco.com',
    subject: 'Recibiste un pago por Zelle',
    text: 'MARIA LOPEZ te envio $200.00 mediante Zelle. Nota: vip 4h9x2b',
  });
  assert.equal(parsed.isPayment, true);
  assert.equal(parsed.amountCents, 20000);
  assert.deepEqual(parsed.codes, ['VIP-4H9X2B']);
});

test('falls back to the HTML body when there is no plain text', () => {
  const parsed = parseZelleEmail({
    from: 'alerts@notify.wellsfargo.com',
    subject: 'Zelle payment received',
    html: '<html><body><p>ANA RUIZ sent you <b>$100.00</b> with Zelle.</p><p>Memo: VIP-<b>AAAA22</b></p></body></html>',
  });
  assert.equal(parsed.isPayment, true);
  assert.equal(parsed.amountCents, 10000);
  assert.deepEqual(parsed.codes, ['VIP-AAAA22']);
});

test('ignores notifications about outgoing payments', () => {
  const parsed = parseZelleEmail({
    from: 'no.reply.alerts@chase.com',
    subject: 'You sent $50.00 with Zelle®',
    text: 'You sent $50.00 to JUAN PEREZ with Zelle®. Memo: VIP-7K3QDM',
  });
  assert.equal(parsed.isPayment, false);
  assert.match(parsed.reason, /outgoing/);
});

test('ignores emails that never mention Zelle', () => {
  const parsed = parseZelleEmail({
    from: 'newsletter@shop.com',
    subject: 'Sale',
    text: 'You received $50.00 in coupons. VIP-7K3QDM',
  });
  assert.equal(parsed.isPayment, false);
  assert.match(parsed.reason, /Zelle/);
});

test('rejects senders outside the allowlist', () => {
  const parsed = parseZelleEmail(
    { ...CHASE, from: 'scammer@gmail.com' },
    { allowedSenders: ['chase.com', 'wellsfargo.com'] },
  );
  assert.equal(parsed.isPayment, false);
  assert.match(parsed.reason, /Untrusted sender/);
});

test('accepts an allowlisted sender', () => {
  const parsed = parseZelleEmail(CHASE, { allowedSenders: ['chase.com'] });
  assert.equal(parsed.isPayment, true);
});

test('a payment with no code is detected but carries no codes', () => {
  const parsed = parseZelleEmail({ ...CHASE, text: 'JUAN PEREZ sent you $50.00 with Zelle. Memo: thanks' });
  assert.equal(parsed.isPayment, true);
  assert.deepEqual(parsed.codes, []);
});

test('htmlToText leaves readable text', () => {
  assert.equal(htmlToText('<p>Hello<br>world</p>'), 'Hello\nworld');
  assert.equal(htmlToText('<script>bad()</script><p>ok</p>'), 'ok');
});
