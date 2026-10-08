// Desktop capability layer over cua-driver (macOS accessibility + CGEvent).
// Observes a window as text candidates from its AX tree and executes one action.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { which, REPLAY_HOME, REPO_ROOT } from './util.mjs';

const OCR_BIN = path.join(REPLAY_HOME, 'bin', 'replay-ocr');

// Apple Vision OCR helper, compiled on first use (swiftc ships with Xcode CLT).
export function ocrBin() {
  if (fs.existsSync(OCR_BIN)) return OCR_BIN;
  const swiftc = which('swiftc');
  if (!swiftc) return null;
  fs.mkdirSync(path.dirname(OCR_BIN), { recursive: true });
  const r = spawnSync(swiftc, ['-O', path.join(REPO_ROOT, 'native', 'ocr.swift'), '-o', OCR_BIN], { encoding: 'utf8', timeout: 300_000 });
  return r.status === 0 ? OCR_BIN : null;
}

export function cuaBin() { return which('cua-driver'); }

export function cua(tool, args = {}, { timeout = 60_000 } = {}) {
  const bin = cuaBin();
  if (!bin) throw new Error('cua-driver not installed (replay setup)');
  const r = spawnSync(bin, ['call', tool, JSON.stringify(args)], { encoding: 'utf8', timeout, maxBuffer: 128 * 1024 * 1024 });
  const out = (r.stdout || '').trim();
  if (/^permissions_pending/.test(out)) throw Object.assign(new Error('cua-driver 还没有辅助功能/屏幕录制权限（replay setup 第 7 步）'), { code: 'CUA_PERMS' });
  try { return JSON.parse(out); } catch { throw new Error(`cua-driver ${tool}: ${(out || r.stderr || '').slice(0, 300)}`); }
}

export function listWindows() { return cua('list_windows', {}).windows || []; }

// Pick a window: explicit id, or app name (+ optional title substring).
export function findWindow({ app, title, windowId } = {}) {
  const ws = listWindows();
  if (windowId) {
    const w = ws.find((x) => x.window_id === Number(windowId));
    if (!w) throw new Error(`窗口 ${windowId} 不存在`);
    return w;
  }
  const a = String(app || '').toLowerCase();
  // AX works on background / other-Space windows too, so off-screen windows
  // of the named app qualify; on-screen ones win ties.
  const pool = ws.filter((w) => w.bounds.height > 60 && (a ? w.app_name.toLowerCase().includes(a) : w.is_on_screen) && (!title || (w.title || '').includes(title)));
  if (!pool.length) throw new Error(`找不到窗口：${app || ''} ${title || ''}`.trim());
  pool.sort((x, y) => (!!y.title - !!x.title) || (!!y.is_on_screen - !!x.is_on_screen) || (y.bounds.width * y.bounds.height - x.bounds.width * x.bounds.height));
  return pool[0];
}

const SKIP = /^AX(MenuBar|MenuBarItem|Menu|MenuItem|Window|Application|ScrollBar|Splitter|Unknown|Group|ScrollArea|LayoutArea|WebArea|Toolbar|SplitGroup|TabGroup|Outline|Table|List|Column|Image|Heading)$/;
const FIELD = /^AX(TextField|TextArea|SearchField|ComboBox|SecureTextField)$/;
const ACTIONS = /AXPress|AXPick|AXConfirm|AXOpen|AXIncrement/;

let SCALE;
function screenScale() {
  if (SCALE) return SCALE;
  try { SCALE = cua('get_screen_size', {}).scale_factor || 2; } catch { SCALE = 2; }
  return SCALE;
}

