// `replay setup` — interactive first-run wizard.
// Walks through: Ego Lite app → ego-browser CLI/skill → ego-jev skill →
// Jev API key → recorder extension inside Ego → REPLAY agent skill → optional
// desktop driver. Every step re-checks after acting; nothing is silently skipped.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOME, EXTENSION_DIR, REPO_ROOT, SECRETS_PATH, OK, BAD, WARN, color, confirm, prompt, saveConfig, sh, egoRunAsync } from './util.mjs';
import { runChecks, printChecks, EGO_DMG, TYPESAFE_CONSOLE, AGENT_SKILLS } from './doctor.mjs';
import { pingJev, resolveJevKey } from './jev.mjs';
import { probeExtension } from './record.mjs';

const h = (n, title) => console.log(`\n${color.bold(`[${n}] ${title}`)}`);
const get = async (id) => (await runChecks()).find((c) => c.id === id);
const pause = (msg) => prompt(color.cyan(`${msg}（完成后按回车）`));

function run(cmd, args) {
  console.log(color.dim(`$ ${cmd} ${args.join(' ')}`));
  return spawnSync(cmd, args, { stdio: 'inherit' }).status === 0;
}

function saveKey(key) {
  fs.mkdirSync(path.dirname(SECRETS_PATH), { recursive: true, mode: 0o700 });
  let text = '';
  try { text = fs.readFileSync(SECRETS_PATH, 'utf8'); } catch {}
  const line = `TYPESAFE_API_KEY=${key}`;
  text = /^\s*(export\s+)?TYPESAFE_API_KEY\s*=.*$/m.test(text)
    ? text.replace(/^\s*(export\s+)?TYPESAFE_API_KEY\s*=.*$/m, line)
    : (text && !text.endsWith('\n') ? text + '\n' : text) + line + '\n';
  fs.writeFileSync(SECRETS_PATH, text, { mode: 0o600 });
  fs.chmodSync(SECRETS_PATH, 0o600);
}

export function installExtensionFiles() {
  fs.mkdirSync(EXTENSION_DIR, { recursive: true });
  for (const f of fs.readdirSync(path.join(REPO_ROOT, 'extension'))) {
    fs.copyFileSync(path.join(REPO_ROOT, 'extension', f), path.join(EXTENSION_DIR, f));
  }
  return EXTENSION_DIR;
}

// Open a page in a throwaway Ego space while a probe server listens; the
// extension's content script fires on load and calls the daemon port.
export async function verifyExtension() {
  let ready;
  const listening = new Promise((r) => { ready = r; });
  const probe = probeExtension({ timeoutMs: 25000, onListening: ready });
  await listening;
  const nav = egoRunAsync(`const task = await taskSpace("REPLAY setup check");
const page = task.page("p1");
await page.goto("https://example.com/");
await new Promise((r) => setTimeout(r, 4000));
await task.finish({ keep: [] });`, { timeout: 60000 });
  const ext = await probe;
  await nav;
  return ext;
}

