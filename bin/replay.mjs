#!/usr/bin/env node
// REPLAY — record once, replay fast. CLI entry point.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, SKILLS, OK, BAD, WARN, color, egoRun, readJson, slug } from '../src/util.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
const flag = (name) => rest.includes(`--${name}`);
const opt = (name, def = null) => { const i = rest.indexOf(`--${name}`); return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : def; };
const opts = (name) => rest.flatMap((a, i) => (a === `--${name}` && rest[i + 1] ? [rest[i + 1]] : []));
const VALUE_FLAGS = new Set(['--task', '--inputs', '--minutes', '--param', '--as', '--goal', '--value', '--hint', '--app', '--title', '--window', '--fill', '--use', '--select', '--press', '--hotkey', '--type', '--goto', '--on', '--max', '--choose', '--url', '--lesson', '--recording', '--voice-file', '--focus']);
const positional = () => rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(rest[i - 1])));
const pkg = readJson(path.join(REPO_ROOT, 'package.json'), {});

const HELP = `${color.bold('REPLAY')} ${pkg.version || ''} — 人做一遍，机器记住；Jev 快判断 + 慢模型兜底

用法
  replay setup                        初始化向导（Ego Lite、Jev key、录制扩展、agent 技能）
  replay doctor [--online] [--json]   检查环境
  replay record [名字] [--task "这次要做什么"] [--inputs "每次会变的输入"] [--minutes 120] [--no-shots]
                                      开始录制：在 Ego 里正常操作，Ctrl-C / replay stop / 点扩展图标结束
  replay stop                         结束当前录制
  replay mark "备注"                  录制中插一条备注（例如「这里要等进度完成」）
  replay list                         列出录制
  replay distill [录制]               把录制整理成步骤、参数、技能草稿（默认最近一次）
  replay show [录制]                  打印整理后的步骤
  replay run [录制|技能] [--param 键=值 ...] [--no-jev] [--keep]
                                      在 Ego 后台回放；找不到元素时用 Jev 自愈
  replay save [录制] --as 技能名      把整理好的录制存成技能（~/.replay/skills/）

指挥循环（给慢模型用：每次调用都返回 Jev 压缩后的约 10 行视图）
  replay open <网址> [--goal "子目标"] [--value 键=值[::提示] ...] [--hint "提示"] [--new]
  replay open --app <应用名> [--title 窗口标题] [--window 窗口id]   桌面窗口（cua-driver；对话框自动跟随）
  replay goal "子目标" [--value …] [--hint …]   换子目标（清空历史）
  replay look [--all] [--on web|desktop]        观察 + Jev 判断；--all 附全部候选
  replay act <id> [--fill 文本 | --use 值键 | --select 选项 | --press 键 | --dbl]
  replay act auto                               执行 Jev 上一次判断（仅当它允许自动）
  replay act --press return | --hotkey cmd+shift+g | --type 文本 | --goto 网址 | --scroll
  replay act --choose <路径>      在系统打开/存储对话框里选中该路径并确认（Peekaboo）
  replay do "子目标" [--value …] [--hint …] [--max 15]   内循环：Jev 有把握且安全就自动做，否则停下交回
  replay end [--keep]                           结束会话，打印 指挥/Jev 次数与耗时

跟学（像新同事一样：先问、看你做并听你讲、复述确认、监督试跑）
  replay teach start "<名字>" [--url 入口]      列出演示前要问用户的问题
  replay teach brief 键=值 ...                  记下用户的回答（goal/output/system/inputs/fixed/frequency/evidence/pitfalls/after）
  replay teach record [--no-voice]              录制演示 + 语音讲解（页面右下角也能打字）；结束后自动生成理解稿
  replay teach stop | note "讲解"               结束录制 / 补一句讲解
  replay teach show [--procedure]               看理解稿 / 做法
  replay teach answer <问题id> "回答"            记下对理解稿问题的回答
  replay teach answer name_<参数> "新键 标签"     给参数起有意义的名字（如 name_input_1 "brand 品牌"）
  replay teach correct "纠正"                   记下纠正并重新整理
  replay teach compile                          生成 procedure.md + plan.json
  replay teach trial [--param 键=值 ...]        监督试跑：每个关键动作前停下等确认
  replay teach save [--as 名字]                 存成技能

自学（只读探索一个网站，写网站地图和操作手册）
  replay explore <网址> [--focus "关心什么"] [--max 25] [--as 名字]
  replay explore manual [名字]
  replay explore note <名字> "经验"              把跑出来的经验写回手册，以后的计划都会带上
  replay explore plan "<需求>" [--value 键=值::提示] [--as 名字]   按手册选页面，生成任务链草稿（需求里的具体值由指挥用 --value 给出）

任务链（指挥写一次 plan.json，之后按段跑；需要判断时停下交回）
  replay plan run <plan.json> [--param 键=值 ...] [--trial]
  replay plan resume [运行id] [--skip]          指挥/人处理完后续跑（--skip = 本段已手动完成）
  replay plan from <录制>                       从录制生成 plan.json 草稿（distill 也会自动生成）
`;

