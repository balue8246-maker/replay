// `replay setup` — interactive first-run wizard.
// Walks through: Ego Lite app → ego-browser CLI/skill → ego-jev skill →
// Jev API key → recorder extension inside Ego → REPLAY agent skill → optional
// desktop driver. Every step re-checks after acting; nothing is silently skipped.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { HOME, REPLAY_HOME, EXTENSION_DIR, REPO_ROOT, SECRETS_PATH, OK, BAD, WARN, color, confirm, prompt, saveConfig, loadConfig, sh, egoRunAsync, readJson } from './util.mjs';
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
// Already-installed unpacked extension: press its own 重新加载 button on the
// extensions page inside a private TaskSpace (no window needs to be on screen).
// Chromium's id for an unpacked extension: sha256(absolute path) → a..p.
export function unpackedId(dir) {
  const h = createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 32);
  return [...h].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export async function reloadExtensionViaPage(id) {
  if (!id) return { err: '不知道扩展 ID' };
  const r = await egoRunAsync(`const task = await taskSpace("REPLAY setup reload");
const page = task.page("p1");
await page.goto("chrome://extensions/");
await new Promise((r) => setTimeout(r, 1200));
const out = await page.evaluate(\`(() => {
  const m = document.querySelector('extensions-manager');
  const list = m && m.shadowRoot.querySelector('extensions-item-list');
  const item = list && list.shadowRoot.querySelector('extensions-item#${id}');
  const btn = item && item.shadowRoot.querySelector('#dev-reload-button');
  if (!btn) return 'no-button';
  btn.click();
  return 'clicked';
})()\`);
await new Promise((r) => setTimeout(r, 1500));
await task.finish({ keep: [] });
console.log(out);`, { timeout: 60000 });
  return /clicked/.test(`${r.out}\n${r.err}`) ? { ok: true } : { err: `扩展页上没找到重新加载按钮（${(r.out || r.err).slice(-80)}）` };
}

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

// Click 「加载未打包的扩展程序」 and pick the directory in the native panel,
// all through the commander-free inner loop (Jev picks, Peekaboo drives the panel).
async function loadExtensionViaUI(extDir) {
  const D = await import('./desktop.mjs');
  const w = D.listWindows().find((x) => /^ego/i.test(x.app_name) && /^(扩展程序|Extensions)$/.test(x.title || '') && x.is_on_screen);
  if (!w) throw new Error('没找到打开着的 Ego「扩展程序」页面');
  const { newSession, runDo } = await import('./cu.mjs');
  const s = newSession();
  s.surface = 'desktop';
  s.target = { pid: w.pid, window_id: w.window_id, app_name: w.app_name, title: w.title, app: w.app_name };
  let r;
  try {
    r = await runDo(s, { goal: '用「加载未打包的扩展程序」选中扩展目录 {{dir}} 并确认', values: { dir: { value: extDir, hint: 'extension directory path' } }, maxSteps: 4 });
  } finally {
    // This helper session is internal to setup: do not leave it as "the current session".
    const f = path.join(REPLAY_HOME, 'session.json');
    if (readJson(f, null)?.id === s.id) fs.rmSync(f, { force: true });
  }
  const panelGone = !D.listWindows().some((x) => x.pid === w.pid && /^(打开|Open)$/.test(x.title || '') && x.is_on_screen);
  if (!panelGone) throw new Error(`对话框没关（${r.why}）`);
  return r;
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
  if ((await get('ego-cli')).ok) {
    let ext = loadConfig().extensionVerifiedAt ? await verifyExtension() : null;
    // A newer extension on disk than the one running in Ego: reload it.
    const want = readJson(path.join(extDir, 'manifest.json'))?.version;
    if (ext && want && ext !== want) {
      console.log(`${WARN} Ego 里运行的是 v${ext}，磁盘上是 v${want}，重新加载`);
      const rr = await reloadExtensionViaPage(unpackedId(extDir));
      ext = rr.ok ? await verifyExtension() : null;
      if (ext !== want) { if (rr.err) console.log(`${WARN} ${rr.err}`); ext = null; }
    }
    // Agent path: load it through Ego's own UI with REPLAY's desktop layer
    // (needs the extensions page open in an Ego window on the current desktop).
    if (!ext) {
      const r = await loadExtensionViaUI(extDir).catch((e) => ({ err: e.message }));
      if (r?.err) console.log(`${BAD} 自动加载没成：${r.err}`);
      else ext = await verifyExtension();
    }
    if (!ext && interactive) {
      sh('/bin/sh', ['-c', `printf %s "${extDir}" | pbcopy`]);
      console.log([
        '在 Ego Lite 里加载一次（只需一次）：',
        `  1. 地址栏输入 ${color.bold('ego://extensions')}`,
        '  2. 打开右上角「开发者模式」',
        '  3. 点「加载未打包的扩展程序」，按 ⌘⇧G 粘贴路径（已复制到剪贴板）：',
        `     ${extDir}`,
      ].join('\n'));
      await pause('加载好以后');
      ext = await verifyExtension();
    }
    if (ext) { saveConfig({ extensionVerifiedAt: new Date().toISOString(), extensionVersion: ext }); console.log(`${OK} 扩展已连通（v${ext}）`); }
    else console.log(`${BAD} 没收到扩展的信号。agent：在 Ego 里打开 ego://extensions（开发者模式打开）后重跑 replay setup --yes。`);
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
