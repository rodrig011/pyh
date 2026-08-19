import test from 'node:test';
import assert from 'node:assert/strict';
import { cardSection, comingSoonSection, manualMethods, manualSection } from '../src/vip/commands.js';

const config = {
  subscriptionDays: 30,
  zelleRecipient: 'pay@example.com',
  zelleRecipientName: 'King T',
  venmoRecipient: '@king-t',
};
const order = { code: 'VIP-7K3QDM', amountCents: 5000 };

test('with Stripe off the card block is empty — no button, no mention of one', () => {
  assert.deepEqual(cardSection(false, config, 5000), []);
});

test('what is not live yet is listed as coming soon', () => {
  const soon = comingSoonSection({ ...config, venmoRecipient: undefined }, false).join('\n');
  assert.match(soon, /Coming soon/i);
  assert.match(soon, /Card/);
  assert.match(soon, /Venmo/);
  assert.doesNotMatch(soon, /button/i);
});

test('each method drops off the coming-soon list once it is configured', () => {
  assert.match(comingSoonSection(config, false).join('\n'), /Card/, 'Venmo is live, card is not');
  assert.doesNotMatch(comingSoonSection(config, false).join('\n'), /Venmo/);

  assert.match(comingSoonSection({ ...config, venmoRecipient: undefined }, true).join('\n'), /Venmo/);
  assert.doesNotMatch(comingSoonSection({ ...config, venmoRecipient: undefined }, true).join('\n'), /Card/);

  assert.deepEqual(comingSoonSection(config, true), [], 'nothing left to tease');
});

test('with Stripe on it explains the recurring charge and points at the button', () => {
  const lines = cardSection(true, config, 5000).join('\n');
  assert.match(lines, /\$50\.00 every 30 days/);
  assert.match(lines, /button below/);
  assert.doesNotMatch(lines, /coming soon/i);
});

test('only the methods that are configured are offered', () => {
  assert.deepEqual(manualMethods(config).map((method) => method.label), ['Zelle', 'Venmo']);
  assert.deepEqual(
    manualMethods({ ...config, venmoRecipient: undefined }).map((method) => method.label),
    ['Zelle'],
  );
  assert.deepEqual(
    manualMethods({ zelleRecipient: '(set ZELLE_RECIPIENT)', venmoRecipient: '@king-t' }).map((m) => m.label),
    ['Venmo'],
    'the unset placeholder is not a real handle',
  );
});

test('both handles and the code appear in the instructions', () => {
  const block = manualSection(config, order).join('\n');
  assert.match(block, /Zelle or 💸 Venmo/);
  assert.match(block, /pay@example\.com/);
  assert.match(block, /@king-t/);
  assert.match(block, /VIP-7K3QDM/);
  assert.match(block, /\$50\.00/);
});

test('with one method the heading is singular', () => {
  const block = manualSection({ ...config, venmoRecipient: undefined }, order).join('\n');
  assert.match(block, /🏦 Zelle — one payment/);
  assert.doesNotMatch(block, /Venmo/);
});

test('with nothing configured the block disappears instead of showing an empty list', () => {
  assert.deepEqual(manualSection({ subscriptionDays: 30 }, order), []);
});

test('a checkout URL too long for a button becomes a link instead', async () => {
  const { BUTTON_URL_MAX } = await import('../src/vip/commands.js');

  // Stripe Checkout puts the whole session in the fragment; these routinely run
  // past Discord's limit, and Discord rejects the entire message when they do.
  const real =
    'https://checkout.stripe.com/c/pay/cs_live_' + 'a'.repeat(40) + '#' + 'fidkdWxOYHwnPyd1blpxYHZxWjA0'.repeat(30);

  assert.ok(real.length > BUTTON_URL_MAX, 'the fixture has to exceed the limit to prove anything');
  assert.equal(BUTTON_URL_MAX, 512);
});

test('Cash App and Venmo are offered but never promise automatic access', () => {
  const config = {
    subscriptionDays: 30,
    zelleRecipient: 'pay@example.com',
    venmoRecipient: '@Rodrigo-Herrera-57',
    cashAppRecipient: '$rherrera651',
  };
  const order = { amountCents: 5000, code: 'KT-1234', payerName: 'Rodrigo Herrera' };
  const text = manualSection(config, order).join('\n');

  assert.match(text, /\$rherrera651/);
  assert.match(text, /@Rodrigo-Herrera-57/);
  assert.match(text, /Cash App/);
  // The whole point: the buyer is told which one needs a human.
  assert.match(text, /checked by a mod/);
  assert.match(text, /Zelle\*\* lets you in on its own/);
  assert.doesNotMatch(text, /roles land by themselves/);
});

test('with only automatic methods the copy still promises automatic access', () => {
  const config = { subscriptionDays: 30, zelleRecipient: 'pay@example.com' };
  const text = manualSection(config, { amountCents: 5000, code: 'KT-1' }).join('\n');

  assert.match(text, /land by themselves/);
  assert.doesNotMatch(text, /checked by a mod/);
});

test('with only hand-checked methods nothing claims to be automatic', () => {
  const config = { subscriptionDays: 30, cashAppRecipient: '$rherrera651' };
  const text = manualSection(config, { amountCents: 5000, code: 'KT-1' }).join('\n');

  assert.match(text, /A mod checks the payment/);
  assert.doesNotMatch(text, /land by themselves/);
  assert.doesNotMatch(text, /on its own/);
});

test('the steps stay numbered in order however many methods there are', () => {
  const config = { subscriptionDays: 30, zelleRecipient: 'p@e.com', cashAppRecipient: '$x' };
  const withName = manualSection(config, { amountCents: 100, code: 'A', payerName: 'Rod' }).join('\n');

  assert.match(withName, /\*\*1\.\*\*/);
  assert.match(withName, /\*\*2\.\*\*/);
  assert.match(withName, /\*\*3\.\*\*/);
  assert.match(withName, /\*\*4\.\*\*/);
  assert.doesNotMatch(withName, /\*\*5\.\*\*/);
});
