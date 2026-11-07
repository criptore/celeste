import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addHooks, removeHooks, EVENTS } from '../scripts/hooks.js';

test('install adds one http hook per event, keeps other hooks, and is idempotent', () => {
  const mine = {type:'command', command:'echo hi'};
  const s = {model:'x', hooks:{PreToolUse:[{matcher:'Bash', hooks:[mine]}]}};
  addHooks(s); addHooks(s);
  for (const ev of EVENTS) assert.equal(s.hooks[ev].filter(g => g.hooks.some(h => h.type === 'http')).length, 1, ev);
  assert.deepEqual(s.hooks.PreToolUse[0].hooks[0], mine);
  assert.equal(s.hooks.PreToolUse[1].matcher, '*');
  assert.equal(s.hooks.PermissionRequest, undefined);
  removeHooks(s);
  assert.deepEqual(s, {model:'x', hooks:{PreToolUse:[{matcher:'Bash', hooks:[mine]}]}});
});

test('approvals add a PermissionRequest hook with a long timeout', () => {
  const s = addHooks({}, {approvals:true});
  assert.equal(s.hooks.PermissionRequest[0].hooks[0].timeout, 60);
  assert.deepEqual(removeHooks(s), {});
});