export function observeDesktop(target, { maxElements = 800 } = {}) {
  const t0 = Date.now();
  const get = () => cua('get_window_state', { pid: target.pid, window_id: target.window_id, include_screenshot: false, max_elements: maxElements });
  let s = get();
  // A window on another Space has no resolvable AX window until it is fronted.
  if (!(s.elements || []).length && /ax_window_unresolved/.test(s.degraded_reason || '')) {
    const w = listWindows().find((x) => x.window_id === target.window_id);
    if (w && !w.is_on_screen) { cua('bring_to_front', { pid: target.pid, window_id: target.window_id }); spawnSync('sleep', ['0.8']); s = get(); target.fronted = true; }
  }
  const win = listWindows().find((x) => x.window_id === target.window_id);
  if (win) target.bounds = win.bounds;
  const els = s.elements || [];
  const base = { surface: 'desktop', where: `${s.app_name || target.app_name} #${target.window_id}`, title: s.window_title || target.title || '', snapshotId: s.snapshot_id };
  if (!els.length) {
    const reason = s.degraded_reason || 'empty AX tree';
    // P4: no readable structure → screenshot → Vision OCR boxes → text candidates.
    // OCR reads pixels: only meaningful when the window is actually on screen.
    if (win && !win.is_on_screen) return { ...base, candidates: [], texts: [], noStructure: true, reason: '窗口不在当前桌面（在另一个 Space 或被最小化），读不到也看不到；需要切到该桌面', ms: Date.now() - t0 };
    // System dialogs (open/save panels, alerts) are readable through Peekaboo
    // without any screenshot; prefer that over pixels.
    const dlg = win?.is_on_screen ? (dialogInfo(target.pid, target.window_id) || dialogInfo(target.pid)) : null;
    if (dlg?.buttons?.length) {
      target.vision = false;
      const isPanel = (dlg.textElements || []).some((t) => /^(位置|个人收藏|Favorites|Locations)$/.test(t));
      const candidates = dlg.buttons.filter(Boolean).map((b, i) => ({ id: `b${i}`, role: 'dialog-button', name: b, dialogButton: b }));
      if (isPanel) candidates.push({ id: 'choose', role: 'file-chooser', name: '文件对话框：转到路径并选中它（填入路径值）', chooser: true });
      return { ...base, title: dlg.title || base.title, candidates, texts: (dlg.textElements || []).slice(0, 40), dialog: true, reason: '系统对话框（Peekaboo 读取）', ms: Date.now() - t0 };
    }
    const v = win ? observeVision(target, win) : null;
    if (v) return { ...base, ...v, reason: `AX 读不到（${reason.split(':')[0]}），已用截图识字`, ms: Date.now() - t0 };
    return { ...base, candidates: [], texts: [], noStructure: true, reason, ms: Date.now() - t0 };
  }
  target.vision = false;
  const byIdx = new Map(els.map((e) => [e.element_index, e]));
  const ctxOf = (e) => {
    let p = byIdx.get(e.parent_index);
    for (let i = 0; p && i < 6; i++, p = byIdx.get(p.parent_index)) {
      if (p.label && !/^AX(WebArea|Window)$/.test(p.role)) return p.label;
    }
    return '';
  };
  const cands = [];
  const texts = [];
  const seenText = new Set();
  for (const e of els) {
    const label = (e.label || '').trim();
    if (e.role === 'AXStaticText' || e.role === 'AXHeading') {
      const t = (e.value || label || '').replace(/\s+/g, ' ').trim();
      if (t.length > 1 && !seenText.has(t)) { seenText.add(t); texts.push(t); }
      continue;
    }
    if (SKIP.test(e.role)) continue;
    if (e.enabled === false) continue;
    const field = FIELD.test(e.role);
    if (!field && !ACTIONS.test((e.actions || []).join(' '))) continue;
    if (!label && !field && !e.value) continue;
    let inWeb = false;
    for (let q = byIdx.get(e.parent_index), i = 0; q && i < 40; q = byIdx.get(q.parent_index), i++) if (q.role === 'AXWebArea') { inWeb = true; break; }
    cands.push({ web: inWeb || undefined, id: `e${e.element_index}`, role: e.role, name: label || (field ? '' : String(e.value || '')), value: field ? (e.value || '') : undefined, checked: e.role === 'AXCheckBox' || e.role === 'AXRadioButton' ? !!Number(e.value) : undefined, context: ctxOf(e), token: e.element_token, frame: e.frame });
  }
  return { ...base, candidates: cands, texts, ms: Date.now() - t0 };
}

