// `replay doctor` — read-only environment checks shared with the setup wizard.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME, EXTENSION_DIR, REPO_ROOT, OK, BAD, WARN, color, loadConfig, sh, which, egoBin } from './util.mjs';
import { resolveJevKey, pingJev } from './jev.mjs';

export const EGO_DMG = {
  arm64: 'https://cdn.ego.app/setup/macos/arm64/egolite-Y7MbxKIuhzFB.dmg',
  x64: 'https://cdn.ego.app/setup/macos/x64/egolite-Y7MbxKIuhzFB.dmg',
};
export const TYPESAFE_CONSOLE = 'https://console.typesafe.ai/';
export const AGENT_SKILLS = path.join(HOME, '.agents', 'skills');

export function findEgoApp() {
  for (const dir of ['/Applications', path.join(HOME, 'Applications')]) {
    try {
      const hit = fs.readdirSync(dir).find((n) => /^ego( |-)?lite.*\.app$/i.test(n));
      if (hit) return path.join(dir, hit);
    } catch {}
  }
  return null;
}

export async function runChecks({ online = false } = {}) {
  const cfg = loadConfig();
  const checks = [];
  const add = (c) => { checks.push(c); return c; };

  add({ id: 'macos', required: true, ok: process.platform === 'darwin', msg: `${process.platform} ${os.arch()}`, fix: 'REPLAY 目前只支持 macOS（Ego Lite 只有 macOS 版）。' });
  const major = Number(process.versions.node.split('.')[0]);
  add({ id: 'node', required: true, ok: major >= 20, msg: `Node ${process.versions.node}`, fix: '需要 Node 20+：brew install node' });

  const app = findEgoApp();
  add({ id: 'ego-app', required: true, ok: !!app, msg: app || '未找到 Ego Lite', fix: `下载安装：${EGO_DMG[os.arch() === 'arm64' ? 'arm64' : 'x64']}` });

  const ego = egoBin();
  let egoVer = null;
  if (ego) egoVer = sh(ego, ['--version']).out.split('\n')[0];
  add({ id: 'ego-cli', required: true, ok: !!ego, msg: ego ? `${ego} ${egoVer || ''}`.trim() : '未找到 ego-browser 命令', fix: '打开一次 Ego Lite，它会把 ego-browser 命令装到 ~/.local/bin；或 npx skills add citrolabs/ego-lite' });

  const egoSkill = fs.existsSync(path.join(AGENT_SKILLS, 'ego-browser', 'SKILL.md'));
  add({ id: 'ego-skill', required: true, ok: egoSkill, msg: egoSkill ? 'ego-browser 技能已装' : '缺 ego-browser 技能', fix: 'npx skills add citrolabs/ego-lite' });

  const jevSkill = fs.existsSync(path.join(AGENT_SKILLS, 'ego-jev', 'SKILL.md'));
  add({ id: 'ego-jev', required: false, ok: jevSkill, msg: jevSkill ? 'ego-jev 技能已装（多步语义操作的 Jev 内循环）' : '缺 ego-jev 技能（可选，推荐）', fix: 'npx skills add ZephyrDeng/ego-jev' });

  const key = resolveJevKey();
  const keyCheck = add({ id: 'jev-key', required: true, ok: !!key, msg: key ? `TYPESAFE_API_KEY 来自 ${key.source.replace(HOME, '~')}` : '没有 Jev（TypeSafe）API key', fix: `到 ${TYPESAFE_CONSOLE} 申请 key，然后 replay setup` });
  if (key && online) {
    try {
      const r = await pingJev(key.key);
      keyCheck.msg += `；在线验证通过（${r.model}，${r.ms}ms）`;
    } catch (e) {
      keyCheck.ok = false;
      keyCheck.msg += `；在线验证失败：${e.message.slice(0, 120)}`;
    }
  }

  const extCopied = fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'));
  const extOk = extCopied && !!cfg.extensionVerifiedAt;
  add({ id: 'extension', required: false, ok: extOk, msg: extOk ? `录制扩展已在 Ego 里验证（${cfg.extensionVerifiedAt.slice(0, 10)}）` : extCopied ? '录制扩展已复制，但还没在 Ego 里加载/验证' : '录制扩展未安装（录制功能需要）', fix: 'replay setup（会引导在 Ego 里加载扩展）' });

  const skillLink = path.join(AGENT_SKILLS, 'replay');
  const skillOk = fs.existsSync(path.join(skillLink, 'SKILL.md'));
  add({ id: 'replay-skill', required: false, ok: skillOk, msg: skillOk ? `REPLAY 技能已装到 ${skillLink.replace(HOME, '~')}` : 'agent 还不知道 REPLAY（未装技能）', fix: `ln -s "${path.join(REPO_ROOT, 'skill')}" ~/.agents/skills/replay` });

  const cua = which('cua-driver');
  add({ id: 'cua-driver', required: false, ok: !!cua, msg: cua ? `${cua}（桌面操作；用前需 cua-driver permissions grant）` : '未装 cua-driver（桌面 App 操作才需要）', fix: '见 https://github.com/trycua/cua' });

  const lark = which('lark-cli');
  add({ id: 'lark-cli', required: false, ok: !!lark, msg: lark ? lark : '未装 lark-cli（把结果发飞书时才需要）', fix: '可选' });

  return checks;
}

export function printChecks(checks) {
  for (const c of checks) {
    const mark = c.ok ? OK : c.required ? BAD : WARN;
    console.log(`${mark} ${c.id.padEnd(13)} ${c.msg}`);
    if (!c.ok) console.log(color.dim(`  ${' '.repeat(13)} → ${c.fix}`));
  }
  const missing = checks.filter((c) => c.required && !c.ok);
  console.log('');
  console.log(missing.length ? color.red(`还差 ${missing.length} 项必需条件，运行 \`replay setup\` 逐项补齐。`) : color.green('必需条件全部就绪。'));
  return missing.length === 0;
}
