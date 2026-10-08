// `replay record` — local daemon that receives events from the REPLAY Recorder
// extension (running inside Ego Lite) and writes them to a recording folder.
//
// The daemon binds 127.0.0.1 only. POSTs carrying a web-page Origin are refused,
// so ordinary websites cannot inject fake events; only the extension
// (chrome-extension:// origin) and local tools (no Origin) can write.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DAEMON_PORT, DAEMON_URL, RECORDINGS, color, slug, stamp, writeJson, readJson } from './util.mjs';

const MAX_EVENTS = 100_000;

function allowed(req) {
  const origin = req.headers.origin;
  return !origin || origin.startsWith('chrome-extension://');
}

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

export async function daemonStatus() {
  try {
    const r = await fetch(`${DAEMON_URL}/status`, { signal: AbortSignal.timeout(800) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// Probe mode (used by setup/doctor): listen briefly and report whether the
// extension called home. Returns the extension version or null.
export function probeExtension({ timeoutMs = 15000, onListening } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      const url = new URL(req.url, DAEMON_URL);
      const fromExt = req.headers.origin?.startsWith('chrome-extension://');
      const ext = url.searchParams.get('ext') || (fromExt ? 'unknown' : null);
      res.end(JSON.stringify({ recording: false, probe: true }));
      if (ext && !done) { done = true; setTimeout(() => server.close(), 50); resolve(ext); }
    });
    server.on('error', () => { if (!done) { done = true; resolve(null); } });
    server.listen(DAEMON_PORT, '127.0.0.1', () => onListening?.());
    setTimeout(() => { if (!done) { done = true; server.close(); resolve(null); } }, timeoutMs);
  });
}

export async function record({ name, task = '', inputs = '', minutes = 120, screenshots = true, quiet = false } = {}) {
  const existing = await daemonStatus();
  if (existing?.recording) throw new Error(`已有录制在进行：${existing.name}（先 \`replay record stop\`）`);

  const id = `${stamp()}-${slug(name)}`;
  const dir = path.join(RECORDINGS, id);
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  const eventsPath = path.join(dir, 'events.jsonl');
  const out = fs.createWriteStream(eventsPath, { flags: 'a' });
  const startedAt = Date.now();
  let seq = 0;
  let extSeen = null;
  let stopped = false;

  const session = {
    schema: 'replay-recording/1',
    id, name, task, inputs,
    startedAt: new Date(startedAt).toISOString(),
    dir, eventsPath,
    status: 'recording',
  };
  writeJson(path.join(dir, 'session.json'), session);

  const write = (evt) => {
    if (seq >= MAX_EVENTS) return;
    seq += 1;
    let line = JSON.stringify({ seq, t: Date.now() - startedAt, ...evt });
    if (line.length > 20_000) line = JSON.stringify({ seq, t: Date.now() - startedAt, type: 'oversized_event_dropped', originalType: evt.type });
    out.write(line + '\n');
    if (!quiet && evt.type && !['request', 'scroll', 'page'].includes(evt.type)) {
      const label = evt.target ? `${evt.target.role || evt.target.tag} "${evt.target.name || evt.target.text || ''}"` : (evt.url || evt.filename || '');
      process.stdout.write(color.dim(`  #${seq} ${evt.type} ${String(label).slice(0, 80)}\n`));
    }
  };

  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url, DAEMON_URL);
    try {
      if (req.method === 'GET' && url.pathname === '/status') {
        const ext = url.searchParams.get('ext');
        if (ext && !extSeen) { extSeen = ext; if (!quiet) console.log(color.green(`  ✓ 已连接 REPLAY Recorder 扩展 v${ext}`)); }
        return res.end(JSON.stringify({ recording: !stopped, name, id, seq, screenshots }));
      }
      if (req.method !== 'POST') { res.statusCode = 404; return res.end('{}'); }
      if (!allowed(req)) { res.statusCode = 403; return res.end('{"error":"origin"}'); }
      const body = await readBody(req);
      if (url.pathname === '/event') { if (!stopped) write(body); return res.end('{"ok":true}'); }
      if (url.pathname === '/shot') {
        const m = /^data:image\/jpeg;base64,(.+)$/.exec(body.dataUrl || '');
        if (m && !stopped) fs.writeFileSync(path.join(dir, 'shots', `${slug(body.id, 'shot')}.jpg`), Buffer.from(m[1], 'base64'));
        return res.end('{"ok":true}');
      }
      if (url.pathname === '/mark') { write({ source: 'cli', type: 'mark', note: String(body.note || '').slice(0, 500) }); return res.end('{"ok":true}'); }
      if (url.pathname === '/hello') { extSeen = body.version || extSeen; return res.end('{"ok":true}'); }
      if (url.pathname === '/stop') { res.end('{"ok":true}'); finish(body.by || 'api'); return; }
      res.statusCode = 404; res.end('{}');
    } catch (e) {
      res.statusCode = 400; res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  });

  function finish(reason) {
    if (stopped) return;
    stopped = true;
    write({ source: 'cli', type: 'stop', reason });
    // Give the extension one status poll to clear its REC badge.
    setTimeout(() => {
      out.end(() => {
        server.close();
        const s = { ...readJson(path.join(dir, 'session.json'), session), status: 'stopped', endReason: reason, endedAt: new Date().toISOString(), events: seq, extension: extSeen };
        writeJson(path.join(dir, 'session.json'), s);
        resolveDone(s);
      });
    }, 1600);
  }

  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error(`端口 ${DAEMON_PORT} 被占用（另一个 replay record？）`) : e));
    server.listen(DAEMON_PORT, '127.0.0.1', resolve);
  });

  write({ source: 'cli', type: 'start', task, inputs });
  process.once('SIGINT', () => finish('sigint'));
  process.once('SIGTERM', () => finish('sigterm'));
  const timer = setTimeout(() => finish('time_limit'), minutes * 60_000);
  timer.unref();

  return { id, dir, done };
}

export async function stopRecording() {
  try {
    const r = await fetch(`${DAEMON_URL}/stop`, { method: 'POST', body: '{"by":"cli"}', headers: { 'content-type': 'application/json' } });
    return r.ok;
  } catch { return false; }
}

export async function markRecording(note) {
  try {
    const r = await fetch(`${DAEMON_URL}/mark`, { method: 'POST', body: JSON.stringify({ note }), headers: { 'content-type': 'application/json' } });
    return r.ok;
  } catch { return false; }
}

export function listRecordings() {
  if (!fs.existsSync(RECORDINGS)) return [];
  return fs.readdirSync(RECORDINGS).sort().reverse()
    .map((id) => readJson(path.join(RECORDINGS, id, 'session.json')))
    .filter(Boolean);
}

export function resolveRecording(ref) {
  if (!ref) return listRecordings()[0] || null;
  if (fs.existsSync(path.join(ref, 'session.json'))) return readJson(path.join(ref, 'session.json'));
  return listRecordings().find((s) => s.id === ref || s.id.endsWith(ref) || s.name === ref) || null;
}
