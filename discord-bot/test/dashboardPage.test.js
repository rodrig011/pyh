import test from 'node:test';
import assert from 'node:assert/strict';

import { dashboardPage } from '../src/dashboard/page.js';

test('dashboard exposes strict out-of-sample validation instead of only paper bankroll', () => {
  const page = dashboardPage('Test');
  for (const id of ['oosMarkets', 'oosTrades', 'oosWinRate', 'oosProfit']) {
    assert.match(page, new RegExp(`id="${id}"`));
  }
  assert.match(page, /REPLAY NOT VALIDATED/);
  assert.match(page, /fees and 1¢ slippage/);
});
