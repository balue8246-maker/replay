// `replay teach` — learning a task from a human, like a new colleague would:
//   1. start   ask first (brief): what result, which inputs vary, what stays fixed,
//              how to tell it worked, what goes wrong.
//   2. record  the human demonstrates in Ego and talks (voice) or types notes;
//              actions and narration are recorded with timestamps.
//   3. understand  actions + narration → an understanding draft with inferred
//              parameters, discovered APIs, evidence and open questions. The
//              commander (slow model) recaps it to the human and asks.
//   4. answer / compile  answers → procedure.md (how and why) + plan.json.
//   5. trial   supervised first run with new inputs; stops before every
//              plan-approved action. Corrections go back into the lesson.
import fs from 'node:fs';
import path from 'node:path';
import { REPLAY_HOME, SKILLS, readJson, writeJson, color, OK, BAD, WARN, slug, stamp } from './util.mjs';
import { loadEvents, buildSteps, buildPlan } from './distill.mjs';
import { readVoice } from './voice.mjs';

export const LESSONS = path.join(REPLAY_HOME, 'lessons');
const GUARD = /pay|purchase|checkout|delete|remove|send|submit|confirm|publish|upload|logout|sign out|付款|支付|购买|删除|移除|发送|提交|确认|发布|上传|退出|注销/i;

export const BRIEF = [
  ['goal', '这件事最后要得到什么？（拉哪个数、做成什么）'],
  ['output', '产出是什么形式？（文件格式 / 表格 / 截图），放哪里、给谁？'],
  ['system', '在哪个系统做？入口网址？用谁的账号登录？'],
  ['inputs', '每次会变的是什么（日期、对象、筛选条件）？怎么定（例如"上周一到周日"）？'],
  ['fixed', '哪些选项每次都一样、不要动？'],
  ['frequency', '多久做一次？要不要等结果出来、隔一会儿再看？'],
  ['evidence', '你怎么判断做对了？（行数、合计、某个字段、文件名）'],
  ['pitfalls', '常见的坑？出错时你会怎么处理？'],
  ['after', '拿到之后还要做什么？（跑脚本、发给谁）'],
];

const lessonDir = (id) => path.join(LESSONS, id);
export function loadLesson(ref) {
  if (!fs.existsSync(LESSONS)) return null;
  const ids = fs.readdirSync(LESSONS).sort();
  const id = ref ? ids.find((x) => x === ref || x.endsWith(ref) || x.includes(slug(ref))) : ids[ids.length - 1];
  return id ? readJson(path.join(lessonDir(id), 'lesson.json')) : null;
}
export function saveLesson(L) { writeJson(path.join(lessonDir(L.id), 'lesson.json'), L); }

export function startLesson(name, { url = null } = {}) {
  const id = `${stamp()}-${slug(name)}`;
  fs.mkdirSync(lessonDir(id), { recursive: true });
  const L = { schema: 'replay-lesson/1', id, name, url, createdAt: new Date().toISOString(), status: 'briefing', brief: {}, answers: {}, corrections: [] };
  saveLesson(L);
  return L;
}