async function main() {
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    case 'version':
    case '--version':
    case '-v':
      console.log(pkg.version);
      return;
    case 'setup': {
      const { setup } = await import('../src/setup.mjs');
      const ok = await setup({ yes: flag('yes') });
      process.exitCode = ok ? 0 : 1;
      return;
    }
    case 'doctor': {
      const { runChecks, printChecks } = await import('../src/doctor.mjs');
      const checks = await runChecks({ online: flag('online') });
      if (flag('json')) console.log(JSON.stringify(checks, null, 2));
      else process.exitCode = printChecks(checks) ? 0 : 1;
      return;
    }
    case 'record': {
      if (rest[0] === 'stop') return main2('stop');
      const { record } = await import('../src/record.mjs');
      const name = positional()[0] || 'recording';
      const r = await record({ name, task: opt('task', ''), inputs: opt('inputs', ''), minutes: Number(opt('minutes', 120)), screenshots: !flag('no-shots') });
      console.log(`${color.red('●')} 正在录制「${name}」→ ${r.dir}`);
      console.log(color.dim('  在 Ego Lite 里正常操作（扩展图标显示 REC）。结束：Ctrl-C、replay stop，或点扩展图标。'));
      const s = await r.done;
      console.log(`${OK} 录制结束（${s.endReason}），${s.events} 个事件。`);
      if (!s.extension) console.log(`${WARN} 整个录制期间没收到扩展信号。检查扩展是否在 Ego 里启用（replay doctor）。`);
      const { distill } = await import('../src/distill.mjs');
      if (s.events > 2) {
        const d = distill(s);
        console.log(`${OK} 已整理：${d.steps} 步、${d.params} 个参数候选 → ${d.outDir}`);
        console.log(color.dim(`  下一步：replay show ${s.id}；让 agent 按 distilled/refine-prompt.md 完善技能；replay run ${s.id}`));
      }
      return;
    }
    case 'stop':
      return main2('stop');
    case 'mark': {
      const { markRecording } = await import('../src/record.mjs');
      const ok = await markRecording(positional().join(' '));
      console.log(ok ? `${OK} 已记下` : `${BAD} 没有进行中的录制`);
      return;
    }
    case 'list': {
      const { listRecordings } = await import('../src/record.mjs');
      for (const s of listRecordings()) console.log(`${s.id}  ${s.status}  ${s.events ?? '-'} 事件  ${s.task || ''}`);
      if (fs.existsSync(SKILLS)) for (const n of fs.readdirSync(SKILLS)) console.log(`${color.cyan('skill')} ${n}`);
      return;
    }
    case 'distill': {
      const s = await need();
      const { distill } = await import('../src/distill.mjs');
      const d = distill(s);
      console.log(`${OK} ${d.events} 事件 → ${d.steps} 步、${d.params} 个参数候选 → ${d.outDir}`);
      return;
    }
    case 'show': {
      const s = await need();
      const p = path.join(s.dir, 'distilled', 'steps.md');
      if (!fs.existsSync(p)) { const { distill } = await import('../src/distill.mjs'); distill(s); }
      console.log(fs.readFileSync(p, 'utf8'));
      return;
    }
    case 'save': {
      const s = await need();
      const name = slug(opt('as') || s.name);
      const src = path.join(s.dir, 'distilled');
      if (!fs.existsSync(path.join(src, 'steps.json'))) { const { distill } = await import('../src/distill.mjs'); distill(s); }
      const dst = path.join(SKILLS, name);
      fs.mkdirSync(dst, { recursive: true });
      for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f));
      if (!fs.existsSync(path.join(dst, 'SKILL.md'))) fs.copyFileSync(path.join(dst, 'SKILL.draft.md'), path.join(dst, 'SKILL.md'));
      console.log(`${OK} 已保存技能 ${dst}`);
      return;
    }
    case 'run':
      return runCmd();
    case 'open':
    case 'goal':
    case 'look':
    case 'act':
    case 'end':
    case 'do':
      return cuCmd(cmd);
    case 'plan':
      return planCmd();
    case 'teach':
      return teachCmd();
    case 'explore':
      return exploreCmd();
    default:
      console.log(`${BAD} 未知命令：${cmd}\n`);
      console.log(HELP);
      process.exitCode = 2;
  }
}

