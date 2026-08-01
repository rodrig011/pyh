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

test('parseAmountToCents entiende separadores de miles', () => {
  assert.equal(parseAmountToCents('50.00'), 5000);
  assert.equal(parseAmountToCents('1,234.50'), 123450);
  assert.equal(parseAmountToCents('200'), 20000);
  assert.equal(parseAmountToCents('abc'), null);
});

test('lee un aviso tipico de Zelle recibido', () => {
  const parsed = parseZelleEmail(CHASE);
  assert.equal(parsed.isPayment, true);
  assert.equal(parsed.amountCents, 5000);
  assert.deepEqual(parsed.codes, ['VIP-7K3QDM']);
  assert.equal(parsed.senderName, 'JUAN PEREZ');
  assert.equal(parsed.memo, 'VIP-7K3QDM');
  assert.equal(parsed.source, 'zelle-email');
});

test('lee avisos en espanol', () => {
  const parsed = parseZelleEmail({
    from: 'alertas@banco.com',
    subject: 'Recibiste un pago por Zelle',
    text: 'MARIA LOPEZ te envio $200.00 mediante Zelle. Nota: vip 4h9x2b',
  });
  assert.equal(parsed.isPayment, true);
  assert.equal(parsed.amountCents, 20000);
  assert.deepEqual(parsed.codes, ['VIP-4H9X2B']);
});

test('lee el cuerpo HTML cuando no hay texto plano', () => {
  const parsed = parseZelleEmail({
    from: 'alerts@notify.wellsfargo.com',
    subject: 'Zelle payment received',
    html: '<html><body><p>ANA RUIZ sent you <b>$100.00</b> with Zelle.</p><p>Memo: VIP-<b>AAAA22</b></p></body></html>',
  });
  assert.equal(parsed.isPayment, true);
  assert.equal(parsed.amountCents, 10000);
  assert.deepEqual(parsed.codes, ['VIP-AAAA22']);
});

test('ignora los avisos de pagos enviados', () => {
  const parsed = parseZelleEmail({
    from: 'no.reply.alerts@chase.com',
    subject: 'You sent $50.00 with Zelle®',
    text: 'You sent $50.00 to JUAN PEREZ with Zelle®. Memo: VIP-7K3QDM',
  });
  assert.equal(parsed.isPayment, false);
  assert.match(parsed.reason, /enviado/);
});

test('ignora correos que no hablan de Zelle', () => {
  const parsed = parseZelleEmail({
    from: 'newsletter@tienda.com',
    subject: 'Promocion',
    text: 'You received $50.00 in coupons. VIP-7K3QDM',
  });
  assert.equal(parsed.isPayment, false);
  assert.match(parsed.reason, /Zelle/);
});

test('rechaza remitentes fuera de la lista blanca', () => {
  const parsed = parseZelleEmail(
    { ...CHASE, from: 'estafador@gmail.com' },
    { allowedSenders: ['chase.com', 'wellsfargo.com'] },
  );
  assert.equal(parsed.isPayment, false);
  assert.match(parsed.reason, /no autorizado/);
});

test('acepta al remitente autorizado', () => {
  const parsed = parseZelleEmail(CHASE, { allowedSenders: ['chase.com'] });
  assert.equal(parsed.isPayment, true);
});

test('un pago sin codigo se detecta pero sin codigos', () => {
  const parsed = parseZelleEmail({ ...CHASE, text: 'JUAN PEREZ sent you $50.00 with Zelle. Memo: gracias' });
  assert.equal(parsed.isPayment, true);
  assert.deepEqual(parsed.codes, []);
});

test('htmlToText deja el texto legible', () => {
  assert.equal(htmlToText('<p>Hola<br>mundo</p>'), 'Hola\nmundo');
  assert.equal(htmlToText('<script>malo()</script><p>ok</p>'), 'ok');
});
