// Commander-facing loop: open → goal → look → act → look … → end.
// The commander (slow model) calls these; each call returns Jev's compressed
// view (~10 lines), so the commander never reads a full tree or a screenshot
// unless Jev says the screen has no readable structure.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPLAY_HOME, REPO_ROOT, egoRun, readJson, writeJson, color, BAD } from './util.mjs';
import { judge, formatView } from './judge.mjs';

const SESSION = path.join(REPLAY_HOME, 'session.json');
const WEB = pathToFileURL(path.join(REPO_ROOT, 'src', 'web.mjs')).href;

export function loadSession() { return readJson(SESSION, null); }
export function save(s) { writeJson(SESSION, s); }
export function newSession() {
  return { id: new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19), surface: null, spaceId: null, target: null, goal: '', values: {}, hints: [], history: [], candidates: {}, lastDecision: null, stats: { looks: 0, acts: 0, autoActs: 0, commanderActs: 0, jevCalls: 0, jevMs: 0, observeMs: 0, actMs: 0, started: Date.now() } };
}
export function trace(s, rec) {
  const dir = path.join(REPLAY_HOME, 'sessions', s.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'trace.jsonl'), JSON.stringify({ t: Date.now(), ...rec }) + '\n');
}

export function parseValues(list) {
  // k=v or k=v::hint
  return Object.fromEntries((list || []).map((kv) => {
    const i = kv.indexOf('=');
    const k = kv.slice(0, i);
    const [value, hint] = kv.slice(i + 1).split('::');
    return [k, { value, hint: hint || k }];
  }));
}

// ---- surface plumbing -------------------------------------------------------

function egoWeb(s, action, cand) {
  const script = `const { observeWeb, actWeb } = await import(${JSON.stringify(WEB)});
const task = await taskSpace(${s.spaceId ? Number(s.spaceId) : JSON.stringify('REPLAY ' + (s.goal || 'session').slice(0, 40))});
const page = task.page("p1");
let act = null, actErr = null;
${action ? `try { act = await actWeb(page, ${JSON.stringify(cand || null)}, ${JSON.stringify(action)}); } catch (e) { actErr = String(e.message || e).slice(0, 400); }` : ''}
const obs = await observeWeb(page);
console.log("__OBS__" + JSON.stringify({ spaceId: task.spaceId, act, actErr, obs }));`;
  const r = egoRun(script, { timeout: 120_000 });
  const line = (r.out + '\n' + r.err).split('\n').find((l) => l.startsWith('__OBS__'));
  if (!line) throw new Error(`Ego 没有返回观察结果：${(r.err || r.out).slice(-600)}`);
  const o = JSON.parse(line.slice(7));
  s.spaceId = o.spaceId;
  return o;
}

// Windows come and go: follow a dialog the app just opened, and fall back to
// the window we came from when the current one (a dialog) has closed.
function syncTarget(D, s, acted) {
  const ws = D.listWindows();
  if (!ws.some((w) => w.window_id === s.target.window_id) && s.prevTargets?.length) {
    const gone = s.target.title;
    s.target = s.prevTargets.pop();
    s.history.push(`(window "${gone}" closed; back to "${s.target.title}")`);
  }
  if (!acted) return;
  spawnSync('sleep', ['0.6']);
  const dlg = D.listWindows().find((w) => w.pid === s.target.pid && w.window_id !== s.target.window_id && w.is_on_screen && /^(打开|Open|存储|Save|另存为|Save As)$/.test(w.title || '') && w.bounds.height > 200);
  if (dlg) {
    (s.prevTargets ||= []).push(s.target);
    s.target = { pid: dlg.pid, window_id: dlg.window_id, app_name: dlg.app_name, title: dlg.title, app: s.target.app };
    s.history.push(`(dialog "${dlg.title}" opened; now looking at it)`);
  }
}

async function desktopIO(s, action, cand) {
  const D = await import('./desktop.mjs');
  let act = null, actErr = null;
  if (action) { try { act = D.actDesktop(s.target, cand, action); } catch (e) { actErr = String(e.message || e).slice(0, 400); } }
  syncTarget(D, s, act && !actErr);
  const obs = D.observeDesktop(s.target);
  return { act, actErr, obs };
}

