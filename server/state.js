// Turns raw Claude Code hook payloads into a small world model:
// projects (one per repository), managers (one per Claude Code session) and
// sub-agents (one per Agent/Task call). Every change is emitted as an `ev`
// event that the server forwards to the 3D front over Server-Sent Events.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

export const PALETTE = ['#4fc3b8', '#f0a35a', '#e07aa8', '#9bd35a', '#b78cf0', '#7cb8ff', '#ff8f5e', '#e6c34a', '#53b3c9', '#c98a5a', '#8fd1a8', '#d88fd0'];
const NAMES = ['Atlas', 'Scout', 'Blueprint', 'Lint', 'Pixel', 'Probe', 'Nova', 'Ledger', 'Echo', 'Orbit', 'Rivet', 'Glyph', 'Mono', 'Kit', 'Swatch', 'Bolt',
  'Ping', 'Vega', 'Juno', 'Byte', 'Pico', 'Flux', 'Iris', 'Onyx', 'Sol', 'Tide', 'Kilo', 'Neon', 'Zephyr', 'Cobalt', 'Lumen', 'Delta', 'Quartz', 'Comet',
  'Maple', 'Basil', 'Indigo', 'Saffron', 'Cedar', 'Fern'];
const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
export const BUILTIN_AGENTS = {
  'Explore': {tools:['Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch']},
  'Plan': {tools:['Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch']},
  'claude-code-guide': {tools:['Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch']},
  'statusline-setup': {tools:['Read', 'Edit']},
  'general-purpose': {tools:null},
};
const TEST_RE = /\b(test|tests|jest|vitest|pytest|playwright|mocha|cargo test|go test|phpunit|rspec)\b/i;

