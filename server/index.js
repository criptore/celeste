// Celeste HQ local server.
//   POST /hook          ← Claude Code hooks (configured by `npm run hooks:install`)
//   GET  /              → the 3D app
//   GET  /api/stream    → Server-Sent Events: snapshot + live events
//   POST /api/answer    → answer a permission request (when approvals are installed)
//   POST /api/launch    → start a new Claude Code session in a project (`claude -p`)
// Listens on 127.0.0.1 only. Browser routes need a per-run token, and /hook refuses browser requests.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT, PORT, HOST, HOOK_PATH, DATA_DIR, CLAUDE_DIR, SUMMARY_MODEL } from './config.js';
import { Store } from './state.js';
import { discoverProjects, agentDefsReader } from './discover.js';
import { Summarizer } from './summary.js';
import { startDemo } from './demo.js';

const args = new Set(process.argv.slice(2));
const DEMO = args.has('--demo');
const TOKEN = crypto.randomBytes(18).toString('base64url');

export function createServer({store, token = TOKEN, port = PORT} = {}){
  const clients = new Set();
  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  store.on('ev', e => { for (const c of clients) send(c, 'ev', e); });

  const sameOrigin = req => {
    const o = req.headers.origin;
    return !o || o === `http://${HOST}:${port}` || o === `http://localhost:${port}`;
  };
  const json = (res, code, obj) => { res.writeHead(code, {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store'}); res.end(JSON.stringify(obj)); };
  const readBody = (req, limit = 2_000_000) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit){ reject(new Error('trop gros')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e){ reject(e); } });
    req.on('error', reject);
  });
  const authed = (req, url) => sameOrigin(req) && (req.headers['x-celeste-token'] === token || url.searchParams.get('t') === token);

  const index = () => fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8').replace('__CELESTE_TOKEN__', token);
  const STATIC = {
    '/three.min.js':[path.join(ROOT, 'node_modules', 'three', 'build', 'three.min.js'), 'text/javascript'],
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${port}`);
    try {
      if (req.method === 'POST' && url.pathname === HOOK_PATH){
        // Claude Code sends no Origin header; a browser always does on a cross-site POST.
        if (req.headers.origin) return json(res, 403, {error:'origine refusée'});
        const body = await readBody(req);
        const out = store.handleHook(body);
        if (out && typeof out.then === 'function'){
          const decision = await out;
          if (decision) return json(res, 200, {hookSpecificOutput:{hookEventName:'PermissionRequest', decision}});
        }
        res.writeHead(200); return res.end();
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')){
        res.writeHead(200, {'content-type':'text/html; charset=utf-8', 'cache-control':'no-store', 'x-frame-options':'DENY'});
        return res.end(index());
      }
      if (req.method === 'GET' && STATIC[url.pathname]){
        const [file, type] = STATIC[url.pathname];
        res.writeHead(200, {'content-type':type, 'cache-control':'max-age=3600'});
        return fs.createReadStream(file).pipe(res);
      }
      if (url.pathname.startsWith('/api/')){
        if (!authed(req, url)) return json(res, 403, {error:'jeton invalide'});
        if (req.method === 'GET' && url.pathname === '/api/stream'){
          res.writeHead(200, {'content-type':'text/event-stream', 'cache-control':'no-store', connection:'keep-alive'});
          send(res, 'snapshot', store.snapshot());
          clients.add(res);
          const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
          req.on('close', () => { clearInterval(ping); clients.delete(res); });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, store.snapshot());
        if (req.method === 'POST' && url.pathname === '/api/answer'){
          const b = await readBody(req, 10_000);
          return json(res, 200, {ok:store.answer(String(b.id || ''), !!b.allow)});
        }
        if (req.method === 'POST' && url.pathname === '/api/launch'){
          const b = await readBody(req, 20_000);
          const p = store.projects.get(String(b.project || ''));
          const prompt = String(b.prompt || '').trim().slice(0, 4000);
          if (!p || !prompt) return json(res, 400, {error:'projet ou consigne manquant'});
          if (!fs.existsSync(p.key)) return json(res, 400, {error:`le dossier ${p.key} n'existe plus`});
          return json(res, 200, await launchClaude(p.key, prompt));
        }
      }
      json(res, 404, {error:'introuvable'});
    } catch (e){
      json(res, 400, {error:e.message});
    }
  });
}

// Starts `claude -p` in the project folder. The prompt goes through stdin, never through the
// command line, so nothing typed in the app can be interpreted by a shell.
function launchClaude(cwd, prompt){
  return new Promise(resolve => {
    fs.mkdirSync(path.join(DATA_DIR, 'logs'), {recursive:true});
    const log = fs.openSync(path.join(DATA_DIR, 'logs', `session-${Date.now()}.log`), 'a');
    let child;
    try {
      child = spawn('claude', ['-p'], {cwd, stdio:['pipe', log, log], detached:true, shell:process.platform === 'win32', windowsHide:true});
    } catch (e){ return resolve({ok:false, error:e.message}); }
    let done = false;
    child.on('error', e => { if (!done){ done = true; resolve({ok:false, error:e.code === 'ENOENT' ? 'commande « claude » introuvable : installe Claude Code et vérifie qu’il est dans le PATH' : e.message}); } });
    child.stdin.end(prompt);
    setTimeout(() => { if (!done){ done = true; child.unref(); resolve({ok:true}); } }, 400);
  });
}

function main(){
  const store = new Store({persistFile:path.join(DATA_DIR, 'projects.json'), agentDefs:agentDefsReader(CLAUDE_DIR)});
  if (!DEMO) store.seedProjects(discoverProjects(CLAUDE_DIR));
  const sweeper = setInterval(() => store.sweep(), 60_000); sweeper.unref();
  const summarizer = new Summarizer(store, {model:SUMMARY_MODEL, intervalMs:DEMO ? 15_000 : 30_000});
  summarizer.start();
  const server = createServer({store});
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') console.error(`[celeste] le port ${PORT} est déjà utilisé. Celeste HQ tourne peut-être déjà, ou change CELESTE_PORT dans .env.`);
    else console.error('[celeste]', e.message);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    const link = `http://${HOST}:${PORT}/`;
    console.log(`\n  Celeste HQ est lancé : ${link}`);
    console.log(`  Résumé « À retenir » : ${process.env.ANTHROPIC_API_KEY ? SUMMARY_MODEL : 'local (pas de ANTHROPIC_API_KEY dans .env)'}`);
    if (DEMO){ console.log('  Mode démo : des sessions fictives sont simulées.\n'); startDemo(store); }
    else console.log('  Si rien ne bouge, installe les hooks : npm run hooks:install\n');
    if (!args.has('--no-open')) openBrowser(link);
  });
}

function openBrowser(link){
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', link]] : process.platform === 'darwin' ? ['open', [link]] : ['xdg-open', [link]];
  try { const c = spawn(cmd[0], cmd[1], {stdio:'ignore', detached:true}); c.on('error', () => {}); c.unref(); } catch { /* no browser */ }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'server', 'index.js')) main();