// Screenshot the display, OCR only the window's rectangle. Candidates carry
// true-screen-pixel centers for desktop-scope clicks.
export function observeVision(target, win) {
  const bin = ocrBin();
  if (!bin) return null;
  const k = screenScale();
  // Pixels are only the window's if it is in front. WindowServer z-order from
  // list_windows proved unreliable (another app's chat was captured under the
  // window's rectangle), so front the exact window and require verification.
  const fr = cua('bring_to_front', { pid: target.pid, window_id: target.window_id });
  if (!/verified/.test(String(fr?.code || fr?.status || JSON.stringify(fr)))) return null;
  spawnSync('sleep', ['0.5']);
  const shot = cua('get_desktop_state', {});
  if (!shot.screenshot_png_b64) return null;
  const file = path.join(os.tmpdir(), `replay-desk-${process.pid}.png`);
  fs.writeFileSync(file, Buffer.from(shot.screenshot_png_b64, 'base64'));
  const b = win.bounds;
  const crop = [b.x, b.y, b.width, b.height].map((v) => Math.round(v * k)).join(',');
  const r = spawnSync(bin, [file, '--crop', crop], { encoding: 'utf8', timeout: 60_000 });
  fs.rmSync(file, { force: true });
  if (r.status !== 0) return null;
  const boxes = JSON.parse(r.stdout).boxes || [];
  target.vision = true;
  const cands = boxes.filter((x) => x.text.trim().length >= 1 && x.conf >= 0.3).map((x, i) => ({
    id: `t${i}`, role: 'ocr-text', name: x.text.trim(), context: '',
    screen: { x: Math.round(x.x + x.w / 2), y: Math.round(x.y + x.h / 2) },
  }));
  return { candidates: cands, texts: cands.map((c) => c.name), vision: true };
}

// action = { op: click|fill|press|hotkey|type, value?, key?, keys? }
export function actDesktop(target, cand, action) {
  if (cand?.chooser && action.op !== 'choose') {
    if (action.value == null) throw new Error('文件对话框需要一个路径值（--value 路径 或 replay act --choose <路径>）');
    action = { ...action, op: 'choose' };
  }
  if (action.op === 'choose') { const r = chooseInDialog(target, String(action.value)); return { ms: r.ms, route: `choose ${r.path} → ${r.button}` }; }
  if (cand?.dialogButton) { const t = Date.now(); dialogClick(target.pid, cand.dialogButton); return { ms: Date.now() - t, route: 'peekaboo dialog click' }; }
  const t0 = Date.now();
  const w = { pid: target.pid, window_id: target.window_id };
  // Out-of-process panels (file choosers) ignore pid-routed keys; after a
  // vision observation, keys go to whatever has focus on the display.
  const kb = target.vision ? { target: { kind: 'desktop', display_id: 'primary' } } : { ...w, delivery_mode: 'foreground' };
  let r;
  if (cand?.screen && (action.op === 'click' || action.op === 'fill')) {
    r = cua('click', { scope: 'desktop', x: cand.screen.x, y: cand.screen.y });
    if (action.op === 'fill') { spawnSync('sleep', ['0.2']); r = cua('type_text', { target: { kind: 'desktop', display_id: 'primary' }, text: String(action.value ?? '') }); }
    spawnSync('sleep', ['0.3']);
    return { ms: Date.now() - t0, route: r?.route, effect: r?.effect };
  }
  switch (action.op) {
    case 'click': {
      // Pixel-at-element-center is ~4x faster than the token path in
      // cua-driver 0.28 (0.7 s vs 2.7 s); fall back to the token if refused.
      const b = target.bounds;
      const f = cand.frame;
      // Web content inside a browser window ignores pid-routed synthetic mouse
      // events (verified on Ego's extensions page); press it through AX instead.
      if (b && f && f.w > 2 && f.h > 2 && !cand.web) {
        const k = screenScale();
        r = cua('click', { ...w, x: Math.round((f.x + f.w / 2 - b.x) * k), y: Math.round((f.y + f.h / 2 - b.y) * k) });
        if (r?.status === 'refused') r = null;
      }
      if (!r) r = cua('click', { ...w, element_token: cand.token });
      break;
    }
    case 'fill':
      cua('click', { ...w, element_token: cand.token });
      r = cua('type_text', { ...w, element_token: cand.token, text: String(action.value ?? '') });
      break;
    case 'type': r = cua('type_text', { ...kb, text: String(action.value ?? '') }); break;
    case 'press': r = cua('press_key', { ...kb, key: action.key }); break;
    case 'hotkey': r = cua('hotkey', { ...kb, keys: action.keys }); break;
    default: throw new Error(`unknown desktop op ${action.op}`);
  }
  if (r?.status === 'refused') throw new Error(`cua-driver 拒绝：${r.refusal?.code} ${r.refusal?.message || ''}`);
  spawnSync('sleep', ['0.3']);
  return { ms: Date.now() - t0, route: r?.route, effect: r?.effect };
}