export async function setup({ yes = false } = {}) {
  console.log(color.bold('REPLAY 初始化向导'));
  console.log(color.dim('逐项检查并补齐：Ego Lite、Jev key、录制扩展、agent 技能。随时 Ctrl-C 退出，下次重跑会跳过已完成的项。'));
  const interactive = process.stdin.isTTY && !yes;

  if (process.platform !== 'darwin') {
    console.log(`${BAD} REPLAY 目前只支持 macOS。`);
    return false;
  }

  // 1. Ego Lite app
  h(1, 'Ego Lite 浏览器（agent 用来操作网页，能复用你的登录态）');
  let c = await get('ego-app');
  if (c.ok) console.log(`${OK} ${c.msg}`);
  else {
    const url = EGO_DMG[os.arch() === 'arm64' ? 'arm64' : 'x64'];
    console.log(`${BAD} 没找到 Ego Lite。下载：${url}`);
    if (interactive && await confirm('现在用默认浏览器下载安装包？')) {
      sh('open', [url]);
      await pause('打开 dmg，把 ego lite 拖进「应用程序」并启动一次。首次启动建议选择迁移 Chrome 数据，这样 agent 能用你的登录态');
    }
    c = await get('ego-app');
    console.log(c.ok ? `${OK} ${c.msg}` : `${BAD} 仍未找到 Ego Lite，稍后可重跑 replay setup。`);
  }

  // 2. ego-browser CLI + skill
  h(2, 'ego-browser 命令和技能');
  c = await get('ego-cli');
  if (!c.ok && interactive) {
    console.log(`${WARN} ${c.msg}。Ego Lite 首次启动会自动安装它。`);
    await pause('请启动一次 Ego Lite');
    c = await get('ego-cli');
  }
  console.log(c.ok ? `${OK} ${c.msg}` : `${BAD} ${c.msg} → ${c.fix}`);
  c = await get('ego-skill');
  if (!c.ok && interactive && await confirm('安装 ego-browser 技能（npx skills add citrolabs/ego-lite）？')) run('npx', ['-y', 'skills', 'add', 'citrolabs/ego-lite']);
  c = await get('ego-skill');
  console.log(c.ok ? `${OK} ${c.msg}` : `${BAD} ${c.msg} → ${c.fix}`);

  // 3. ego-jev skill (optional)
  h(3, 'ego-jev 技能（Jev 快判断内循环，可选但推荐）');
  c = await get('ego-jev');
  if (!c.ok && interactive && await confirm('安装 ego-jev 技能（npx skills add ZephyrDeng/ego-jev）？')) run('npx', ['-y', 'skills', 'add', 'ZephyrDeng/ego-jev']);
  c = await get('ego-jev');
  console.log(c.ok ? `${OK} ${c.msg}` : `${WARN} ${c.msg}`);

  // 4. Jev key
  h(4, 'Jev（TypeSafe System One）API key —— 每步约 0.4 秒的快判断');
  let key = resolveJevKey();
  if (key) console.log(`${OK} 已找到 key（来自 ${key.source.replace(HOME, '~')}）`);
  else if (interactive) {
    console.log(`还没有 key。到 ${TYPESAFE_CONSOLE} 注册并创建 API key。`);
    if (await confirm('现在打开 TypeSafe 控制台？')) sh('open', [TYPESAFE_CONSOLE]);
    const k = await prompt('粘贴 TYPESAFE_API_KEY（输入不回显，留空跳过）：', { hidden: true });
    if (k) { saveKey(k); key = { key: k, source: SECRETS_PATH }; console.log(`${OK} 已保存到 ${SECRETS_PATH.replace(HOME, '~')}（权限 600，ego-jev 也读这个文件）`); }
  }
  if (key) {
    try {
      const r = await pingJev(key.key);
      console.log(`${OK} 在线验证通过：${r.model}，${r.ms}ms`);
    } catch (e) {
      console.log(`${BAD} 在线验证失败：${e.message.slice(0, 160)}`);
    }
  } else console.log(`${BAD} 没有 Jev key：录制可用，但回放时的「自愈」和快判断不可用。`);

  // 5. Recorder extension inside Ego
  h(5, '录制扩展（在 Ego 里记录你的操作，只在 replay record 运行时才记录）');
  const extDir = installExtensionFiles();
  console.log(`${OK} 扩展文件已复制到 ${extDir.replace(HOME, '~')}`);
  if (interactive && (await get('ego-cli')).ok) {
    let ext = null;
    if (await confirm('先自动检测扩展是否已加载？（会在 Ego 后台开一个临时页面）')) ext = await verifyExtension();
    if (!ext) {
      sh('/bin/sh', ['-c', `printf %s "${extDir}" | pbcopy`]);
      console.log([
        '在 Ego Lite 里手动加载一次（只需一次）：',
        `  1. 地址栏输入 ${color.bold('chrome://extensions')}`,
        '  2. 打开右上角「开发者模式」',
        '  3. 点「加载已解压的扩展程序」，按 ⌘⇧G 粘贴路径（已复制到剪贴板）：',
        `     ${extDir}`,
      ].join('\n'));
      await pause('加载好以后');
      ext = await verifyExtension();
    }
    if (ext) { saveConfig({ extensionVerifiedAt: new Date().toISOString(), extensionVersion: ext }); console.log(`${OK} 扩展已连通（v${ext}）`); }
    else console.log(`${BAD} 没收到扩展的信号。确认扩展已启用后，重跑 replay setup。`);
  }

  // 6. REPLAY skill for agents
  h(6, 'REPLAY 技能（让 Claude/Codex/DSH 等 agent 知道怎么用 REPLAY）');
  c = await get('replay-skill');
  if (!c.ok && (!interactive || await confirm(`把技能链接到 ${AGENT_SKILLS.replace(HOME, '~')}/replay？`))) {
    fs.mkdirSync(AGENT_SKILLS, { recursive: true });
    const link = path.join(AGENT_SKILLS, 'replay');
    try { fs.rmSync(link, { force: true }); } catch {}
    fs.symlinkSync(path.join(REPO_ROOT, 'skill'), link);
  }
  c = await get('replay-skill');
  console.log(c.ok ? `${OK} ${c.msg}` : `${WARN} ${c.msg}`);

  // 7. Optional desktop driver
  h(7, '桌面操作（可选）：cua-driver');
  c = await get('cua-driver');
  if (c.ok) {
    console.log(`${OK} ${c.msg}`);
    if (interactive && await confirm('现在授予 cua-driver 辅助功能与屏幕录制权限？（会弹系统设置）')) run(c.msg.split('（')[0], ['permissions', 'grant']);
  } else console.log(`${WARN} ${c.msg}（之后要操作本地 App 时再装）`);

  saveConfig({ setupAt: new Date().toISOString(), repo: REPO_ROOT });
  console.log(`\n${color.bold('结果')}`);
  return printChecks(await runChecks());
}