async function planCmd() {
  const sub = rest[0];
  const args = positional().slice(1);
  const params = Object.fromEntries(opts('param').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  const P = await import('../src/plan.mjs');
  let r;
  if (sub === 'run') r = await P.runPlan(args[0], { params, trial: flag('trial') });
  else if (sub === 'resume') r = await P.resumePlan(args[0], { skip: flag('skip') });
  else if (sub === 'from') {
    const { resolveRecording } = await import('../src/record.mjs');
    const { distill } = await import('../src/distill.mjs');
    const s = resolveRecording(args[0]);
    const d = distill(s);
    console.log(`${OK} plan 草稿 → ${d.outDir}/plan.json`);
    return;
  } else { console.log(HELP); return; }
  process.exitCode = r.exit;
}

async function teachCmd() {
  const T = await import('../src/teach.mjs');
  const sub = rest[0];
  const pos = positional().slice(1);
  const need = () => { const L = T.loadLesson(opt('lesson')); if (!L) throw new Error('没有课程（先 replay teach start "<名字>"）'); return L; };
  if (sub === 'start') {
    const L = T.startLesson(pos.join(' ') || 'lesson', { url: opt('url') });
    console.log(T.briefText(L));
    return;
  }
  if (sub === 'brief') {
    const L = need();
    for (const kv of pos) { const i = kv.indexOf('='); if (i > 0) L.brief[kv.slice(0, i)] = kv.slice(i + 1); }
    T.saveLesson(L);
    console.log(T.briefText(L));
    return;
  }
  if (sub === 'record') {
    const L = need();
    const { record } = await import('../src/record.mjs');
    const r = await record({ name: L.name, task: L.brief.goal || L.name, inputs: L.brief.inputs || '', minutes: Number(opt('minutes', 60)) });
    let voice = null;
    if (!flag('no-voice')) {
      try {
        const V = await import('../src/voice.mjs');
        L.voiceFile = path.join(T.lessonDir(L.id), 'voice.jsonl');
        voice = V.startVoice(L.voiceFile);
        const ready = await V.voiceReady(L.voiceFile, 120_000, () => console.log(`${WARN} 系统会弹出「REPLAY 旁白」想使用麦克风——请点「允许」（只需一次）`));
        console.log(ready.error ? `${WARN} 语音没开起来：${ready.error}。可以打字讲解（页面右下角的框，或告诉 agent）。` : `${OK} 麦克风已打开，边做边说即可（本机识别）`);
      } catch (e) { console.log(`${WARN} 语音不可用：${e.message}。改用打字讲解。`); }
    }
    L.status = 'recording'; T.saveLesson(L);
    console.log(`${color.red('●')} 开始录制「${L.name}」。请在 Ego Lite 里操作，边做边说（或在页面右下角打字）。做完点扩展图标，或让 agent 运行 replay teach stop。`);
    const s = await r.done;
    if (voice) await voice.stop();
    console.log(`${OK} 录制结束：${s.events} 个事件`);
    const U = T.understand(T.loadLesson(L.id), s);
    console.log(`${OK} 理解稿：${path.join(T.lessonDir(L.id), 'understanding.md')}（${U.steps.length} 个动作、${U.narration.length} 句讲解、${U.questions.length} 个问题）`);
    return;
  }
  if (sub === 'stop') return main2('stop');
  if (sub === 'note') {
    const { markRecording } = await import('../src/record.mjs');
    console.log((await markRecording(pos.join(' '))) ? `${OK} 已记下` : `${BAD} 没有进行中的录制`);
    return;
  }
  if (sub === 'understand') {
    const L = need();
    const { resolveRecording } = await import('../src/record.mjs');
    const s = resolveRecording(opt('recording') || L.recording);
    if (!s) throw new Error('找不到录制');
    if (opt('voice-file')) L.voiceFile = path.resolve(opt('voice-file'));
    const U = T.understand(L, s);
    console.log(fs.readFileSync(path.join(T.lessonDir(L.id), 'understanding.md'), 'utf8'));
    console.log(color.dim(`${U.questions.length} 个问题`));
    return;
  }
  if (sub === 'show') {
    const L = need();
    const f = path.join(T.lessonDir(L.id), flag('procedure') ? 'procedure.md' : 'understanding.md');
    console.log(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : T.briefText(L));
    return;
  }
  if (sub === 'answer') {
    const L = need();
    L.answers[pos[0]] = pos.slice(1).join(' ');
    T.saveLesson(L);
    const open = (L.understanding?.questions || []).filter((q) => !L.answers[q.id]);
    console.log(`${OK} 已记下 ${pos[0]}${open.length ? color.dim(`；还有 ${open.map((q) => q.id).join('、')}`) : '；问题都答完了，可以 replay teach compile'}`);
    return;
  }
  if (sub === 'correct') {
    const L = need();
    L.corrections.push(pos.join(' '));
    T.saveLesson(L);
    if (L.understanding) { const r = T.compile(L); console.log(`${OK} 已记下纠正并重新整理 → ${r.procedure}`); } else console.log(`${OK} 已记下`);
    return;
  }
  if (sub === 'compile') {
    const L = need();
    const r = T.compile(L);
    console.log(fs.readFileSync(r.procedure, 'utf8'));
    console.log(`${OK} ${r.stages} 段任务链 → ${r.plan}`);
    return;
  }
  if (sub === 'trial') {
    const L = need();
    const P = await import('../src/plan.mjs');
    const params = Object.fromEntries(opts('param').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
    const r = await P.runPlan(path.join(T.lessonDir(L.id), 'plan.json'), { params, trial: !flag('unsupervised') });
    process.exitCode = r.exit;
    return;
  }
  if (sub === 'save') {
    const L = need();
    console.log(`${OK} 已存成技能 ${T.saveSkill(L, opt('as'))}`);
    return;
  }
  if (sub === 'list') {
    if (fs.existsSync(T.LESSONS)) for (const id of fs.readdirSync(T.LESSONS).sort()) { const L = T.loadLesson(id); console.log(`${id}  ${L?.status}`); }
    return;
  }
  console.log(HELP);
}

async function exploreCmd() {
  const E = await import('../src/explore.mjs');
  const pos = positional();
  if (pos[0] === 'manual') { console.log(E.readManual(pos[1])); return; }
  if (pos[0] === 'note') { console.log(`${OK} 已写进 ${pos[1]} 的手册（共 ${E.addNote(pos[1], pos.slice(2).join(' '))} 条经验）`); return; }
  if (pos[0] === 'plan') {
    const { parseValues } = await import('../src/cu.mjs');
    const r = await E.planFromManual(pos.slice(1).join(' '), { site: opt('as'), values: parseValues(opts('value')) });
    console.log(`${OK} 选了 [${r.page.id}] ${r.page.headings[0] || r.page.title}（Jev p=${r.p.toFixed(2)}）→ ${r.file}`);
    console.log(JSON.stringify(r.plan, null, 2));
    return;
  }
  await E.explore(pos[0], { focus: opt('focus'), maxPages: Number(opt('max', 25)), name: opt('as') });
}

async function cuCmd(c) {
  const cu = await import('../src/cu.mjs');
  const values = opts('value').length ? cu.parseValues(opts('value')) : null;
  const hints = opts('hint');
  const pos = positional();
  if (c === 'open') return cu.cmdOpen({ url: pos[0], app: opt('app'), title: opt('title'), windowId: opt('window'), goal: opt('goal'), values, hints, fresh: flag('new') });
  if (c === 'goal') return cu.cmdGoal({ goal: pos.join(' ') || opt('goal'), values, hints });
  if (c === 'look') return cu.cmdLook({ all: flag('all'), on: opt('on') });
  if (c === 'end') return cu.cmdEnd({ keep: flag('keep') });
  if (c === 'do') return cu.cmdDo({ goal: pos.join(' ') || opt('goal'), values, hints, maxSteps: Number(opt('max', 15)), on: opt('on') });
  // act
  const id = pos[0];
  if (id === 'auto') return cu.cmdAct({ auto: true, on: opt('on') });
  const spec = { id, on: opt('on') };
  if (opt('fill') != null) Object.assign(spec, { op: 'fill', value: opt('fill') });
  else if (opt('use')) Object.assign(spec, { op: 'fill', valueKey: opt('use') });
  else if (opt('select') != null) Object.assign(spec, { op: 'select', value: opt('select') });
  else if (opt('choose')) Object.assign(spec, { op: 'choose', value: opt('choose') });
  else if (opt('press')) Object.assign(spec, { op: 'press', key: opt('press') });
  else if (opt('hotkey')) Object.assign(spec, { op: 'hotkey', keys: opt('hotkey').split('+') });
  else if (opt('type') != null) Object.assign(spec, { op: 'type', value: opt('type') });
  else if (opt('goto')) Object.assign(spec, { op: 'goto', value: opt('goto') });
  else if (flag('scroll')) Object.assign(spec, { op: 'scroll' });
  else if (flag('dbl')) Object.assign(spec, { op: 'dblclick' });
  else spec.op = 'click';
  return cu.cmdAct(spec);
}

async function main2(sub) {
  if (sub === 'stop') {
    const { stopRecording } = await import('../src/record.mjs');
    console.log((await stopRecording()) ? `${OK} 已通知录制结束` : `${BAD} 没有进行中的录制`);
  }
}

async function need() {
  const { resolveRecording } = await import('../src/record.mjs');
  const ref = positional()[0];
  const s = resolveRecording(ref);
  if (!s) { console.error(`${BAD} 找不到录制 ${ref || '（还没有录制）'}`); process.exit(2); }
  return s;
}

async function runCmd() {
  const ref = positional()[0];
  let stepsPath = null;
  let outBase = null;
  if (ref && fs.existsSync(path.join(SKILLS, ref, 'steps.json'))) {
    stepsPath = path.join(SKILLS, ref, 'steps.json');
    outBase = path.join(SKILLS, ref, 'runs');
  } else {
    const s = await need();
    stepsPath = path.join(s.dir, 'distilled', 'steps.json');
    if (!fs.existsSync(stepsPath)) { const { distill } = await import('../src/distill.mjs'); distill(s); }
    outBase = path.join(s.dir, 'runs');
  }
  const doc = readJson(stepsPath);
  const params = Object.fromEntries(opts('param').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  const outDir = path.join(outBase, new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
  const runner = pathToFileURL(path.join(REPO_ROOT, 'src', 'runner.mjs')).href;
  const script = `const { runSteps } = await import(${JSON.stringify(runner)});
const r = await runSteps({ doc: ${JSON.stringify(doc)}, params: ${JSON.stringify(params)}, outDir: ${JSON.stringify(outDir)}, jev: ${!flag('no-jev')}, keep: ${flag('keep')} });
console.log("__REPLAY__" + JSON.stringify(r));`;
  console.log(`${color.cyan('▶')} 回放「${doc.name}」${doc.steps.length} 步（Ego 后台执行，不抢你的屏幕）`);
  const r = egoRun(script, { timeout: 30 * 60_000 });
  const line = (r.out + '\n' + r.err).split('\n').find((l) => l.startsWith('__REPLAY__'));
  if (!line) {
    console.error(`${BAD} 回放没有返回结果\n${(r.err || r.out).slice(-2000)}`);
    process.exitCode = 1;
    return;
  }
  const rep = JSON.parse(line.slice('__REPLAY__'.length));
  for (const s of rep.steps) {
    if (s.type === 'step') {
      const bad = Object.entries(s.check || {}).filter(([, v]) => v !== 'ok');
      const via = s.via === 'R1-jev' ? color.yellow(`Jev 自愈 p=${s.p?.toFixed(2)}`) : color.dim(s.via);
      console.log(`  ${bad.length ? WARN : OK} ${String(s.step).padStart(2)}. ${s.label}  ${via}  ${color.dim(s.ms + 'ms')}`);
      for (const [k, v] of bad) console.log(color.yellow(`       ${k}: ${v}`));
    } else if (s.type === 'jev') {
      console.log(color.dim(`       Jev：${s.candidates} 个候选 → ${s.choice}（p=${s.p}，${s.ms}ms）`));
    }
  }
  for (const d of rep.downloads || []) console.log(`  ${OK} 下载 ${d.path}（${d.bytes} 字节）`);
  if (rep.ok) console.log(`${OK} 完成，用时 ${(rep.ms / 1000).toFixed(1)}s${rep.warnings ? `，${rep.warnings} 个检查点未通过` : ''} → ${outDir}/run.json`);
  else {
    console.log(`${BAD} 中断：${rep.error}`);
    for (const a of rep.attempts || []) console.log(color.dim(`     ${a}`));
    console.log(color.dim(`  Ego 空间 ${rep.spaceId} 保留在出错页面，交给慢模型或你接手。报告：${outDir}/run.json`));
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(`${BAD} ${e.message || e}`); process.exit(1); });
