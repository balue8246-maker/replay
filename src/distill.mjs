// `replay distill` — turn a raw events.jsonl recording into:
//   steps.json        machine-replayable semantic steps (locators, params, checkpoints)
//   steps.md          human-readable step list (Chinese)
//   SKILL.draft.md    Open Agent Skills draft (when to use / inputs / steps / verify)
//   refine-prompt.md  instructions for the slow model (Opus) to finish the skill
// Purely deterministic; the slow model refines the draft afterwards.
import { GUARD } from './judge.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from './util.mjs';

const NOISE_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown']);
const TEXTY = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export function locatorsFor(t) {
  if (!t) return [];
  const out = [];
  const s = t.selectors || {};
  if (s.testId) out.push(`loc=css:[${s.testId.attr}="${q(s.testId.value)}"]`);
  if (t.role && t.name) out.push(`loc=role:${t.role}[name="${q(t.name)}"]`);
  if (s.nameAttr) out.push(`loc=css:${t.tag}[name="${q(s.nameAttr)}"]`);
  if (s.id) out.push(`loc=css:#${s.id}`);
  if (t.placeholder && ['input', 'textarea'].includes(t.tag)) out.push(`loc=css:${t.tag}[placeholder="${q(t.placeholder)}"]`);
  if (t.text && !['input', 'select', 'textarea'].includes(t.tag) && t.text.length <= 40) out.push(`${t.tag}:has-text("${q(t.text)}")`);
  if (t.href && !/^javascript:/i.test(t.href)) out.push(`loc=href:${t.href}`);
  if (s.css) out.push(`loc=css:${s.css}`);
  return [...new Set(out)];
}

export function labelOf(t) {
  if (!t) return '(未知元素)';
  const role = t.role || t.tag;
  const name = t.name || t.text || t.placeholder || t.selectors?.nameAttr || '';
  return name ? `${role}「${name}」` : role;
}

function sameEl(a, b) {
  if (!a || !b) return false;
  return (a.selectors?.css && a.selectors.css === b.selectors?.css) || (a.name && a.name === b.name && a.role === b.role);
}

function pathOf(url) {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return url; }
}

export function loadEvents(dir) {
  const p = path.join(dir, 'events.jsonl');
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).sort((a, b) => a.seq - b.seq);
}

