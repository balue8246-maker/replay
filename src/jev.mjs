// Minimal TypeSafe System One (Jev) client. Text in, probabilities out.
// Used by the CLI (key validation) and by the Ego-side runner (self-healing).
// It is self-contained on purpose: the runner imports it inside Ego's Node runtime.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY_FILES = () => [
  path.join(os.homedir(), '.config', 'ego-jev', 'secrets.env'),
  path.join(os.homedir(), '.zshenv'),
  path.join(os.homedir(), '.zshrc'),
];

export function resolveJevKey() {
  if (process.env.TYPESAFE_API_KEY?.trim()) return { key: process.env.TYPESAFE_API_KEY.trim(), source: 'env' };
  for (const f of KEY_FILES()) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const m = text.match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*["']?([^"'\n#]+)/m);
    if (m?.[1]?.trim()) return { key: m[1].trim(), source: f };
  }
  return null;
}

export async function askJev(state, questions, { key, model = 'jev-latest', timeout = 15000, baseUrl = 'https://api.typesafe.ai' } = {}) {
  const apiKey = key ?? resolveJevKey()?.key;
  if (!apiKey) throw Object.assign(new Error('TYPESAFE_API_KEY not configured (run `replay setup`).'), { code: 'JEV_NO_KEY' });
  const t0 = Date.now();
  const res = await fetch(`${baseUrl}/v1/systemone`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ state, model, questions }),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`Jev HTTP ${res.status}: ${text.slice(0, 200)}`), { status: res.status });
  const body = JSON.parse(text);
  return { answers: body.answers ?? {}, model: body.model, usage: body.usage, ms: Date.now() - t0 };
}

// Cheapest possible round trip to prove the key works.
export async function pingJev(key) {
  const r = await askJev('The sky is blue.', { blue: { type: 'noul', instructions: 'Does the text say the sky is blue?' } }, { key, timeout: 20000 });
  const p = r.answers?.blue?.noul;
  return { ok: true, model: r.model, ms: r.ms, probability: p };
}

export function choiceOf(answer) {
  if (!answer) return { choice: null, p: 0 };
  const probs = answer.probabilities || {};
  const choice = answer.choice ?? Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { choice, p: choice != null ? (probs[choice] ?? answer.confidence ?? 0) : 0, probabilities: probs };
}
