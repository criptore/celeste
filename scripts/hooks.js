#!/usr/bin/env node
// Adds (or removes) the Celeste HQ hooks in ~/.claude/settings.json.
//   node scripts/hooks.js install [--approvals]   then restart your Claude Code sessions
//   node scripts/hooks.js uninstall
// A backup of settings.json is written next to it before any change. Only entries pointing to
// the Celeste HQ URL are touched; your other hooks stay as they are.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_URL, HOOK_TAG, CLAUDE_DIR } from '../server/config.js';

export const EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'Notification', 'SubagentStart', 'SubagentStop', 'Stop'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);

const isOurs = h => h && h.type === 'http' && typeof h.url === 'string' && h.url.includes(HOOK_TAG);

export function removeHooks(settings){
  const hooks = settings.hooks || {};
  for (const ev of Object.keys(hooks)){
    if (!Array.isArray(hooks[ev])) continue;
    hooks[ev] = hooks[ev].map(g => ({...g, hooks:(g.hooks || []).filter(h => !isOurs(h))})).filter(g => g.hooks.length);
    if (!hooks[ev].length) delete hooks[ev];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  return settings;
}

export function addHooks(settings, {approvals = false, url = HOOK_URL} = {}){
  removeHooks(settings);
  settings.hooks = settings.hooks || {};
  const events = approvals ? [...EVENTS, 'PermissionRequest'] : EVENTS;
  for (const ev of events){
    const handler = {type:'http', url, timeout:ev === 'PermissionRequest' ? 60 : 3};
    const group = TOOL_EVENTS.has(ev) ? {matcher:'*', hooks:[handler]} : {hooks:[handler]};
    (settings.hooks[ev] = settings.hooks[ev] || []).push(group);
  }
  return settings;
}

function main(){
  const [cmd, ...rest] = process.argv.slice(2);
  const file = path.join(CLAUDE_DIR, 'settings.json');
  if (cmd !== 'install' && cmd !== 'uninstall'){
    console.log('Usage : node scripts/hooks.js install [--approvals] | uninstall'); process.exit(1);
  }
  let settings = {};
  if (fs.existsSync(file)){
    const raw = fs.readFileSync(file, 'utf8');
    try { settings = raw.trim() ? JSON.parse(raw) : {}; }
    catch (e){ console.error(`Impossible de lire ${file} (JSON invalide : ${e.message}). Rien n'a été modifié.`); process.exit(1); }
    const backup = `${file}.celeste-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.writeFileSync(backup, raw);
    console.log(`Sauvegarde : ${backup}`);
  } else fs.mkdirSync(CLAUDE_DIR, {recursive:true});

  if (cmd === 'install') addHooks(settings, {approvals:rest.includes('--approvals')});
  else removeHooks(settings);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  if (cmd === 'install'){
    console.log(`Hooks Celeste HQ installés dans ${file}.`);
    console.log(rest.includes('--approvals')
      ? 'Validations depuis l’app activées : Claude Code attend jusqu’à 50 s ta réponse dans Celeste HQ, puis affiche sa fenêtre habituelle.'
      : 'Les demandes de permission s’affichent dans l’app ; tu y réponds toujours dans Claude Code.');
    console.log('Redémarre tes sessions Claude Code pour qu’elles prennent les hooks en compte.');
  } else console.log(`Hooks Celeste HQ retirés de ${file}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