export function pickTarget(D, { app, app_name, title, windowId, window_id } = {}) {
  const w = D.findWindow({ app: app || app_name, title, windowId: windowId || undefined });
  return { pid: w.pid, window_id: w.window_id, app_name: w.app_name, title: w.title, app: app || app_name };
}

export async function observeAndJudge(s, { action = null, cand = null } = {}) {
  const t0 = Date.now();
  const io = s.surface === 'desktop' ? await desktopIO(s, action, cand) : egoWeb(s, action, cand);
  const ioMs = Date.now() - t0;
  if (action) {
    s.stats.acts++;
    s.stats.actMs += io.act?.ms || 0;
    const what = `${action.op}${cand ? ` ${cand.role} "${(cand.name || '').slice(0, 40)}"` : ''}${action.valueKey ? ` ← ${action.valueKey}` : action.key ? ` ${action.key}` : action.keys ? ` ${action.keys.join('+')}` : ''}`;
    if (action.op !== 'goto' || io.actErr) s.history.push(io.actErr ? `${what} → FAILED: ${io.actErr.slice(0, 80)}` : what);
  }
  s.stats.observeMs += io.obs.ms || 0;
  let view;
  try {
    view = await judge(io.obs, { goal: s.goal || '(no goal set)', values: s.values, hints: s.hints, history: s.history });
  } catch (e) {
    view = { surface: io.obs.surface, where: io.obs.where, title: io.obs.title, state: {}, ranked: [], total: io.obs.candidates.length, decision: { auto: false, why: `Jev 调用失败：${String(e.message).slice(0, 120)}` }, jev: null };
  }
  if (view.jev) { s.stats.jevCalls++; s.stats.jevMs += view.jev.ms; }
  s.stats.looks++;
  s.candidates = Object.fromEntries(io.obs.candidates.map((c) => [String(c.id), c]));
  s.lastDecision = view.decision;
  s.lastObs = { surface: io.obs.surface, where: io.obs.where, title: io.obs.title, noStructure: !!io.obs.noStructure, reason: io.obs.reason, snapshotId: io.obs.snapshotId };
  trace(s, { kind: action ? 'act+look' : 'look', action, cand: cand ? { id: cand.id, name: cand.name } : null, actErr: io.actErr, ioMs, view: { ...view, ranked: view.ranked.map((c) => ({ id: c.id, name: c.name, p: c.p })) } });
  save(s);
  return { view, io };
}

function print({ view, io }, { all = false } = {}, s) {
  if (io.actErr) console.log(`${BAD} 动作失败：${io.actErr}`);
  else if (io.act) console.log(color.dim(`  动作 ${io.act.ms}ms${io.act.navigated ? ` → ${io.act.url}` : ''}`));
  console.log(formatView(view));
  if (s?.lastObs?.noStructure) console.log(color.yellow(`  （${s.lastObs.reason}）`));
  if (all) {
    console.log(color.dim('— 全部候选 —'));
    for (const c of Object.values(s.candidates)) console.log(color.dim(`  ${String(c.id).padEnd(6)} ${c.role} "${(c.name || '').slice(0, 70)}"${c.value ? ` = "${String(c.value).slice(0, 30)}"` : ''}${c.context ? ` ‹${c.context.slice(0, 30)}›` : ''}`));
    if (io.obs.texts?.length) console.log(color.dim(`  文字: ${io.obs.texts.slice(0, 30).join(' | ').slice(0, 1500)}`));
  }
}

// ---- commands ---------------------------------------------------------------

