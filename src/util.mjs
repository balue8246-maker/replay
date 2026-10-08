import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HOME = os.homedir();
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPLAY_HOME = process.env.REPLAY_HOME || path.join(HOME, '.replay');
export const RECORDINGS = path.join(REPLAY_HOME, 'recordings');
export const SKILLS = path.join(REPLAY_HOME, 'skills');
export const CONFIG_PATH = path.join(REPLAY_HOME, 'config.json');
export const EXTENSION_DIR = path.join(REPLAY_HOME, 'extension');
// One key file shared with the ego-jev skill so both read the same credential.
export const SECRETS_PATH = path.join(HOME, '.config', 'ego-jev', 'secrets.env');
export const DAEMON_PORT = Number(process.env.REPLAY_PORT || 47710);
export const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;

const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const color = { green: c(32), red: c(31), yellow: c(33), dim: c(2), bold: c(1), cyan: c(36) };
export const OK = color.green('✓');
export const BAD = color.red('✗');
export const WARN = color.yellow('!');

export function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
export function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
}
export function loadConfig() { return readJson(CONFIG_PATH, {}); }
export function saveConfig(patch) {
  const cfg = { ...loadConfig(), ...patch, updatedAt: new Date().toISOString() };
  writeJson(CONFIG_PATH, cfg);
  return cfg;
}

export function sh(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, ...opts });
  return { ok: r.status === 0, code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), error: r.error };
}

export function which(bin) {
  const extra = [path.join(HOME, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const r = sh('/usr/bin/which', [bin], { env: { ...process.env, PATH: `${process.env.PATH}:${extra.join(':')}` } });
  return r.ok ? r.out.split('\n')[0] : null;
}

export function egoBin() {
  return which('ego-browser');
}

// Run a script inside Ego's embedded Node runtime (where taskSpace() etc. exist).
export function egoRun(script, { timeout = 300_000, inherit = false } = {}) {
  const bin = egoBin();
  if (!bin) throw new Error('ego-browser CLI not found. Run `replay setup` first.');
  const r = spawnSync(bin, ['nodejs'], {
    input: script,
    encoding: 'utf8',
    timeout,
    stdio: inherit ? ['pipe', 'inherit', 'inherit'] : 'pipe',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: r.status === 0, code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

export function egoRunAsync(script, { timeout = 120_000 } = {}) {
  const bin = egoBin();
  if (!bin) return Promise.resolve({ ok: false, out: '', err: 'ego-browser CLI not found' });
  return new Promise((resolve) => {
    const child = spawn(bin, ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, out: out.trim(), err: err.trim() }); });
    child.stdin.end(script);
  });
}

export function prompt(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const write = rl._writeToOutput?.bind(rl);
      rl._writeToOutput = (s) => { if (!write) return; if (s.includes(question)) write(s); else write(s.replace(/[^\r\n]/g, '•')); };
    }
    rl.question(question, (ans) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(ans.trim()); });
  });
}

export async function confirm(question, def = true) {
  if (!process.stdin.isTTY) return def;
  const ans = (await prompt(`${question} ${def ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
  if (!ans) return def;
  return ans.startsWith('y') || ans === '是' || ans === '好';
}

export function slug(s, fallback = 'recording') {
  const t = String(s || '').trim().replace(/[\s/\\:*?"<>|]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return t || fallback;
}

export function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
