// Shared settings: port, data folder, .env loading. No secrets are ever logged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (KEY=value lines, # comments). Existing env vars win.
export function loadEnv(file = path.join(ROOT, '.env')) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined && v !== '') process.env[m[1]] = v;
  }
}
loadEnv();

export const PORT = Number(process.env.CELESTE_PORT || 4747);
export const HOST = '127.0.0.1';
export const HOOK_PATH = '/hook';
export const HOOK_TAG = 'src=celeste-hq';
export const HOOK_URL = `http://${HOST}:${PORT}${HOOK_PATH}?${HOOK_TAG}`;
export const DATA_DIR = process.env.CELESTE_DATA_DIR || path.join(os.homedir(), '.celeste-hq');
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const SUMMARY_MODEL = process.env.SUMMARY_MODEL || 'claude-haiku-5-5';
