import test from 'node:test';
import assert from 'node:assert/strict';
import { BUY_PREFIX, STATUS_BUTTON, storefrontMessage, tierFromButton } from '../src/vip/storefront.js';
import { TICKET_OPEN } from '../src/vip/tickets.js';

const config = {
  guildId: 'g',
  subscriptionDays: 30,
  tiers: {
    1: { priceCents: 5000, roleId: 'r1', label: 'Signals', perks: ['signals'] },
    2: { priceCents: 10000, roleId: 'r2', label: 'VIP', perks: ['vip room'] },
    3: { priceCents: 20000, roleId: 'r3', label: 'Elite', perks: ['calls'] },
  },
};

const buttons = (message) => message.components.flatMap((row) => row.toJSON().components);

test('every sellable tier gets its own button, priced', () => {
  const labels = buttons(storefrontMessage(config))
    .filter((button) => button.custom_id?.startsWith(BUY_PREFIX))
    .map((button) => button.label);

  assert.deepEqual(labels, ['Signals — $50.00', 'VIP — $100.00', 'Elite — $200.00']);
});

test('a tier that is coming soon has no button to press', () => {
  const partial = { ...config, tiers: { ...config.tiers, 3: { ...config.tiers[3], roleId: undefined } } };
  const ids = buttons(storefrontMessage(partial)).map((button) => button.custom_id);

  assert.ok(ids.includes(`${BUY_PREFIX}1`));
  assert.ok(!ids.includes(`${BUY_PREFIX}3`), 'nothing to click on a locked tier');
  assert.match(storefrontMessage(partial).embeds[0].toJSON().fields[2].value, /Coming soon/);
});

test('the panel also offers status and the ticket button', () => {
  const ids = buttons(storefrontMessage(config)).map((button) => button.custom_id);
  assert.ok(ids.includes(STATUS_BUTTON));
  assert.ok(ids.includes(TICKET_OPEN));
});

test('the welcome DM drops the ticket button and links back to the server', () => {
  const message = storefrontMessage(config, { includeTicket: false, welcome: true });
  const all = buttons(message);

  assert.ok(!all.some((button) => button.custom_id === TICKET_OPEN), 'a ticket needs a guild');
  assert.ok(all.some((button) => button.url === 'https://discord.com/channels/g'));
  assert.match(message.embeds[0].toJSON().title, /Welcome/);
});

test('with nothing on sale the panel still renders instead of crashing', () => {
  const none = { ...config, tiers: { 1: { priceCents: 5000, perks: [] }, 2: { priceCents: 1, perks: [] }, 3: { priceCents: 1, perks: [] } } };
  const message = storefrontMessage(none);

  assert.equal(message.components.length, 1, 'only the status row');
  assert.ok(buttons(message).some((button) => button.custom_id === STATUS_BUTTON));
});

test('the button id says which tier was pressed', () => {
  assert.equal(tierFromButton('vip:buy:2'), 2);
  assert.equal(tierFromButton('vip:status'), null);
  assert.equal(tierFromButton(undefined), null);
});
