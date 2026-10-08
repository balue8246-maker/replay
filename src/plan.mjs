// Task chain (P3). The commander writes or refines plan.json once; the runner
// walks its stages, running Jev inner loops, approved actions, waits, polls,
// checks and human nodes. Any stage that needs judgment beyond Jev stops the
// run with a state file; the commander resolves it (look/act) and resumes.
//
// plan.json
// { "name": "...", "inputs": { "key": { "hint": "...", "default": "..." } },
//   "stages": [
//     { "id": "s1", "type": "open",  "url": "https://..." }            // or "app"/"title" for desktop
//     { "id": "s2", "type": "do",    "goal": "...", "values": ["key"], "hints": ["..."], "maxSteps": 12 }
//     { "id": "s3", "type": "act",   "target": "Submit order", "op": "click" }   // plan-approved action
//     { "id": "s4", "type": "key",   "press": "return" | "hotkey": "cmd+shift+g" | "type": "{{key}}" }
//     { "id": "s5", "type": "wait",  "seconds": 600 }
//     { "id": "s6", "type": "poll",  "every": 600, "max": 12, "reload": true, "check": { ... } }
//     { "id": "s7", "type": "human", "message": "请扫码登录" }
//     { "id": "s8", "type": "check", "url": "**/post", "text": "...", "jev": "question", "file": "~/Downloads/*.csv" }
//   ] }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPLAY_HOME, readJson, writeJson, color, OK, BAD, WARN, egoRun } from './util.mjs';
import * as cu from './cu.mjs';
import { askJev } from './jev.mjs';
import { formatView } from './judge.mjs';

const RUNS = path.join(REPLAY_HOME, 'plans', 'runs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fill = (v, params) => (typeof v === 'string' ? v.replace(/\{\{(\w+)\}\}/g, (_, k) => params[k] ?? `{{${k}}}`) : v);
const expandHome = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

export function loadPlan(file) {
  const plan = readJson(file);
  if (!plan?.stages?.length) throw new Error(`不是有效的 plan：${file}`);
  plan.stages.forEach((st, i) => { st.id ||= `s${i + 1}`; });
  return plan;
}

function resolveParams(plan, given) {
  const params = {};
  for (const [k, spec] of Object.entries(plan.inputs || {})) params[k] = given[k] ?? spec.default;
  Object.assign(params, given);
  const missing = Object.keys(plan.inputs || {}).filter((k) => params[k] == null || params[k] === '');
  if (missing.length) throw new Error(`缺少输入：${missing.map((k) => `${k}（${plan.inputs[k].hint || k}）`).join('、')}`);
  return params;
}

export async function runPlan(file, { params: given = {}, fresh = true } = {}) {
  const plan = loadPlan(file);
  const params = resolveParams(plan, given);
  const id = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${(plan.name || 'plan').replace(/[^\w\u4e00-\u9fa5-]+/g, '-').slice(0, 30)}`;
  const state = { id, file: path.resolve(file), params, index: 0, status: 'running', stages: plan.stages.map((s) => ({ id: s.id, type: s.type, status: 'pending' })), started: Date.now() };
  if (fresh) { const s = cu.newSession(); s.planRun = id; cu.save(s); }
  return drive(plan, state);
}

export async function resumePlan(runId, { skip = false } = {}) {
  const dir = runId ? path.join(RUNS, runId) : latestRun();
  if (!dir) throw new Error('没有可续跑的 plan 运行');
  const state = readJson(path.join(dir, 'state.json'));
  const plan = loadPlan(state.file);
  if (skip) { state.stages[state.index].status = 'done'; state.stages[state.index].why = '指挥已手动完成'; state.index++; }
  state.status = 'running';
  return drive(plan, state);
}

function latestRun() {
  if (!fs.existsSync(RUNS)) return null;
  const d = fs.readdirSync(RUNS).sort().pop();
  return d ? path.join(RUNS, d) : null;
}

function persist(state) {
  const dir = path.join(RUNS, state.id);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'state.json'), state);
  return dir;
}

async function drive(plan, state) {
  console.log(`${color.bold('▶')} ${plan.name || 'plan'}  ${color.dim(`运行 ${state.id}，从第 ${state.index + 1}/${plan.stages.length} 段开始`)}`);
  while (state.index < plan.stages.length) {
    const stage = plan.stages[state.index];
    const rec = state.stages[state.index];
    const t0 = Date.now();
    rec.status = 'running';
    rec.startedAt = t0;
    persist(state);
    console.log(`\n${color.cyan(`[${state.index + 1}/${plan.stages.length}] ${stage.id} · ${stage.type}`)} ${color.dim(stage.goal || stage.target || stage.url || stage.message || '')}`);
    let res;
    try { res = await runStage(stage, state); } catch (e) { res = { status: 'fail', why: String(e.message || e) }; }
    rec.status = res.status;
    rec.why = res.why;
    rec.ms = Date.now() - t0;
    if (res.status === 'done') {
      console.log(`  ${OK} ${res.why || '完成'} ${color.dim(`${(rec.ms / 1000).toFixed(1)}s`)}`);
      state.index++;
      persist(state);
      continue;
    }
    state.status = res.status;
    const dir = persist(state);
    if (res.view) console.log(formatView(res.view));
    const how = {
      escalate: `交给指挥：处理后 \`replay plan resume\`（重跑本段）或 \`replay plan resume --skip\`（已手动完成本段）。可用 replay look / act 操作当前会话。`,
      human: `需要人：${stage.message || ''}。完成后 \`replay plan resume --skip\`。`,
      fail: `本段失败：修正 plan 或现场后 \`replay plan resume\`。`,
    }[res.status] || '';
    console.log(`  ${res.status === 'human' ? WARN : BAD} ${res.why}\n  ${color.dim(how)}\n  ${color.dim(`状态：${dir}/state.json`)}`);
    return { ...state, exit: res.status === 'human' ? 4 : res.status === 'escalate' ? 3 : 1 };
  }
  state.status = 'done';
  state.ms = Date.now() - state.started;
  const s = cu.loadSession();
  state.stats = s?.stats;
  persist(state);
  console.log(`\n${OK} 全部 ${plan.stages.length} 段完成，用时 ${(state.ms / 1000).toFixed(1)}s`);
  if (s) console.log(color.dim(`  ${cu.statsLine(s)}`));
  return { ...state, exit: 0 };
}

