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
const VALUE_FLAGS = new Set(['--task', '--inputs', '--minutes', '--param', '--as']);
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
    default:
      console.log(`${BAD} 未知命令：${cmd}\n`);
      console.log(HELP);
      process.exitCode = 2;
  }
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