export function buildSteps(events) {
  const steps = [];
  const params = [];
  const notes = [];
  let page = { url: null, title: null };
  let lastAction = null; // last user-action step (for attaching consequences)
  let lastActionT = -1e9;

  const push = (s) => { s.id = steps.length + 1; s.page = { ...page }; steps.push(s); return s; };
  const action = (s, t) => { const st = push(s); lastAction = st; lastActionT = t; return st; };

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const next = events.slice(i + 1, i + 6);
    if (e.title && e.top) page.title = e.title;

    switch (e.type) {
      case 'navigate': {
        // Browser-internal pages (new tab, settings) are never workflow steps.
        if (/^(chrome|ego|edge|about|devtools|chrome-extension):/i.test(e.url || '')) break;
        const byUser = ['typed', 'auto_bookmark', 'generated', 'start_page', 'keyword'].includes(e.transition);
        const recentAction = e.t - lastActionT < 4000;
        if (byUser || (!recentAction && !page.url)) {
          page = { url: e.url, title: null };
          push({ kind: 'goto', url: e.url });
        } else if (lastAction && recentAction) {
          (lastAction.expect ||= {}).url = pathOf(e.url);
          page = { url: e.url, title: null };
        } else {
          page = { url: e.url, title: null };
          push({ kind: 'goto', url: e.url, note: `导航（${e.transition}）` });
        }
        break;
      }
      case 'spa_navigate':
        if (lastAction && e.t - lastActionT < 4000) (lastAction.expect ||= {}).url = pathOf(e.url);
        page.url = e.url;
        break;
      case 'page':
        if (!page.url) page.url = e.url;
        break;
      case 'click':
      case 'dblclick': {
        const t = e.target || {};
        // Focus-click on a text field followed by typing → the fill step covers it.
        if (TEXTY.has(t.role) && ['input', 'textarea'].includes(t.tag) && next.some((n) => n.type === 'input' && sameEl(n.target, t))) break;
        // Click on a native select / checkbox (or its label) followed by change → keep the change.
        if (next.some((n) => ['select', 'toggle', 'file_chosen'].includes(n.type) && (sameEl(n.target, t) || t.tag === 'label') && n.t - e.t < 3000)) break;
        // Double click arrives as click, click, dblclick — keep only the dblclick.
        if (e.type === 'click' && next.some((n) => n.type === 'dblclick' && sameEl(n.target, t) && n.t - e.t < 600)) break;
        if (e.type === 'click' && events[i - 1]?.type === 'click' && sameEl(events[i - 1].target, t) && e.t - events[i - 1].t < 600 && next.some((n) => n.type === 'dblclick')) break;
        action({ kind: e.type === 'dblclick' ? 'dblclick' : 'click', target: t, label: labelOf(t), locators: locatorsFor(t), shot: e.shot || null }, e.t);
        break;
      }
      case 'input': {
        const t = e.target || {};
        const prev = steps[steps.length - 1];
        if (prev && prev.kind === 'fill' && sameEl(prev.target, t)) {
          prev.example = e.value; prev.masked = e.masked;
          if (prev.param) params.find((p) => p.key === prev.param).example = e.masked ? null : e.value;
          break;
        }
        const key = `input_${params.filter((p) => p.kind === 'text').length + 1}`;
        params.push({ key, label: t.name || t.placeholder || t.selectors?.nameAttr || key, example: e.masked ? null : e.value, secret: !!e.masked, kind: 'text' });
        action({ kind: 'fill', target: t, label: labelOf(t), locators: locatorsFor(t), param: key, example: e.value, masked: e.masked }, e.t);
        break;
      }
      case 'select': {
        const t = e.target || {};
        const key = `select_${params.filter((p) => p.kind === 'select').length + 1}`;
        params.push({ key, label: t.name || key, example: e.label || e.value, kind: 'select', fixedByDefault: true });
        action({ kind: 'select', target: t, label: labelOf(t), locators: locatorsFor(t), value: e.label || e.value, param: key }, e.t);
        break;
      }
      case 'toggle':
        action({ kind: 'check', target: e.target, label: labelOf(e.target), locators: locatorsFor(e.target), checked: e.checked }, e.t);
        break;
      case 'file_chosen':
        params.push({ key: `file_${params.filter((p) => p.kind === 'file').length + 1}`, label: labelOf(e.target), example: (e.files || []).join(', '), kind: 'file' });
        action({ kind: 'upload', target: e.target, label: labelOf(e.target), locators: locatorsFor(e.target), param: params[params.length - 1].key }, e.t);
        break;
      case 'key': {
        if (NOISE_KEYS.has(e.key) && !e.modifiers?.length) break;
        const chord = [...(e.modifiers || []), e.key].join('+');
        const prev = steps[steps.length - 1];
        if (e.key === 'Enter' && prev?.kind === 'fill' && sameEl(prev.target, e.target)) { prev.submit = true; lastActionT = e.t; break; }
        action({ kind: 'press', key: chord, target: e.target, label: labelOf(e.target), locators: locatorsFor(e.target) }, e.t);
        break;
      }
      case 'download_started': {
        const host = lastAction && e.t - lastActionT < 15000 ? lastAction : null;
        const d = { url: pathOf(e.url || ''), mime: e.mime || null, filename: e.filename ? path.basename(e.filename) : null };
        if (host) host.download = d;
        else push({ kind: 'download', ...d, note: '下载不是由紧邻的点击触发的（可能来自接口或延迟导出）' });
        break;
      }
      case 'download_named':
      case 'download_complete': {
        const st = [...steps].reverse().find((s) => s.download);
        if (st && e.filename) st.download.filename = path.basename(e.filename);
        if (st && e.bytes) st.download.bytes = e.bytes;
        break;
      }
      case 'request': {
        if (e.rtype !== 'xmlhttprequest' || !lastAction || e.t - lastActionT > 6000) break;
        const sig = `${e.method} ${pathOf(e.url)}`;
        const net = (lastAction.network ||= []);
        if (!net.some((n) => n.sig === sig) && net.length < 12) net.push({ sig, status: e.status });
        break;
      }
      case 'tab_created':
        if (lastAction && e.t - lastActionT < 4000) lastAction.opensTab = true;
        break;
      case 'mark':
        push({ kind: 'note', note: e.note });
        notes.push(e.note);
        break;
      case 'copy':
        if (lastAction) (lastAction.after ||= []).push(`复制了文本（${e.length} 字）`);
        break;
      default:
        break;
    }
  }
  return { steps, params, notes };
}

