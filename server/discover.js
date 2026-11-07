// Reads what Claude Code already keeps on disk:
//  - ~/.claude/projects/*/<session>.jsonl  → the projects you worked on before (shown as paused rooms)
//  - ~/.claude/agents/*.md and <project>/.claude/agents/*.md → each sub-agent's allowed tools and model
import fs from 'node:fs';
import path from 'node:path';

function firstCwd(file, maxBytes = 256 * 1024){
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')){
      if (!line.includes('"cwd"')) continue;
      try { const o = JSON.parse(line); if (o && typeof o.cwd === 'string') return o.cwd; } catch { /* partial line */ }
    }
  } catch { /* unreadable */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

export function discoverProjects(claudeDir){
  const root = path.join(claudeDir, 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root, {withFileTypes:true}).filter(d => d.isDirectory()); } catch { return []; }
  const out = [];
  for (const d of dirs){
    const dir = path.join(root, d.name);
    let newest = null;
    try {
      for (const f of fs.readdirSync(dir)){
        if (!f.endsWith('.jsonl')) continue;
        const st = fs.statSync(path.join(dir, f));
        if (!newest || st.mtimeMs > newest.mtime) newest = {file:path.join(dir, f), mtime:st.mtimeMs};
      }
    } catch { continue; }
    if (!newest) continue;
    const cwd = firstCwd(newest.file);
    if (cwd) out.push({cwd, lastActive:newest.mtime});
  }
  return out;
}

export function parseAgentFile(text){
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)){
    const kv = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  if (!meta.name) return null;
  const tools = meta.tools ? meta.tools.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : null;
  return {name:meta.name, tools, model:meta.model && meta.model !== 'inherit' ? meta.model : null};
}

/** Returns (cwd, agentType) → {tools, model} | null, reading agent files lazily and caching them for a minute. */
export function agentDefsReader(claudeDir){
  const cache = new Map();
  const readDir = dir => {
    const hit = cache.get(dir);
    if (hit && Date.now() - hit.at < 60e3) return hit.defs;
    const defs = {};
    try {
      for (const f of fs.readdirSync(dir)){
        if (!f.endsWith('.md')) continue;
        try { const d = parseAgentFile(fs.readFileSync(path.join(dir, f), 'utf8')); if (d) defs[d.name] = d; } catch { /* skip */ }
      }
    } catch { /* no folder */ }
    cache.set(dir, {at:Date.now(), defs});
    return defs;
  };
  return (cwd, type) => {
    if (!type) return null;
    const local = cwd ? readDir(path.join(cwd, '.claude', 'agents'))[type] : null;
    return local || readDir(path.join(claudeDir, 'agents'))[type] || null;
  };
}