function session() {
  const s = cu.loadSession();
  if (!s) throw new Error('会话丢失');
  return s;
}

async function runStage(stage, state) {
  const P = state.params;
  switch (stage.type) {
    case 'open': {
      const s = session();
      if (stage.app || stage.title) {
        const D = await import('./desktop.mjs');
        if (s.surface === 'desktop' && s.target) (s.prevTargets ||= []).push(s.target);
        s.surface = 'desktop';
        s.target = cu.pickTarget(D, { app: stage.app, title: stage.title });
        cu.save(s);
        return { status: 'done', why: `桌面窗口 ${s.target.app_name}「${s.target.title}」` };
      }
      s.surface = 'web';
      s.goal = stage.goal || s.goal;
      const { io } = await cu.observeAndJudge(s, { action: { op: 'goto', value: fill(stage.url, P) } });
      if (io.actErr) return { status: 'fail', why: io.actErr };
      return { status: 'done', why: `打开 ${io.obs.where}（Ego 空间 ${s.spaceId}）` };
    }
    case 'do': {
      const s = session();
      const keys = stage.values || Object.keys(P);
      const values = Object.fromEntries(keys.filter((k) => P[k] != null).map((k) => [k, { value: String(P[k]), hint: stage.valueHints?.[k] || k }]));
      s.values = {};
      const t0 = Date.now();
      // Values stay out of the goal text: Jev sees the key, matches it to a field, and the runner types the value.
      const goalText = String(stage.goal).replace(/\{\{(\w+)\}\}/g, (_, k) => `provided value "${k}"`);
      const r = await cu.runDo(s, { goal: goalText, values, hints: (stage.hints || []).map((h) => String(h).replace(/\{\{(\w+)\}\}/g, (_, k) => `"${k}"`)), maxSteps: stage.maxSteps || 15, expect: stage.expect || null });
      cu.printDo({ ...r, view: null }, t0);
      if (r.status === 'done') {
        if (stage.check) { const c = await runCheck(stage.check, state); if (!c.ok) return { status: 'escalate', why: `Jev 说完成，但核验没过：${c.why}`, view: r.view }; return { status: 'done', why: `${r.why}；核验：${c.why}` }; }
        return { status: 'done', why: r.why };
      }
      // Escalation with an explicit stage end condition: the next stage may be an
      // approved act that is exactly what Jev was waiting for confirmation on.
      if (stage.until === 'confirm' && /需确认/.test(r.why)) return { status: 'done', why: `已推进到需确认的动作：${r.why}` };
      return { status: 'escalate', why: r.why, view: r.view };
    }
    case 'act': {
      const s = session();
      const name = fill(stage.target, P);
      const prevGoal = s.goal;
      s.goal = `Locate the single element whose label is "${name}" (${stage.op || 'click'} it).`;
      const { view } = await cu.observeAndJudge(s);
      s.goal = prevGoal;
      const top = view.ranked[0];
      if (!top || top.p < (stage.minP ?? 0.5)) return { status: 'escalate', why: `找不到「${name}」（Jev 最高 ${top ? top.p.toFixed(2) : '无'}）`, view };
      const cand = cu.loadSession().candidates[String(top.id)];
      const op = stage.op || 'click';
      const action = { op, value: fill(stage.value, P), valueKey: stage.valueKey, key: stage.key };
      if (stage.valueKey) action.value = String(P[stage.valueKey] ?? '');
      const s2 = cu.loadSession();
      s2.stats.planActs = (s2.stats.planActs || 0) + 1;
      const { io } = await cu.observeAndJudge(s2, { action, cand });
      if (io.actErr) return { status: 'escalate', why: `动作失败：${io.actErr}` };
      if (stage.check) { const c = await runCheck(stage.check, state); if (!c.ok) return { status: 'escalate', why: `动作后核验没过：${c.why}` }; }
      return { status: 'done', why: `${op}「${top.name}」(p=${top.p.toFixed(2)})${io.act?.navigated ? ` → ${io.act.url}` : ''}` };
    }
    case 'key': {
      const s = session();
      const action = stage.press ? { op: 'press', key: stage.press } : stage.hotkey ? { op: 'hotkey', keys: stage.hotkey.split('+') } : { op: 'type', value: expandHome(fill(stage.type, P)) };
      const { io } = await cu.observeAndJudge(s, { action });
      if (io.actErr) return { status: 'fail', why: io.actErr };
      return { status: 'done', why: `${action.op} ${action.key || action.keys?.join('+') || action.value}` };
    }
    case 'wait': {
      const ms = (stage.seconds || 0) * 1000;
      state.stages[state.index].wakeAt = Date.now() + ms;
      persist(state);
      await sleep(ms);
      return { status: 'done', why: `等待 ${stage.seconds}s` };
    }
    case 'poll': {
      const max = stage.max || 10;
      for (let i = 1; i <= max; i++) {
        if (stage.reload && cu.loadSession()?.surface === 'web') {
          const s = session();
          egoRun(`const t = await taskSpace(${Number(s.spaceId)}); const p = t.page("p1"); await p.reload(); await p.waitForLoadState("load", { timeout: 15000 }).catch(() => {});`, { timeout: 60_000 });
        }
        const c = await runCheck(stage.check, state);
        console.log(color.dim(`  轮询 ${i}/${max}：${c.ok ? '满足' : '未满足'}（${c.why}）`));
        if (c.ok) return { status: 'done', why: `第 ${i} 次轮询满足：${c.why}` };
        if (i < max) { state.stages[state.index].wakeAt = Date.now() + stage.every * 1000; persist(state); await sleep(stage.every * 1000); }
      }
      return { status: 'escalate', why: `轮询 ${max} 次仍未满足` };
    }
    case 'human':
      return { status: 'human', why: fill(stage.message, P) };
    case 'check': {
      const c = await runCheck(stage, state);
      return c.ok ? { status: 'done', why: c.why } : { status: 'escalate', why: `核验没过：${c.why}` };
    }
    default:
      return { status: 'fail', why: `未知段类型 ${stage.type}` };
  }
}