export async function cmdOpen({ url, app, title, windowId, goal, values, hints, fresh }) {
  let s = loadSession();
  if (!s || fresh) s = newSession();
  if (goal) { s.goal = goal; s.history = []; }
  if (values) s.values = { ...s.values, ...values };
  if (hints?.length) s.hints = hints;
  // --title alone means "a window of the app I am already on" (e.g. its dialog).
  if (!url && !app && title && s.surface === 'desktop' && s.target) app = s.target.app_name;
  if (app || windowId) {
    const D = await import('./desktop.mjs');
    if (s.surface === 'desktop' && s.target && !fresh) (s.prevTargets ||= []).push(s.target);
    s.surface = 'desktop';
    s.target = pickTarget(D, { app, title, windowId });
    print(await observeAndJudge(s), {}, s);
  } else {
    s.surface = 'web';
    const r = await observeAndJudge(s, url ? { action: { op: 'goto', value: url } } : {});
    print(r, {}, s);
    console.log(color.dim(`  Ego 空间 ${s.spaceId}`));
  }
}

export async function cmdGoal({ goal, values, hints }) {
  const s = loadSession() || newSession();
  s.goal = goal;
  s.history = [];
  if (values) s.values = { ...s.values, ...values };
  s.hints = hints || [];
  save(s);
  console.log(`子目标：${goal}`);
}

export async function cmdLook({ all, on }) {
  const s = must();
  if (on) switchSurface(s, on);
  print(await observeAndJudge(s), { all }, s);
}

function switchSurface(s, on) {
  if (on === 'web') { if (!s.spaceId) throw new Error('还没有网页会话（replay open <url>）'); s.surface = 'web'; }
  else if (on === 'desktop') { if (!s.target) throw new Error('还没有桌面目标（replay open --app …）'); s.surface = 'desktop'; }
}

// spec: { id?, op?, value?, valueKey?, key?, keys?, auto? }
export async function cmdAct(spec) {
  const s = must();
  if (spec.on) switchSurface(s, spec.on);
  let { id, op } = spec;
  let action;
  let byJev = false;
  if (spec.auto) {
    const d = s.lastDecision;
    if (!d?.auto) { console.log(`${BAD} 上一次判断不允许自动执行：${d?.why || '还没有 look'}`); process.exitCode = 3; return; }
    id = d.id; op = d.op; byJev = true;
    action = { op, valueKey: d.valueKey, value: d.valueKey ? s.values[d.valueKey]?.value : undefined };
  } else {
    action = { op: op || 'click', value: spec.value, key: spec.key, keys: spec.keys };
    if (spec.valueKey) { action.valueKey = spec.valueKey; action.value = s.values[spec.valueKey]?.value; if (action.value == null) throw new Error(`没有值 ${spec.valueKey}`); }
  }
  const cand = id ? s.candidates[String(id)] : null;
  if (id && !cand) throw new Error(`上一次观察里没有 ${id}（先 replay look）`);
  if (byJev) s.stats.autoActs++; else s.stats.commanderActs++;
  print(await observeAndJudge(s, { action, cand }), {}, s);
}

const LOOP = pathToFileURL(path.join(REPO_ROOT, 'src', 'loop.mjs')).href;

// Inner loop for one sub-goal. Web runs entirely inside one Ego process.
export async function cmdDo({ goal, values, hints, maxSteps = 15, on }) {
  const s = must();
  if (on) switchSurface(s, on);
  const t0 = Date.now();
  const r = await runDo(s, { goal, values, hints, maxSteps });
  printDo(r, t0);
  if (r.status !== 'done') process.exitCode = 3;
}

export function printDo(r, t0) {
  for (const st of r.steps) console.log(`  ${st.err ? BAD : color.green('✓')} ${st.what}${st.p != null ? color.dim(`  p=${st.p.toFixed(2)}`) : ''}${color.dim(`  Jev ${st.jevMs}ms · 动作 ${st.actMs ?? '-'}ms`)}${st.err ? `  ${st.err}` : ''}`);
  const label = { done: '子目标完成（Jev 判断，需独立证据核验）', escalate: '交给指挥', max_steps: '达到步数上限' }[r.status] || r.status;
  console.log(`${r.status === 'done' ? color.green('■') : color.yellow('■')} ${label}：${r.why}  ${color.dim(`(${((Date.now() - t0) / 1000).toFixed(1)}s，自动 ${r.stats.autoActs} 步，Jev ${r.stats.jevCalls} 次)`)}`);
  if (r.view) console.log(formatView(r.view));
}

