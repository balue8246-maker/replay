// Narration capture: the human talks while demonstrating; on-device speech
// recognition turns it into timestamped lines that are merged with the
// recorded actions. Helper: native/voice.swift, built into a tiny app bundle so
// macOS shows its own microphone / speech permission popups.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { which, REPLAY_HOME, REPO_ROOT } from './util.mjs';

const APP = path.join(REPLAY_HOME, 'bin', 'ReplayVoice.app');
const EXE = path.join(APP, 'Contents', 'MacOS', 'replay-voice');

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.replay.voice</string>
<key>CFBundleName</key><string>REPLAY Voice</string>
<key>CFBundleDisplayName</key><string>REPLAY 旁白</string>
<key>CFBundleExecutable</key><string>replay-voice</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSMicrophoneUsageDescription</key><string>REPLAY 在你演示时听你的讲解，转成文字和操作对齐（只在录制时，识别在本机完成）。</string>
<key>NSSpeechRecognitionUsageDescription</key><string>REPLAY 把你演示时的讲解转成文字（本机识别）。</string>
</dict></plist>
`;

export function voiceApp({ rebuild = false } = {}) {
  const src = path.join(REPO_ROOT, 'native', 'voice.swift');
  if (!rebuild && fs.existsSync(EXE) && fs.statSync(EXE).mtimeMs > fs.statSync(src).mtimeMs) return APP;
  const swiftc = which('swiftc');
  if (!swiftc) return null;
  fs.mkdirSync(path.dirname(EXE), { recursive: true });
  fs.writeFileSync(path.join(APP, 'Contents', 'Info.plist'), PLIST);
  const r = spawnSync(swiftc, ['-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`, src, '-o', EXE], { encoding: 'utf8', timeout: 300_000 });
  if (r.status !== 0) throw new Error(`编译语音助手失败：${(r.stderr || '').slice(-400)}`);
  spawnSync('codesign', ['--force', '--sign', '-', APP], { encoding: 'utf8' });
  return APP;
}

// Start live narration capture. Returns a handle with stop().
export function startVoice(outFile, { lang = 'zh-CN' } = {}) {
  const app = voiceApp();
  if (!app) throw new Error('没有 swiftc，语音旁白不可用（可以改用打字旁白）');
  const stopFile = `${outFile}.stop`;
  fs.rmSync(stopFile, { force: true });
  const r = spawnSync('open', ['-n', '-a', app, '--args', '--out', outFile, '--lang', lang, '--stop', stopFile], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`启动语音助手失败：${r.stderr}`);
  return {
    outFile,
    stop: async () => {
      fs.writeFileSync(stopFile, '');
      for (let i = 0; i < 30; i++) {
        const alive = spawnSync('pgrep', ['-f', `${EXE} --out ${outFile}`]).status === 0;
        if (!alive) break;
        await new Promise((res) => setTimeout(res, 200));
      }
      fs.rmSync(stopFile, { force: true });
    },
  };
}

// Wait until the helper reports ready (mic open + permission granted) or an error.
export async function voiceReady(outFile, ms = 120_000, onWaiting = null) {
  let told = false;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const lines = readVoice(outFile, { raw: true });
    const hit = lines.find((l) => l.ready || l.error);
    if (!told && onWaiting && lines.some((l) => l.waiting)) { told = true; onWaiting(lines.find((l) => l.waiting).waiting); }
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 300));
  }
  return { error: '等待麦克风/语音识别授权超时（系统弹窗可能还没点）' };
}

// Transcribe an audio file (self-tests, or a voice memo recorded elsewhere).
export async function transcribeFile(audio, outFile, { lang = 'zh-CN', t0 = Date.now() } = {}) {
  const app = voiceApp();
  fs.rmSync(outFile, { force: true });
  const r = spawnSync('open', ['-n', '-W', '-g', '-a', app, '--args', '--file', path.resolve(audio), '--out', outFile, '--lang', lang, '--t0', String(t0)], { encoding: 'utf8', timeout: 300_000 });
  if (r.status !== 0) throw new Error(`语音转写失败：${r.stderr}`);
  return readVoice(outFile);
}

export function readVoice(file, { raw = false } = {}) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return raw ? lines : lines.filter((l) => l.text);
}