export function briefText(L) {
  const lines = [`${color.bold('先问清楚再演示')}（课程 ${L.id}）`,
    color.dim('指挥：只问用户请求里还不清楚的，合成一条消息问；用户可以语音或打字回答。答案用 replay teach brief 键=值 记下。'), ''];
  for (const [k, q] of BRIEF) lines.push(`  ${L.brief[k] ? OK : '·'} ${k.padEnd(9)} ${q}${L.brief[k] ? color.dim(`  → ${L.brief[k]}`) : ''}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Understanding: actions + narration → draft + questions.

function narrationOf(L, session, events) {
  const out = [];
  for (const e of events) {
    if (e.type === 'narration' && e.text) out.push({ t: e.t, end: e.t, text: e.text, via: e.via || 'typed' });
    if (e.type === 'mark' && e.note) out.push({ t: e.t, end: e.t, text: e.note, via: 'chat' });
  }
  const t0 = Date.parse(session.startedAt);
  const vf = L.voiceFile && fs.existsSync(L.voiceFile) ? L.voiceFile : null;
  if (vf) for (const v of readVoice(vf)) out.push({ t: v.start - t0, end: v.end - t0, text: v.text, via: 'voice' });
  return out.sort((a, b) => a.t - b.t);
}

// People say what they are about to do, or say it while doing it: attach a
// line to the first action that starts after it began (within 8 s of its end),
// otherwise to the last action before it.
function attach(steps, narr) {
  const acts = steps.filter((s) => s.kind !== 'note');
  const loose = [];
  for (const n of narr) {
    // Fills are stamped when typing ends, so allow a longer lead for them.
    let st = acts.find((s) => s.t >= n.t - 500 && s.t <= n.end + (s.kind === 'fill' ? 15000 : 8000));
    if (!st) st = [...acts].reverse().find((s) => s.t <= n.t);
    if (st) (st.say ||= []).push(n.text); else loose.push(n.text);
  }
  return loose;
}

const VAR_WORDS = /不一样|不同|会变|要变|变化|换成|看情况|按需|要改|上周|上个?月|昨天|今天|本周|本月|最近|近\s*\d|这次是|每次选|输入|参数/;
const FIXED_WORDS = /每次都(一样|是|选)|都一样|一样的|固定|不变|默认|别动|不要动|always|fixed/i;
const DATEY = /^\d{4}[-/.年]\d{1,2}([-/.月]\d{1,2})?|^\d{1,2}[-/]\d{1,2}$/;

function nearText(steps, param) {
  return steps.filter((s) => s.param === param).flatMap((s) => s.say || []).join(' ');
}

// Groups of steps that look like slips or fumbling: went somewhere and came
// straight back; a select changed again; the same button pressed again and
// again (with stray keys in between) before the step that actually moved on.
function findMistakes(steps) {
  const groups = [];
  const nm = (s) => s.target?.name || s.target?.text || '';
  for (let i = 0; i < steps.length - 1; i++) {
    const a = steps[i], b = steps[i + 1];
    if (a.expect?.url && b.kind === 'goto' && b.t - a.t < 6000 && a.page?.url && b.url && b.url.split('#')[0] === a.page.url.split('#')[0]) groups.push([a.id]);
    if (a.kind === 'select' && b.kind === 'select' && nm(a) === nm(b)) groups.push([a.id]);
  }
  for (let i = 0; i < steps.length; i++) {
    const a = steps[i];
    if (a.kind !== 'click') continue;
    const run = [];
    let j = i + 1;
    while (j < steps.length && (steps[j].kind === 'press' || (steps[j].kind === 'click' && nm(steps[j]) === nm(a) && steps[j].target?.tag === a.target?.tag))) { run.push(steps[j]); j++; }
    // a, then presses/repeats; the last repeat of the same control is the real one.
    const lastSame = [a, ...run].filter((s) => s.kind === 'click').pop();
    const extra = [a, ...run].filter((s) => s !== lastSame && s.id < lastSame.id);
    if (extra.length) { groups.push(extra.map((s) => s.id)); i = j - 1; }
  }
  return groups;
}

export function understand(L, session) {
  const events = loadEvents(session.dir);
  const doc0 = buildSteps(events);
  const steps = doc0.steps.filter((s) => s.kind !== 'note');
  const narr = narrationOf(L, session, events);
  const loose = attach(steps, narr);
  const b = L.brief || {};
  const briefAll = Object.values(b).join(' ');

  const params = doc0.params.map((p) => {
    const said = nearText(steps, p.key);
    const label = p.label || p.key;
    let role = 'unknown', why = '';
    if (p.secret) { role = 'secret'; why = '敏感字段，运行时向用户要'; }
    else if (VAR_WORDS.test(said)) { role = 'variable'; why = `演示时说："${said}"`; }
    else if (FIXED_WORDS.test(said)) { role = 'fixed'; why = `演示时说："${said}"`; }
    else if (b.fixed && (b.fixed.includes(label) || (p.example && b.fixed.includes(p.example)))) { role = 'fixed'; why = `你交代过固定：${b.fixed}`; }
    else if (b.inputs && (b.inputs.includes(label) || (p.example && b.inputs.includes(p.example)))) { role = 'variable'; why = `你交代过会变：${b.inputs}`; }
    else if (p.kind === 'select') { role = 'unknown'; }
    return { ...p, label, role, why, datey: DATEY.test(String(p.example || '')) };
  });

  const mistakeGroups = findMistakes(steps);
  const mistakes = mistakeGroups.flat();
  const apis = [];
  for (const s of steps) for (const n of s.network || []) {
    const had = apis.find((a) => a.sig === n.sig);
    if (had) { had.params = [...new Set([...had.params, ...(n.params || [])])]; continue; }
    if (/\/(api|graphql|rest|v\d+|ajax)\b|\.json\b|export|download|query|list|search|report/i.test(n.sig)) apis.push({ sig: n.sig, status: n.status, step: s.id, params: n.params || [], example: n.example });
  }
  const downloads = steps.filter((s) => s.download).map((s) => ({ step: s.id, ...s.download }));
  const outward = steps.filter((s) => s.kind === 'click' && GUARD.test(s.target?.name || s.target?.text || ''));

  // The demonstrator may already have said how to tell it worked.
  const evidenceSaid = narr.map((n) => n.text).find((t) => /就对了|就行了?|对得上|一样就|核对|对一下|检查一下|看一下.*(数|行|合计)/.test(t)) || null;
  const questions = [];
  const q = (id, text, about) => questions.push({ id, text, about });
  for (const p of params) {
    if (p.role === 'unknown') q(`p_${p.key}`, `「${p.label}」这次${p.kind === 'select' ? '选' : '填'}的是「${p.example}」——每次都一样，还是会变？会变的话按什么规则定？`, { param: p.key });
    else if (p.role === 'variable' && p.datey) q(`p_${p.key}`, `「${p.label}」= ${p.example}：下次是按相对日期（比如"上周"）算，还是你每次告诉我？`, { param: p.key });
  }
  for (const g of mistakeGroups) {
    const ss = g.map((id) => steps.find((x) => x.id === id));
    q(`m_${g[0]}`, g.length > 1 ? `第 ${g.join('、')} 步（${[...new Set(ss.map(stepText))].join('、')}）像是来回点了几次，可以去掉吗？` : `第 ${g[0]} 步（${stepText(ss[0])}）之后马上撤回了，是误操作吗？`, { mistakes: g });
  }
  for (const s of outward) q(`g_${s.id}`, `第 ${s.id} 步点了「${s.target?.name || s.target?.text}」，这类会改数据/对外发送的动作，以后直接做，还是每次先问你？`, { guard: s.id });
  if (!b.evidence && !evidenceSaid) q('evidence', downloads.length ? `下载的 ${downloads.map((d) => d.filename || '文件').join('、')}，怎么确认拉对了？（行数、合计、某个字段）` : '结果在哪里看？怎么算做完、做对了？', { evidence: true });
  if (!b.goal && !narr.length) q('goal', '这件事最后是为了得到什么？', { goal: true });
  if (apis.length) q('api', `我看到页面背后调了 ${apis.slice(0, 2).map((a) => `${a.sig}${a.params?.length ? `（参数 ${a.params.slice(0, 5).join('、')}）` : ''}`).join('、')}${apis.length > 2 ? ' 等接口' : ''}。以后可以直接调接口拿数（更快更稳），还是必须走页面？`, { api: true });

  const U = { at: new Date().toISOString(), recording: session.id, startUrl: doc0.steps.find((s) => s.kind === 'goto')?.url || L.url, steps, params, mistakes, mistakeGroups, evidenceSaid, apis, downloads, narration: narr, loose, questions };
  L.understanding = U;
  L.recording = session.id;
  L.status = 'understood';
  saveLesson(L);
  fs.writeFileSync(path.join(lessonDir(L.id), 'understanding.md'), understandingMd(L));
  return U;
}

function stepText(s) {
  const n = s.target?.name || s.target?.text || s.label || '';
  switch (s.kind) {
    case 'goto': return `打开 ${s.url}`;
    case 'fill': return `在「${n}」填「${s.masked ? '***' : s.example}」`;
    case 'select': return `在「${n}」选「${s.value}」`;
    case 'check': return `${s.checked ? '勾选' : '取消勾选'}「${n}」`;
    case 'press': return `按 ${s.key}`;
    case 'download': return `下载 ${s.filename || s.url}`;
    case 'upload': return `在「${n}」上传文件`;
    default: return `${s.kind === 'dblclick' ? '双击' : '点'}「${n}」`;
  }
}

function understandingMd(L) {
  const U = L.understanding, b = L.brief || {};
  const md = [`# 理解稿：${L.name}`, '', `录制 ${U.recording}；${U.steps.length} 个动作，${U.narration.length} 句讲解（${[...new Set(U.narration.map((n) => n.via))].join('/') || '无'}）。`, ''];
  md.push('## 你事先交代的', '');
  const given = BRIEF.filter(([k]) => b[k]);
  md.push(...(given.length ? given.map(([k, qq]) => `- ${qq.split('？')[0]}：${b[k]}`) : ['- （没有交代，演示前应该先问）']), '');
  md.push('## 我看到你做了什么', '');
  let lastPage = null;
  for (const s of U.steps) {
    const page = s.page?.title || s.page?.url;
    if (page && page !== lastPage) { md.push(`〔${page}〕`); lastPage = page; }
    const cons = [s.expect?.url && `→ ${s.expect.url}`, s.opensTab && '→ 新标签页', s.download && `→ 下载 ${s.download.filename || ''}`, s.network?.length && `→ 接口 ${s.network.slice(0, 2).map((n) => n.sig).join('；')}`].filter(Boolean).join(' ');
    md.push(`${s.id}. ${stepText(s)}${U.mistakes.includes(s.id) ? '  ⚠ 可能是误操作' : ''}${cons ? `  ${cons}` : ''}${s.shot ? `  [截图 shots/${s.shot}.jpg]` : ''}`);
    for (const t of s.say || []) md.push(`    🗣 "${t}"`);
  }
  if (U.loose.length) md.push('', `其他讲解：${U.loose.map((t) => `"${t}"`).join(' ')}`);
  md.push('', '## 参数', '');
  const role = { variable: '每次会变', fixed: '固定', secret: '敏感', unknown: '待确认' };
  md.push(...(U.params.length ? U.params.map((p) => `- \`${p.key}\` ${p.label}：录制值「${p.secret ? '***' : p.example}」→ ${role[p.role]}${p.why ? `（${p.why}）` : ''}`) : ['- 没有填写或选择']), '');
  if (U.apis.length) md.push('## 页面背后的接口（可能可以直接调）', '', ...U.apis.map((a) => `- ${a.sig}${a.params?.length ? `?${a.params.join('&')}` : ''} → ${a.status}（第 ${a.step} 步触发）`), '');
  md.push('## 完成的证据', '', `- ${b.evidence || (U.evidenceSaid ? `演示时说：「${U.evidenceSaid}」（复述时确认）` : '（未交代）')}${U.downloads.length ? `；下载 ${U.downloads.map((d) => `${d.filename || d.url}${d.bytes ? ` ${d.bytes} 字节` : ''}`).join('、')}` : ''}`, '');
  md.push('## 要问你的问题', '', ...(U.questions.length ? U.questions.map((x) => `- [${x.id}] ${x.text}`) : ['- 没有']), '');
  md.push('## 给指挥的要求', '',
    '1. 读完上面（必要时看截图），用 3–5 句话向用户复述：要得到什么、每次变什么（以及怎么定）、什么固定、怎么证明做对了、下次你打算怎么做（能走接口就说）。',
    '2. 把上面的问题和你自己发现的疑点合成一条消息问用户。不要原样照搬步骤，要说出意图。',
    '3. 用 `replay teach answer <问题id> "<回答>"` 记下答案（复述被纠正的地方用 `replay teach correct "<纠正>"`），然后 `replay teach compile`。',
    '4. `replay teach trial --param …` 换一组输入监督试跑；用户确认后 `replay teach save`。', '');
  return md.join('\n');
}

// ---------------------------------------------------------------------------
// Compile: understanding + answers → procedure.md + plan.json.

const YES = /^(是|对|嗯|yes|y|误|误操作|删|去掉)/i;
const FIXED_ANS = /固定|不变|一样|都是|别动|fixed|same/i;
const ASK_ANS = /问|确认|先说|ask|confirm/i;

export function compile(L) {
  const U = L.understanding;
  if (!U) throw new Error('还没有理解稿（replay teach understand）');
  const A = L.answers || {};
  const dropped = new Set((U.mistakeGroups || U.mistakes.map((id) => [id])).filter((g) => YES.test(A[`m_${g[0]}`] || '')).flat());
  const steps = U.steps.filter((s) => !dropped.has(s.id)).map((s) => ({ ...s, say: [...(s.say || [])] }));
  // What was said during dropped steps still matters: give it to the next kept step.
  for (const d of U.steps.filter((s) => dropped.has(s.id) && s.say?.length)) {
    const next = steps.find((s) => s.id > d.id) || steps[steps.length - 1];
    if (next) next.say.unshift(...d.say);
  }
  // Commander renames: answers "name_<key>" = "newKey 标签".
  const rename = {};
  for (const [k, v] of Object.entries(A)) if (k.startsWith('name_')) { const [nk, ...lab] = String(v).trim().split(/\s+/); if (/^\w+$/.test(nk)) rename[k.slice(5)] = { key: nk, label: lab.join(' ') }; }
  for (const s of steps) if (s.param && rename[s.param]) s.param = rename[s.param].key;
  const params = U.params.map((p0) => {
    const ans = A[`p_${p0.key}`];
    const p = rename[p0.key] ? { ...p0, key: rename[p0.key].key, label: rename[p0.key].label || p0.label } : p0;
    let role = p.role, rule = p.why;
    if (ans) { role = FIXED_ANS.test(ans) && !/变|不同/.test(ans) ? 'fixed' : 'variable'; rule = ans; }
    if (role === 'unknown') role = p.kind === 'select' ? 'fixed' : 'variable';
    return { ...p, role, rule };
  });
  // Variable selects become inputs; fixed fills keep the recorded value as default.
  for (const p of params) {
    if (p.kind === 'select' && p.role === 'variable') {
      p.kind = 'choice';
      for (const s of steps) if (s.param === p.key) s.value = `{{${p.key}}}`;
    }
  }
  const doc = { name: L.name, task: L.brief?.goal || L.name, recording: U.recording, startUrl: U.startUrl, params: params.map((p) => ({ ...p, label: p.role === 'variable' ? `${p.label}${p.rule ? `（${p.rule}）` : ''}` : p.label })), steps };
  const plan = buildPlan(doc);
  const askEach = U.steps.filter((s) => ASK_ANS.test(A[`g_${s.id}`] || '')).map((s) => s.target?.name || s.target?.text);
  const stages = [];
  for (const st of plan.stages) {
    if (st.type === 'act' && askEach.includes(st.target)) stages.push({ type: 'human', message: `要点「${st.target}」了，用户要求每次先确认` });
    stages.push(st);
  }
  const extra = [...(L.corrections || []).map((c) => `用户纠正：${c}`), ...(L.brief?.pitfalls ? [`用户说过的坑：${L.brief.pitfalls}`] : [])];
  for (const st of stages) if (st.type === 'do') st.hints = [...(st.hints || []), ...extra];
  // Pagination steps exist to get every row onto one page: skip them when that is already true.
  for (const st of stages) if (st.type === 'do' && (st.hints || []).some((h) => /每页|分页|page size|per page|rows per page/i.test(h)) && !(st.check?.file)) st.skipIf = { allOnPage: true };
  const evidence = A.evidence || L.brief?.evidence || U.evidenceSaid;
  const rowsEvidence = /行数|条数|总数|rows?|count/i.test(evidence || '');
  if (evidence && !U.downloads.length) stages.push({ type: 'check', jev: `页面显示的结果满足：${evidence}` });
  // Download evidence: the file must appear, and match the page's row total when that is the rule.
  if (U.downloads.length) {
    const fn = U.downloads[U.downloads.length - 1].filename || '';
    const ext = (fn.match(/\.(\w+)$/) || [])[1];
    const chk = { file: `~/Downloads/*${ext ? `.${ext}` : ''}`, ...(rowsEvidence && /csv|tsv|txt/i.test(ext || '') ? { rows: 'page' } : {}) };
    const own = stages.find((st) => st.type === 'check' && st.file);
    const last = own || [...stages].reverse().find((st) => st.type === 'act' || st.type === 'do');
    if (own) Object.assign(own, chk); else if (last) last.check = { ...(last.check || {}), ...chk };
    // Supervised trial pauses before the stage that produces the result.
    const producer = own ? stages[stages.indexOf(own) - 1] : last;
    if (producer) producer.trialStop = true;
  }
  stages.forEach((st, i) => { st.id = `s${i + 1}`; });
  for (const p of params) if (plan.inputs[p.key] && p.role === 'fixed') plan.inputs[p.key].hint = `${p.label}（固定，用户确认）`;
  const out = { ...plan, lesson: L.id, stages };
  const dir = lessonDir(L.id);
  writeJson(path.join(dir, 'plan.json'), out);
  fs.writeFileSync(path.join(dir, 'procedure.md'), procedureMd(L, steps, params, out, evidence, dropped));
  L.status = 'compiled';
  saveLesson(L);
  return { plan: path.join(dir, 'plan.json'), procedure: path.join(dir, 'procedure.md'), stages: stages.length, dropped: [...dropped] };
}

function procedureMd(L, steps, params, plan, evidence, dropped) {
  const b = L.brief || {}, A = L.answers || {};
  const md = [`# ${L.name}`, '', `> 从一次演示学来（课程 ${L.id}）。这是做法，不是录像：页面变了按意图找，拿不准就停下问。`, ''];
  md.push('## 要得到什么', '', `- ${b.goal || L.name}`, ...(b.output ? [`- 产出：${b.output}`] : []), ...(b.after ? [`- 之后：${b.after}`] : []), ...(b.frequency ? [`- 频率：${b.frequency}`] : []), '');
  md.push('## 输入', '', ...(params.length ? params.map((p) => `- \`${p.key}\` ${p.label}：${p.role === 'fixed' ? `固定「${p.example}」` : p.role === 'secret' ? '敏感，运行时向用户要' : `每次会变${p.rule ? `——${p.rule}` : ''}（演示时：${p.example}）`}`) : ['- 无']), '');
  md.push('## 怎么做', '');
  for (const s of steps) md.push(`${s.id}. ${stepText(s)}${(s.say || []).length ? `——${s.say.join('；')}` : ''}`);
  if (dropped.size) md.push('', `（演示里的第 ${[...dropped].join('、')} 步是误操作，已去掉）`);
  if (A.api) md.push('', `接口：${A.api}`);
  md.push('', '## 怎么证明做对了', '', `- ${evidence || '（未交代：试跑时让用户确认）'}`, '');
  const pit = [b.pitfalls, ...(L.corrections || [])].filter(Boolean);
  if (pit.length) md.push('## 注意', '', ...pit.map((x) => `- ${x}`), '');
  md.push('## 运行', '', '```bash', `replay plan run ${path.join(lessonDir(L.id), 'plan.json').replace(process.env.HOME, '~')}${Object.keys(plan.inputs).map((k) => ` --param ${k}=…`).join('')}`, '```', '');
  return md.join('\n');
}

export function saveSkill(L, as) {
  const name = slug(as || L.name);
  const dst = path.join(SKILLS, name);
  fs.mkdirSync(dst, { recursive: true });
  for (const f of ['plan.json', 'procedure.md', 'understanding.md', 'lesson.json']) {
    const src = path.join(lessonDir(L.id), f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dst, f));
  }
  L.status = 'saved'; L.skill = dst; saveLesson(L);
  return dst;
}

export { lessonDir, OK, BAD, WARN };
