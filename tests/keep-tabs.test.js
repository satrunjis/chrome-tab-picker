import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeepCommand, planKeepTabs } from '../keep-tabs.js';

test('Alt+W state expires at five seconds, including a delayed background timer', () => {
  let now = 0, timer;
  const command = new KeepCommand({ now: () => now, schedule: callback => { timer = callback; return 1; }, unschedule() {} });
  command.arm();
  now = 4999;
  assert.equal(command.pending, true);
  now = 5000;
  assert.equal(command.consume(), false);
  command.arm();
  assert.equal(command.consume(), true);
  assert.equal(command.consume(), false, 'one digit must execute only once');
  command.arm();
  timer();
  assert.equal(command.pending, false);
  command.arm();
  command.cancel();
  assert.equal(command.pending, false);
});
test('keep plan preserves finder order, including filtered matches, across the full tab scope', () => {
  const tabs = [1, 2, 3, 4, 5, 6].map(id => ({ id }));
  const results = [tabs[4], tabs[1], tabs[5]];
  assert.deepEqual(planKeepTabs(tabs, results, 2), { scopeIds: [1, 2, 3, 4, 5, 6], keepIds: [5, 2] });
  assert.deepEqual(planKeepTabs(tabs, results, 9).keepIds, [5, 2, 6]);
  assert.equal(planKeepTabs(tabs, [], 1), null);
  for (const count of [0, 10, 1.5, '5']) assert.equal(planKeepTabs(tabs, results, count), null);
});