function stepLine(s) {
  const where = s.page?.title ? `〔${s.page.title}〕` : '';
  switch (s.kind) {
    case 'goto': return `打开 ${s.url}${s.note ? `（${s.note}）` : ''}`;
    case 'click': return `${where}点击 ${s.label}${s.target?.context ? `（在 ${s.target.context}）` : ''}`;
    case 'dblclick': return `${where}双击 ${s.label}`;
    case 'fill': return `${where}在 ${s.label} 填入 {{${s.param}}}${s.masked ? '（敏感，已遮蔽）' : `（录制时：${s.example}）`}${s.submit ? ' 并回车' : ''}`;
    case 'select': return `${where}在 ${s.label} 选择「${s.value}」`;
    case 'check': return `${where}${s.checked ? '勾选' : '取消勾选'} ${s.label}`;
    case 'upload': return `${where}在 ${s.label} 上传 {{${s.param}}}`;
    case 'press': return `${where}按 ${s.key}`;
    case 'download': return `下载 ${s.filename || s.url}${s.note ? `（${s.note}）` : ''}`;
    case 'note': return `📝 录制者备注：${s.note}`;
    default: return s.kind;
  }
}

function consequences(s) {
  const out = [];
  if (s.expect?.url) out.push(`→ 页面到 ${s.expect.url}`);
  if (s.opensTab) out.push('→ 打开了新标签页');
  if (s.download) out.push(`→ 下载 ${s.download.filename || s.download.url}${s.download.bytes ? `（${s.download.bytes} 字节）` : ''}`);
  if (s.network?.length) out.push(`→ 接口：${s.network.slice(0, 4).map((n) => n.sig).join('；')}${s.network.length > 4 ? ` 等 ${s.network.length} 个` : ''}`);
  return out;
}

// P5: steps → task chain. One `do` stage per page segment (Jev drives it, the
// recorded steps become hints); outward/irreversible clicks become explicit
// plan-approved `act` stages; recorded consequences become checks.
export function buildPlan(doc) {
  const stages = [];
  const inputs = Object.fromEntries((doc.params || []).filter((p) => p.kind !== 'select').map((p) => [p.key, { hint: p.label, default: p.secret ? undefined : p.example }]));
  if (doc.startUrl) stages.push({ type: 'open', url: doc.startUrl });
  let seg = [];
  const brief = (s) => {
    switch (s.kind) {
      case 'fill': return `在「${s.target?.name || s.label}」填 {{${s.param}}}`;
      case 'check': return `${s.checked ? '勾选' : '取消勾选'}「${s.target?.name || s.label}」`;
      case 'select': return `在「${s.target?.name || s.label}」选「${s.value}」`;
      case 'click': return `点「${s.target?.name || s.target?.text || s.label}」`;
      case 'press': return `按 ${s.key}`;
      default: return stepLine(s);
    }
  };
  const flush = (until) => {
    if (!seg.length) return;
    const values = [...new Set(seg.filter((s) => s.param).map((s) => s.param))];
    stages.push({
      type: 'do',
      goal: `在这个页面上：${seg.map(brief).join('；')}${until === 'confirm' ? '。只做这些，不要提交/发送' : ''}`,
      values,
      valueHints: Object.fromEntries(values.map((k) => [k, inputs[k]?.hint || k])),
      hints: [...(doc.task ? [`整体任务：${doc.task}（本段只是其中一步）`] : []), `上次的做法：${seg.map(brief).join(' → ')}`],
      maxSteps: Math.max(6, seg.length * 2 + 2),
      expect: seg.filter((s) => ['fill', 'check', 'select', 'click'].includes(s.kind)).map((s) => ({ op: s.kind === 'check' ? 'click' : s.kind, name: s.target?.name || s.target?.text || '' })).filter((e) => e.name),
      ...(until ? { until } : {}),
    });
    seg = [];
  };
  for (const s of doc.steps) {
    if (s.kind === 'goto') { if (stages.length && s.url !== doc.startUrl) { flush(); stages.push({ type: 'open', url: s.url }); } continue; }
    if (s.kind === 'note') continue;
    const name = s.target?.name || s.target?.text || '';
    const outward = s.kind === 'click' && GUARD.test(name);
    if (outward) {
      flush('confirm');
      const act = { type: 'act', target: name, op: 'click' };
      if (s.expect?.url) act.check = { url: s.expect.url.replace(/\?.*$/, '') + '*' };
      stages.push(act);
      continue;
    }
    seg.push(s);
    if (s.expect?.url || s.opensTab) flush();
    if (s.download) { flush(); stages.push({ type: 'check', file: `~/Downloads/*${path.extname(s.download.filename || '') || ''}` }); }
  }
  flush();
  stages.forEach((st, i) => { st.id = `s${i + 1}`; });
  return { schema: 'replay-plan/1', name: doc.name, task: doc.task || '', recording: doc.recording, inputs, stages };
}