// ---------------------------------------------------------------------------
// Native dialogs (NSOpenPanel/NSSavePanel, alerts) via Peekaboo (MIT,
// github.com/openclaw/Peekaboo). cua-driver sees an empty AX tree for the
// out-of-process open panel; Peekaboo's DialogService reads and presses it in
// the background, so no screenshot (and no privacy risk) is needed.
export function peekabooBin() { return which('peekaboo'); }

function pk(args, timeout = 30_000) {
  const bin = peekabooBin();
  if (!bin) throw new Error('没装 Peekaboo（npm i -g @steipete/peekaboo），系统对话框只能退回截图识字');
  const r = spawnSync(bin, [...args, '--json'], { encoding: 'utf8', timeout });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* */ }
  if (!j) throw new Error(`peekaboo ${args.slice(0, 2).join(' ')}：${(r.stderr || r.stdout || '').slice(-300)}`);
  return j;
}

export function dialogInfo(pid, windowId) {
  if (!peekabooBin()) return null;
  const j = pk(['dialog', 'list', '--pid', String(pid), ...(windowId ? ['--window-id', String(windowId)] : [])], 10_000);
  return j.success ? j.data : null;
}

export function dialogClick(pid, button) {
  const j = pk(['dialog', 'click', '--pid', String(pid), '--button', button]);
  if (!j.success) throw new Error(`对话框按钮「${button}」没按成：${j.error?.message}`);
  return j.data;
}

// Choose a file or folder in the app's open panel and confirm it.
// Strategy: Go-to-Folder (⌘⇧G, type, Return) through cua-driver global keys
// with the panel verified in front, then Peekaboo presses the default button in
// the background and we require the panel to be gone.
export function chooseInDialog(target, p, { button } = {}) {
  const t0 = Date.now();
  const abs = p.replace(/^~(?=\/|$)/, os.homedir());
  const panel = listWindows().find((w) => w.pid === target.pid && w.is_on_screen && /^(打开|Open|存储|Save|)$/.test(w.title || '') && w.bounds.height > 200);
  if (!panel) throw new Error('没找到这个应用的打开/存储窗口（先点出它）');
  const fr = cua('bring_to_front', { pid: target.pid, window_id: panel.window_id });
  if (!/verified/.test(String(fr?.code))) throw new Error(`没法把对话框调到最前（${fr?.code}），不往全局发按键`);
  const desk = { kind: 'desktop', display_id: 'primary' };
  cua('hotkey', { keys: ['cmd', 'shift', 'g'], target: desk });
  spawnSync('sleep', ['0.6']);
  cua('hotkey', { keys: ['cmd', 'a'], target: desk });
  cua('type_text', { text: abs, target: desk });
  spawnSync('sleep', ['0.3']);
  cua('press_key', { key: 'return', target: desk });
  spawnSync('sleep', ['0.8']);
  const info = dialogInfo(target.pid);
  const btn = button || info?.buttonDetails?.find((b) => b.isDefault)?.title || info?.buttons?.find((b) => /^(选择|打开|存储|Open|Choose|Select|Save|上传|Upload)$/.test(b));
  if (!btn) throw new Error('对话框里找不到确认按钮');
  dialogClick(target.pid, btn);
  for (let i = 0; i < 10; i++) {
    if (!listWindows().some((w) => w.window_id === panel.window_id && w.is_on_screen)) return { ms: Date.now() - t0, path: abs, button: btn };
    spawnSync('sleep', ['0.3']);
  }
  throw new Error('按了确认但对话框还在（路径可能不对）');
}
