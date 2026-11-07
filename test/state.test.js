import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, projectRoot, roleFor, changeFor, describeTool } from '../server/state.js';

const mk = () => { const s = new Store({exists:() => false, permissionWaitMs:200}); const evs = []; s.on('ev', e => evs.push(e)); return {s, evs}; };
const base = {session_id:'s1', cwd:'/w/app', transcript_path:'', permission_mode:'default'};

test('projectRoot climbs to the git root', () => {
  assert.equal(projectRoot('/w/app/src/x', p => p === '/w/app/.git'), '/w/app');
  assert.equal(projectRoot('/w/other', () => false), '/w/other');
});

test('roles from agent types', () => {
  assert.equal(roleFor('Explore'), 'explore');
  assert.equal(roleFor('code-reviewer'), 'review');
  assert.equal(roleFor('test-runner'), 'test');
  assert.equal(roleFor('general-purpose'), 'back');
});

test('a session becomes a manager in an active project, and a prompt moves the CEO', () => {
  const {s, evs} = mk();
  s.handleHook({...base, hook_event_name:'SessionStart', source:'startup'});
  s.handleHook({...base, hook_event_name:'UserPromptSubmit', prompt:'Ajoute un mode sombre'});
  const m = s.agents.get('s:s1');
  assert.equal(m.kind, 'session'); assert.equal(m.project, '/w/app'); assert.equal(m.task, 'Ajoute un mode sombre');
  assert.equal(s.projects.get('/w/app').state, 'active');
  assert.ok(evs.some(e => e.t === 'prompt' && e.to === 's:s1'));
});

test('Agent call + SubagentStart creates a delegated sub-agent; tools are attributed by agent_id; SubagentStop removes it', () => {
  const {s, evs} = mk();
  s.handleHook({...base, hook_event_name:'PreToolUse', tool_name:'Agent', tool_input:{subagent_type:'Explore', description:'Cartographie les API'}});
  s.handleHook({...base, hook_event_name:'SubagentStart', agent_id:'ag1', agent_type:'Explore'});
  const a = s.agents.get('a:ag1');
  assert.equal(a.task, 'Cartographie les API'); assert.equal(a.parent, 's:s1'); assert.equal(a.tools.ro, true);
  assert.ok(evs.some(e => e.t === 'delegate' && e.from === 's:s1' && e.to === 'a:ag1'));
  s.handleHook({...base, agent_id:'ag1', agent_type:'Explore', hook_event_name:'PreToolUse', tool_name:'Read', tool_input:{file_path:'/w/app/src/a.ts'}});
  assert.equal(a.tools.used.Read, 1);
  assert.ok(evs.some(e => e.t === 'tool' && e.id === 'a:ag1' && e.arg === 'src/a.ts'));
  s.handleHook({...base, hook_event_name:'SubagentStop', agent_id:'ag1', last_assistant_message:'Fini'});
  assert.ok(!s.agents.has('a:ag1'));
  assert.ok(evs.some(e => e.t === 'leave' && e.id === 'a:ag1' && e.report === 'Fini'));
});

test('edits are counted as changes', () => {
  assert.deepEqual(changeFor('Edit', {old_string:'a', new_string:'a\nb\nc'}), {add:3, del:1});
  const {s} = mk();
  s.handleHook({...base, hook_event_name:'PostToolUse', tool_name:'Write', tool_input:{file_path:'/w/app/x.md', content:'1\n2'}, tool_response:{type:'create'}});
  assert.deepEqual(s.agents.get('s:s1').changes[0].file, 'x.md');
  assert.equal(describeTool('Bash', {command:'npm   test'}), 'npm test');
});

test('permission notification shows a request that the next tool call clears', () => {
  const {s} = mk();
  s.handleHook({...base, hook_event_name:'Notification', notification_type:'permission_prompt', message:'Claude needs your permission to use Bash'});
  const m = s.agents.get('s:s1');
  assert.equal(m.status, 'waiting'); assert.equal(m.request.canAnswer, false);
  s.handleHook({...base, hook_event_name:'PreToolUse', tool_name:'Bash', tool_input:{command:'ls'}});
  assert.equal(m.request, null);
});

test('PermissionRequest waits for the app answer, or gives no decision after the timeout', async () => {
  const {s} = mk();
  const p = s.handleHook({...base, hook_event_name:'PermissionRequest', tool_name:'Bash', tool_input:{command:'rm -rf dist'}});
  const req = s.agents.get('s:s1').request;
  assert.equal(req.canAnswer, true);
  assert.equal(s.answer(req.id, true), true);
  assert.deepEqual(await p, {behavior:'allow'});
  const p2 = s.handleHook({...base, hook_event_name:'PermissionRequest', tool_name:'Bash', tool_input:{command:'x'}});
  assert.equal(await p2, null);
});

test('SessionEnd removes the session and its sub-agents and pauses the project', () => {
  const {s} = mk();
  s.handleHook({...base, hook_event_name:'SubagentStart', agent_id:'ag2', agent_type:'Plan'});
  s.handleHook({...base, hook_event_name:'SessionEnd', reason:'other'});
  assert.equal(s.agents.size, 0);
  assert.equal(s.projects.get('/w/app').state, 'paused');
});