export function distill(session) {
  const dir = session.dir;
  const events = loadEvents(dir);
  const { steps, params, notes } = buildSteps(events);
  const outDir = path.join(dir, 'distilled');
  fs.mkdirSync(outDir, { recursive: true });

  const doc = {
    schema: 'replay-steps/1',
    recording: session.id,
    name: session.name,
    task: session.task || '',
    createdAt: new Date().toISOString(),
    startUrl: steps.find((s) => s.kind === 'goto')?.url || null,
    params,
    steps,
  };
  writeJson(path.join(outDir, 'steps.json'), doc);
  writeJson(path.join(outDir, 'plan.json'), buildPlan(doc));

  const md = [];
  md.push(`# ${session.name} — 录制步骤`, '');
  if (session.task) md.push(`目标：${session.task}`, '');
  md.push(`录制：${session.id}，共 ${events.length} 个原始事件 → ${steps.length} 步`, '');
  steps.forEach((s) => {
    md.push(`${s.id}. ${stepLine(s)}`);
    for (const c of consequences(s)) md.push(`   ${c}`);
  });
  if (params.length) {
    md.push('', '## 参数候选', '');
    for (const p of params) md.push(`- \`${p.key}\` — ${p.label}（${p.kind}${p.secret ? '，敏感' : ''}）录制值：${p.example ?? '***'}`);
  }
  fs.writeFileSync(path.join(outDir, 'steps.md'), md.join('\n') + '\n');

  const skillName = session.name.replace(/[^\w\u4e00-\u9fa5-]+/g, '-').toLowerCase();
  const draft = [
    '---',
    `name: ${skillName}`,
    `description: TODO（一句话：什么时候用这个技能。把触发词放前面。）录制自 ${session.id}。`,
    '---',
    '',
    `# ${session.name}`,
    '',
    '## 何时使用',
    '',
    session.task ? `- ${session.task}` : '- TODO',
    '',
    '## 输入',
    '',
    ...(params.length ? params.map((p) => `- \`${p.key}\`：${p.label}${p.kind === 'select' ? '（录制时固定为「' + p.example + '」，确认是否每次会变）' : ''}${p.secret ? '（敏感，运行时向用户索取，绝不写入技能）' : `，例：${p.example}`}`) : ['- （无）']),
    '',
    '## 步骤',
    '',
    ...steps.map((s) => `${s.id}. ${stepLine(s)}`),
    '',
    '## 检查点（回放时逐个核对）',
    '',
    ...steps.flatMap((s) => consequences(s).map((c) => `- 第 ${s.id} 步后 ${c.replace(/^→ /, '')}`)),
    '',
    '## 完成的证据',
    '',
    `- TODO（不要信页面上的「成功」提示；用独立证据：下载文件存在且非空、行数、接口返回、消息 ID 等）${steps.some((s) => s.download) ? '\n- 下载文件存在且大小 > 0' : ''}`,
    '',
    '## 回放',
    '',
    '```bash',
    `replay run ${session.id}${params.filter((p) => p.kind !== 'select').map((p) => ` --param ${p.key}=...`).join('')}`,
    '```',
    '',
  ];
  fs.writeFileSync(path.join(outDir, 'SKILL.draft.md'), draft.join('\n'));

  const refine = [
    `# 给慢模型的整理任务：${session.name}`,
    '',
    `录制目录：${dir}`,
    `原始事件：events.jsonl；截图：shots/；确定性草稿：distilled/steps.json、steps.md、SKILL.draft.md`,
    '',
    '请按顺序完成：',
    '',
    '1. 读 steps.md 和必要的截图，理解这段演示的业务意图。删掉误操作和无关步骤（演示者的误点会被录进来）。',
    '2. 判断哪些值每次会变（日期、账号、筛选条件、文件名），把它们定为参数；哪些是固定习惯（例如可见性总选「仅自己」），写成默认值并注明「用户惯例」。',
    '3. **向用户提 1–3 个问题**，问清没说出口的规则。例如：为什么这里选 A 不选 B？什么情况下要跳过某步？结果不对时你会怎么判断？',
    '4. 给每个关键步骤写检查点（页面应到达哪里、出现什么），给整件事写「完成的证据」（独立通道：文件、接口、消息 ID，不看成功横幅）。',
    '5. 涉及登录、扫码、支付、删除、对外发送的步骤，标成「需人确认」。',
    '6. 把结果写成 SKILL.md（基于 SKILL.draft.md），必要时修改 steps.json 里的参数和 locators。',
    '7. 用 `replay run <录制> --param ...` 在新参数下重放一次。全部检查点通过、用户点头后，才 `replay save` 入库。',
    '',
    notes.length ? `录制者备注：\n${notes.map((n) => `- ${n}`).join('\n')}` : '',
  ];
  fs.writeFileSync(path.join(outDir, 'refine-prompt.md'), refine.join('\n') + '\n');

  return { outDir, steps: steps.length, params: params.length, events: events.length };
}