export const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
export function hash(s){ let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

export function projectRoot(cwd, exists = p => fs.existsSync(p)){
  if (!cwd) return 'inconnu';
  let dir = path.resolve(cwd);
  for (let i = 0; i < 40; i++){
    if (exists(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(cwd);
}

export function roleFor(agentType){
  const t = String(agentType || '').toLowerCase();
  if (/explor|search|find|scout/.test(t)) return 'explore';
  if (/plan|architect|design-doc/.test(t)) return 'plan';
  if (/review|lint|audit|secur/.test(t)) return 'review';
  if (/test|qa\b|e2e/.test(t)) return 'test';
  if (/front|ui|ux|css|design/.test(t)) return 'front';
  if (/doc|writ|readme|guide/.test(t)) return 'docs';
  return 'back';
}

const lines = s => (typeof s === 'string' && s.length ? s.split('\n').length : 0);
function rel(file, cwd){
  if (!file) return '';
  const r = cwd ? path.relative(cwd, file) : file;
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : path.basename(file);
}
export function describeTool(tool, input = {}, cwd){
  switch (tool){
    case 'Bash': return short(input.command, 70);
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': return rel(input.file_path, cwd);
    case 'NotebookEdit': return rel(input.notebook_path, cwd);
    case 'Grep': return short(input.pattern, 50);
    case 'Glob': return short(input.pattern, 50);
    case 'WebFetch': try { return new URL(input.url).hostname; } catch { return ''; }
    case 'WebSearch': return short(input.query, 50);
    case 'Agent': case 'Task': return short(input.description || input.prompt, 60);
    default: return '';
  }
}
export function changeFor(tool, input = {}, response = {}){
  if (tool === 'Edit') return {add:lines(input.new_string), del:lines(input.old_string)};
  if (tool === 'MultiEdit') return (input.edits || []).reduce((t, e) => ({add:t.add + lines(e.new_string), del:t.del + lines(e.old_string)}), {add:0, del:0});
  if (tool === 'Write') return {add:lines(input.content), del:0, created:response && response.type === 'create'};
  if (tool === 'NotebookEdit') return {add:lines(input.new_source) || 1, del:0};
  return null;
}

export class Store extends EventEmitter {
  constructor(opts = {}){
    super();
    this.now = opts.now || (() => Date.now());
    this.persistFile = opts.persistFile || null;
    this.agentDefs = opts.agentDefs || (() => null);
    this.exists = opts.exists;
    this.permissionWaitMs = opts.permissionWaitMs ?? 50_000;
    this.projects = new Map();
    this.agents = new Map();
    this.sessions = new Map();
    this.pendingCalls = new Map();
    this.waiting = new Map();      // request id -> resolve() for PermissionRequest hooks
    this.journal = [];
    this.important = [];
    this.digest = null;
    this.seq = 0;
    this.load();
  }

  /* ---------- persistence of the project list (names, colors, order) ---------- */
  load(){
    if (!this.persistFile) return;
    try {
      for (const p of JSON.parse(fs.readFileSync(this.persistFile, 'utf8'))) this.projects.set(p.key, {...p, state:'paused'});
    } catch { /* first run */ }
  }
  save(){
    if (!this.persistFile) return;
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => {
      const data = [...this.projects.values()].map(({key, name, color, order, firstSeen, lastActive}) => ({key, name, color, order, firstSeen, lastActive}));
      try { fs.mkdirSync(path.dirname(this.persistFile), {recursive:true}); fs.writeFileSync(this.persistFile, JSON.stringify(data, null, 2)); } catch (e) { console.error('[celeste] sauvegarde impossible :', e.message); }
    }, 300);
  }

  /* ---------- outputs ---------- */
  ev(e){ this.emit('ev', e); }
  log(agent, text, level = 1, projectKey){
    const entry = {id:++this.seq, ts:this.now(), agentId:agent ? agent.id : null, who:agent ? agent.name : 'Toi', role:agent ? agent.role : 'ceo',
      project:projectKey || (agent && agent.project) || null, text, level};
    this.journal.push(entry); if (this.journal.length > 400) this.journal.shift();
    if (level >= 2){ this.important.push(entry); if (this.important.length > 200) this.important.shift(); this.emit('important', entry); }
    this.ev({t:'journal', entry});
  }
  publicAgent(a){
    const {sessionId, lastEvent, cwd, ...rest} = a; return rest;
  }
  update(a){ this.ev({t:'update', agent:this.publicAgent(a)}); }
  snapshot(){
    return {projects:[...this.projects.values()].sort((a, b) => a.order - b.order), agents:[...this.agents.values()].map(a => this.publicAgent(a)),
      journal:this.journal.slice(-80), digest:this.digest, now:this.now()};
  }
  setDigest(d){ this.digest = d; this.ev({t:'digest', digest:d}); }

  /* ---------- projects ---------- */
  ensureProject(cwd, {active = true, lastActive} = {}){
    const key = projectRoot(cwd, this.exists);
    let p = this.projects.get(key);
    let isNew = false, resumed = false;
    if (!p){
      const order = this.projects.size;
      p = {key, name:path.basename(key) || key, color:PALETTE[order % PALETTE.length], order, firstSeen:lastActive || this.now(), lastActive:lastActive || this.now(), state:'paused'};
      this.projects.set(key, p); isNew = true; this.save();
    }
    if (lastActive && lastActive > (p.lastActive || 0)) p.lastActive = lastActive;
    if (active && p.state !== 'active'){ resumed = !isNew; p.state = 'active'; p.lastActive = this.now(); this.save(); this.ev({t:'project', project:p}); }
    else if (isNew) this.ev({t:'project', project:p});
    return {p, isNew, resumed};
  }
  seedProjects(list, {limit = 12, maxAgeDays = 120} = {}){
    const cutoff = this.now() - maxAgeDays * 86400e3;
    list.filter(x => x.cwd && x.lastActive >= cutoff).sort((a, b) => b.lastActive - a.lastActive).slice(0, limit)
      .forEach(x => this.ensureProject(x.cwd, {active:false, lastActive:x.lastActive}));
  }
  pauseIfEmpty(key){
    const p = this.projects.get(key);
    if (!p || [...this.agents.values()].some(a => a.project === key)) return;
    p.state = 'paused'; p.lastActive = this.now(); this.save(); this.ev({t:'project', project:p});
  }

  /* ---------- agents ---------- */
  uniqueName(seed){
    const used = new Set([...this.agents.values()].map(a => a.name));
    const base = NAMES[hash(seed) % NAMES.length];
    if (!used.has(base)) return base;
    for (let k = 1; k < NAMES.length; k++){ const n = NAMES[(hash(seed) + k) % NAMES.length]; if (!used.has(n)) return n; }
    let i = 2; while (used.has(base + ' ' + i)) i++; return base + ' ' + i;
  }
  ensureManager(b){
    const sid = b.session_id || 'inconnue';
    const id = 's:' + sid;
    let m = this.agents.get(id);
    if (m){ m.lastEvent = this.now(); return m; }
    const {p, isNew, resumed} = this.ensureProject(b.cwd);
    m = {id, kind:'session', sessionId:sid, cwd:b.cwd, project:p.key, name:this.uniqueName(sid), role:'lead', agentType:null, model:b.model || null,
      parent:null, task:'Attend une consigne', status:'idle', request:null, tools:{allowed:null, ro:false, used:{}}, changes:[], convo:[],
      started:this.now(), lastEvent:this.now()};
    this.agents.set(id, m); this.sessions.set(sid, id);
    this.ev({t:'join', agent:this.publicAgent(m)});
    if (isNew) this.log(m, `ouvre un nouveau projet : ${p.name}`, 3);
    else if (resumed) this.log(m, `reprend le projet ${p.name}`, 3);
    else this.log(m, `rejoint le projet ${p.name}`, 1);
    return m;
  }
  ensureSubagent(b, m){
    const id = 'a:' + b.agent_id;
    let a = this.agents.get(id);
    if (a){ a.lastEvent = this.now(); return a; }
    const type = b.agent_type || 'general-purpose';
    const calls = this.pendingCalls.get(m.sessionId) || [];
    let idx = calls.findIndex(c => c.type === type); if (idx < 0 && calls.length) idx = 0;
    const call = idx >= 0 ? calls.splice(idx, 1)[0] : null;
    const def = this.agentDefs(m.cwd, type) || BUILTIN_AGENTS[type] || null;
    const allowed = def && Array.isArray(def.tools) ? def.tools : null;
    a = {id, kind:'subagent', sessionId:m.sessionId, cwd:m.cwd, project:m.project, name:this.uniqueName(b.agent_id), role:roleFor(type), agentType:type,
      model:(def && def.model) || null, parent:m.id, task:call ? short(call.description || call.prompt, 160) : 'Sous-tâche confiée par ' + m.name,
      status:'working', request:null, tools:{allowed, ro:!!allowed && allowed.every(t => READ_ONLY.has(t)), used:{}}, changes:[], convo:[],
      started:this.now(), lastEvent:this.now()};
    this.agents.set(id, a);
    this.ev({t:'join', agent:this.publicAgent(a)});
    this.ev({t:'delegate', from:m.id, to:a.id, task:a.task});
    m.convo.unshift({with:a.name, text:a.task, me:true, ts:this.now()}); m.convo.length = Math.min(m.convo.length, 8);
    a.convo.unshift({with:m.name, text:a.task, me:false, ts:this.now()});
    this.update(m);
    this.log(m, `délègue à ${a.name} (${type}) : ${a.task}`, 1);
    return a;
  }
  actor(b){
    const m = this.ensureManager(b);
    return b.agent_id ? this.ensureSubagent(b, m) : m;
  }
  removeAgent(a, report){
    this.agents.delete(a.id);
    if (a.kind === 'session') this.sessions.delete(a.sessionId);
    if (a.request) this.resolveWaiting(a.request.id, null);
    this.ev({t:'leave', id:a.id, report:report || null});
  }
  setRequest(a, req){
    a.request = req; a.status = 'waiting'; this.update(a);
    this.log(a, `attend ta validation : ${req.text}`, 3);
    this.ev({t:'requests'});
  }
  clearRequest(a){
    if (!a || !a.request) return;
    this.resolveWaiting(a.request.id, null);
    a.request = null; a.status = 'working'; this.update(a); this.ev({t:'requests'});
  }
  resolveWaiting(id, decision){
    const w = this.waiting.get(id);
    if (w){ this.waiting.delete(id); clearTimeout(w.timer); w.resolve(decision); }
  }
  /** Answer a PermissionRequest from the app. Returns false when it already expired. */
  answer(reqId, allow){
    const a = [...this.agents.values()].find(x => x.request && x.request.id === reqId);
    if (!a || !this.waiting.has(reqId)) return false;
    this.resolveWaiting(reqId, allow ? {behavior:'allow'} : {behavior:'deny', message:'Refusé depuis Celeste HQ.'});
    this.log(null, `${allow ? 'valide' : 'refuse'} la demande de ${a.name}`, 2, a.project);
    a.request = null; a.status = 'working'; this.update(a); this.ev({t:'requests'});
    return true;
  }

  /* ---------- the hook dispatcher ---------- */
  handleHook(b){
    if (!b || typeof b !== 'object' || !b.hook_event_name) return null;
    const ev = b.hook_event_name;
    switch (ev){
      case 'SessionStart': {
        const m = this.ensureManager(b);
        if (b.model) m.model = typeof b.model === 'string' ? b.model : (b.model.display_name || b.model.id || m.model);
        if (b.source === 'resume') this.log(m, 'reprend une session existante', 1);
        this.update(m); return null;
      }
      case 'UserPromptSubmit': {
        const m = this.ensureManager(b);
        this.clearRequest(m);
        m.task = short(b.prompt, 160) || m.task; m.status = 'working';
        m.convo.unshift({with:'Toi', text:short(b.prompt, 240), me:false, ts:this.now()}); m.convo.length = Math.min(m.convo.length, 8);
        this.update(m);
        this.ev({t:'prompt', to:m.id, text:short(b.prompt, 90)});
        this.log(null, `confie à ${m.name} : ${short(b.prompt, 120)}`, 1, m.project);
        return null;
      }
      case 'PreToolUse': {
        const a = this.actor(b);
        if (a.request) this.clearRequest(a);
        const tool = b.tool_name || 'outil';
        a.status = 'working'; a.tools.used[tool] = (a.tools.used[tool] || 0) + 1; a.lastEvent = this.now();
        const arg = describeTool(tool, b.tool_input, a.cwd);
        a.lastTool = {tool, arg, ts:this.now()};
        if ((tool === 'Agent' || tool === 'Task') && !b.agent_id){
          const list = this.pendingCalls.get(a.sessionId) || [];
          list.push({type:(b.tool_input && b.tool_input.subagent_type) || 'general-purpose', description:b.tool_input && b.tool_input.description, prompt:b.tool_input && b.tool_input.prompt});
          this.pendingCalls.set(a.sessionId, list.slice(-10));
        }
        this.ev({t:'tool', id:a.id, tool, arg});
        this.update(a);
        this.log(a, `${tool}${arg ? ' ' + arg : ''}`, 0);
        return null;
      }
      case 'PostToolUse': {
        const a = this.actor(b);
        const tool = b.tool_name;
        const ch = changeFor(tool, b.tool_input, b.tool_response);
        if (ch){
          a.changes.unshift({file:describeTool(tool, b.tool_input, a.cwd), add:ch.add, del:ch.del, ts:this.now()}); a.changes.length = Math.min(a.changes.length, 12);
          this.update(a);
        }
        if (tool === 'Bash' && TEST_RE.test((b.tool_input && b.tool_input.command) || '')){
          const r = b.tool_response || {};
          const failed = r.interrupted || (typeof r.exit_code === 'number' && r.exit_code !== 0) || (typeof r.returnCode === 'number' && r.returnCode !== 0);
          this.log(a, failed ? 'signale des tests en échec' : 'a lancé les tests', failed ? 2 : 1);
        }
        return null;
      }
      case 'PostToolUseFailure': {
        const a = this.actor(b);
        const isTest = b.tool_name === 'Bash' && TEST_RE.test((b.tool_input && b.tool_input.command) || '');
        this.log(a, isTest ? 'signale des tests en échec' : `échec de ${b.tool_name}`, isTest ? 2 : 1);
        return null;
      }
      case 'Notification': {
        const a = this.actor(b);
        const type = b.notification_type || '';
        if (type === 'permission_prompt' || (!type && /permission/i.test(b.message || ''))){
          if (!(a.request && a.request.canAnswer)) this.setRequest(a, {id:'n' + (++this.seq), text:short(b.message || 'Demande de permission', 140), canAnswer:false});
        } else if (type === 'idle_prompt'){
          const m = this.ensureManager(b); m.status = 'idle'; this.update(m);
        }
        return null;
      }
      case 'PermissionRequest': {
        const a = this.actor(b);
        const id = 'p' + (++this.seq);
        const arg = describeTool(b.tool_name, b.tool_input, a.cwd);
        this.setRequest(a, {id, text:short(`${b.tool_name}${arg ? ' : ' + arg : ''}`, 140), canAnswer:true});
        return new Promise(resolve => {
          const timer = setTimeout(() => { this.waiting.delete(id); resolve(null); }, this.permissionWaitMs);
          this.waiting.set(id, {resolve, timer});
        });
      }
      case 'Stop': {
        const m = this.ensureManager(b);
        this.clearRequest(m);
        m.status = 'idle';
        if (b.last_assistant_message){ m.convo.unshift({with:'Toi', text:short(b.last_assistant_message, 240), me:true, ts:this.now()}); m.convo.length = Math.min(m.convo.length, 8); }
        this.update(m);
        this.log(m, 'a fini et attend ta réponse', 2);
        return null;
      }
      case 'SubagentStart': {
        const m = this.ensureManager(b);
        if (b.agent_id) this.ensureSubagent(b, m);
        return null;
      }
      case 'SubagentStop': {
        const a = this.agents.get('a:' + b.agent_id);
        if (!a) return null;
        const report = short(b.last_assistant_message, 200);
        const m = this.agents.get(a.parent);
        if (m){ m.convo.unshift({with:a.name, text:report || 'Mission terminée.', me:false, ts:this.now()}); m.convo.length = Math.min(m.convo.length, 8); this.update(m); }
        this.log(a, `a terminé : ${a.task}`, 2);
        this.removeAgent(a, report);
        return null;
      }
      case 'SessionEnd': {
        const id = this.sessions.get(b.session_id);
        const m = id && this.agents.get(id);
        if (!m) return null;
        for (const a of [...this.agents.values()]) if (a.sessionId === m.sessionId && a.kind === 'subagent') this.removeAgent(a);
        this.log(m, 'a fermé sa session', 2);
        this.removeAgent(m);
        this.pendingCalls.delete(m.sessionId);
        this.pauseIfEmpty(m.project);
        return null;
      }
      default: return null;
    }
  }

  /** Housekeeping for sessions that vanished without a SessionEnd (crash, closed terminal). */
  sweep({idleMs = 20 * 60e3, goneMs = 3 * 3600e3, subMs = 30 * 60e3} = {}){
    const now = this.now();
    for (const a of [...this.agents.values()]){
      const age = now - a.lastEvent;
      if (a.kind === 'subagent' && age > subMs) this.removeAgent(a);
      else if (a.kind === 'session' && age > goneMs){ this.handleHook({hook_event_name:'SessionEnd', session_id:a.sessionId}); }
      else if (a.kind === 'session' && age > idleMs && a.status === 'working'){ a.status = 'idle'; this.update(a); }
    }
  }
}