// Programmatic inner loop on the session's current surface; updates and saves s.
export async function runDo(s, { goal, values, hints, maxSteps = 15, expect = null }) {
  if (goal && goal !== s.goal) { s.goal = goal; s.history = []; }
  if (values) s.values = { ...s.values, ...values };
  if (hints) s.hints = hints;
  const t0 = Date.now();
  let r;
  if (s.surface === 'desktop') {
    const D = await import('./desktop.mjs');
    const { innerLoop } = await import('./loop.mjs');
    let acted = false;
    r = await innerLoop({ observe: async () => { syncTarget(D, s, acted); acted = false; return D.observeDesktop(s.target); }, act: async (c, a) => { const r = D.actDesktop(s.target, c, a); acted = true; return r; }, goal: s.goal, values: s.values, hints: s.hints, history: s.history, maxSteps, expect });
  } else {
    const script = `const { observeWeb, actWeb } = await import(${JSON.stringify(WEB)});
const { innerLoop } = await import(${JSON.stringify(LOOP)});
const task = await taskSpace(${Number(s.spaceId)});
const page = task.page("p1");
const r = await innerLoop({ observe: () => observeWeb(page), act: (c, a) => actWeb(page, c, a), goal: ${JSON.stringify(s.goal)}, values: ${JSON.stringify(s.values)}, hints: ${JSON.stringify(s.hints)}, history: ${JSON.stringify(s.history)}, maxSteps: ${Number(maxSteps)}, expect: ${JSON.stringify(expect)} });
console.log("__DO__" + JSON.stringify(r));`;
    const out = egoRun(script, { timeout: 15 * 60_000 });
    const line = (out.out + '\n' + out.err).split('\n').find((l) => l.startsWith('__DO__'));
    if (!line) throw new Error(`Ego 内循环没有返回：${(out.err || out.out).slice(-600)}`);
    r = JSON.parse(line.slice(6));
  }
  s.history = r.history;
  for (const k of ['jevCalls', 'jevMs', 'observeMs', 'actMs', 'autoActs']) s.stats[k] += r.stats[k];
  s.stats.looks += r.stats.jevCalls;
  s.stats.acts += r.stats.autoActs;
  s.stats.dos = (s.stats.dos || 0) + 1;
  if (r.obs) {
    s.candidates = Object.fromEntries(r.obs.candidates.map((c) => [String(c.id), c]));
    s.lastObs = { surface: r.obs.surface, where: r.obs.where, title: r.obs.title, noStructure: !!r.obs.noStructure, reason: r.obs.reason };
  }
  s.lastDecision = r.view?.decision || null;
  trace(s, { kind: 'do', goal: s.goal, status: r.status, why: r.why, steps: r.steps, ms: Date.now() - t0 });
  save(s);
  return r;
}

export async function cmdEnd({ keep }) {
  const s = loadSession();
  if (!s) { console.log('没有进行中的会话'); return; }
  if (s.spaceId) {
    egoRun(`const task = await taskSpace(${Number(s.spaceId)}); await task.finish({ keep: ${keep ? '["p1"]' : '[]'} });`, { timeout: 60_000 });
  }
  console.log(statsLine(s));
  fs.mkdirSync(path.join(REPLAY_HOME, 'sessions', s.id), { recursive: true });
  fs.renameSync(SESSION, path.join(REPLAY_HOME, 'sessions', s.id, 'session.json'));
}

export function statsLine(s) {
  const st = s.stats;
  const wall = ((Date.now() - st.started) / 1000).toFixed(1);
  return `会话 ${s.id}：观察 ${st.looks} 次、动作 ${st.acts} 次（Jev 自动 ${st.autoActs} / 计划内确认 ${st.planActs || 0} / 指挥 ${st.commanderActs}），Jev ${st.jevCalls} 次共 ${(st.jevMs / 1000).toFixed(1)}s，观察 ${(st.observeMs / 1000).toFixed(1)}s，动作 ${(st.actMs / 1000).toFixed(1)}s，总 ${wall}s`;
}

function must() {
  const s = loadSession();
  if (!s) throw new Error('没有会话：先 replay open <url> 或 replay open --app <应用>');
  return s;
}