function glob2re(g) {
  return new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '.') + '$');
}

// Independent evidence. Every listed condition must hold.
export async function runCheck(check, state) {
  const P = state.params;
  const why = [];
  let obs = null;
  const need = check.url || check.text || check.jev;
  if (need) {
    const s = session();
    ({ io: { obs } } = await cu.observeAndJudge(s));
  }
  if (check.url) {
    const ok = glob2re(fill(check.url, P)).test(obs.where);
    if (!ok) return { ok: false, why: `网址是 ${obs.where}，不符合 ${check.url}` };
    why.push(`网址 ${obs.where}`);
  }
  const hay = obs ? `${obs.excerpt || ''}\n${(obs.texts || []).join('\n')}\n${obs.candidates.map((c) => c.name).join('\n')}` : '';
  if (check.text) {
    const t = fill(check.text, P);
    if (!hay.includes(t)) return { ok: false, why: `页面里没有「${t}」` };
    why.push(`含「${t}」`);
  }
  if (check.jev) {
    const r = await askJev({ screen: obs.where, page_text: hay.slice(0, 2500) }, { ok: { type: 'noul', instructions: fill(check.jev, P) } });
    const p = r.answers?.ok?.noul ?? 0;
    if (p < (check.minP ?? 0.7)) return { ok: false, why: `Jev 判断「${check.jev}」只有 ${p.toFixed(2)}` };
    why.push(`Jev「${check.jev}」${p.toFixed(2)}`);
  }
  if (check.file) {
    const g = expandHome(fill(check.file, P));
    const dir = path.dirname(g);
    const re = glob2re(path.basename(g));
    const since = state.stages[state.index]?.startedAt || state.started;
    const hit = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => re.test(f)).map((f) => ({ f, st: fs.statSync(path.join(dir, f)) })).filter((x) => x.st.mtimeMs >= since - 1000 && x.st.size > 0).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)[0];
    if (!hit) return { ok: false, why: `${g} 没有本段之后产生的非空文件` };
    why.push(`文件 ${hit.f}（${hit.st.size} 字节）`);
  }
  return { ok: true, why: why.join('；') || '无条件' };
}
