import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCommands } from '../src/vip/commands.js';

// Three times now a subcommand has been handled by the router but never
// registered with Discord — the handler is written, the command does not exist,
// and nothing fails until somebody types a slash and finds nothing there.
// `node --check` cannot see it and no unit test touches the seam.
//
// This reads the routers for the subcommand names they branch on and checks
// each one against what is actually registered, in both directions.

const config = {
  guildId: 'g',
  modRoleIds: [],
  tiers: {
    1: { tier: 1, priceCents: 5000, roleId: 'r1', label: 'Signals', perks: ['x'] },
    2: { tier: 2, priceCents: 10000, roleId: 'r2', label: 'VIP', perks: ['x'] },
    3: { tier: 3, priceCents: 20000, roleId: 'r3', label: 'Elite', perks: ['x'] },
  },
  picks: {
    analystRoleIds: [],
    defaultMinutes: 15,
    defaultAsset: 'BTC',
    minimumForBoard: 5,
    disclaimer: 'nfa',
  },
};

const ROUTERS = ['src/vip/commands.js', 'src/picks/commands.js'];

function routedSubcommands() {
  const names = new Set();
  for (const file of ROUTERS) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/sub === '([a-z_-]+)'/g)) names.add(match[1]);
  }
  return names;
}

function registeredSubcommands() {
  const names = new Set();
  for (const command of buildCommands(config)) {
    for (const option of command.options ?? []) {
      if (option.type === 1) names.add(option.name);
    }
  }
  return names;
}

test('every subcommand the routers handle is registered with Discord', () => {
  const registered = registeredSubcommands();
  const missing = [...routedSubcommands()].filter((name) => !registered.has(name));

  assert.deepEqual(
    missing,
    [],
    `handled but never registered, so nobody can run them: ${missing.join(', ')}`,
  );
});

test('every registered subcommand is handled by a router', () => {
  const routed = routedSubcommands();
  const dead = [...registeredSubcommands()].filter((name) => !routed.has(name));

  assert.deepEqual(dead, [], `registered but nothing handles them: ${dead.join(', ')}`);
});

test('the subcommands that exist today are all present', () => {
  const registered = registeredSubcommands();
  for (const name of ['guide', 'panel', 'price', 'board', 'record', 'reset', 'sync', 'stats']) {
    assert.ok(registered.has(name), `/${name} is not registered`);
  }
});
