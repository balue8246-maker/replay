// REPLAY runner — executes distilled steps inside Ego Lite's embedded Node
// runtime (`ego-browser nodejs`), where taskSpace() is a global.
//
// Replay ladder per step:
//   R0  recorded locators, most stable first (testId → role+name → … → css)
//   R1  if none resolves uniquely: one Jev call picks the matching element from
//       the live page snapshot (~0.4 s); accepted only above a threshold
//   R2  otherwise stop and hand back to the slow model / user with a report
import fs from 'node:fs';
import path from 'node:path';
import { askJev, choiceOf } from './jev.mjs';

const TEXT_ROLES = /textbox|searchbox|combobox|spinbutton|textarea/;

function snapshotCandidates(snap, kind) {
  const out = [];
  for (const line of String(snap).split('\n')) {
    const m = /^\s*([a-z][\w:-]*)(?: "([^"]*)")?[^\[]*\[ref=(\d+)/.exec(line);
    if (!m) continue;
    const [, role, name = '', ref] = m;
    if (kind === 'fill' && !TEXT_ROLES.test(role)) continue;
    out.push({ ref, role, name, line: `${role}${name ? ` "${name}"` : ''}` });
    if (out.length >= 150) break;
  }
  return out;
}

async function healWithJev(page, step, log) {
  const snap = await page.snapshot();
  const cands = snapshotCandidates(snap, step.kind);
  if (!cands.length) return null;
  const criteria = Object.fromEntries(cands.map((c) => [c.ref, c.line]));
  criteria.none = 'none of these is the recorded control';
  const t = step.target || {};
  const state = [
    `Current page: ${await page.title()} — ${await page.url()}`,
    `Recorded step (${step.kind}): ${step.label}`,
    t.context ? `Recorded context: ${t.context}` : '',
    t.text ? `Recorded visible text: ${t.text}` : '',
    step.page?.title ? `Recorded on page titled: ${step.page.title}` : '',
  ].filter(Boolean).join('\n');
  const r = await askJev(state, {
    target: { type: 'choice', instructions: 'Which element on the current page is the same control the user operated in the recorded step?', criteria },
  });
  const { choice, p } = choiceOf(r.answers.target);
  log({ type: 'jev', step: step.id, choice, p, ms: r.ms, candidates: cands.length });
  if (!choice || choice === 'none' || p < 0.6) return null;
  return { selector: `@${choice}`, p };
}

async function resolveAndAct(page, step, act, { jev, log }) {
  const errors = [];
  // Pass 1: every recorded locator with a short wait (most pages are ready).
  // Pass 2: after the page settles, retry with a longer wait.
  for (const [pass, timeout] of [[1, 400], [2, 2500]]) {
    if (pass === 2) await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
    for (const loc of step.locators || []) {
      try {
        await act(loc, timeout);
        return { via: 'R0', selector: loc, pass };
      } catch (e) {
        if (pass === 2) errors.push(`${loc} → ${String(e.message || e).split('\n')[0].slice(0, 120)}`);
      }
    }
  }
  if (jev) {
    try {
      const pick = await healWithJev(page, step, log);
      if (pick) { await act(pick.selector, 3000); return { via: 'R1-jev', selector: pick.selector, p: pick.p }; }
    } catch (e) {
      errors.push(`jev → ${String(e.message || e).slice(0, 160)}`);
    }
  }
  const err = new Error(`第 ${step.id} 步找不到目标：${step.label}`);
  err.attempts = errors;
  throw err;
}

function cleanUrl(url) {
  try {
    const u = new URL(url);
    for (const [k, v] of [...u.searchParams]) if (v === '[redacted]') u.searchParams.delete(k);
    return u.toString();
  } catch { return url; }
}

export async function runSteps({ doc, params = {}, outDir, jev = true, keep = false, spaceName }) {
  fs.mkdirSync(outDir, { recursive: true });
  const report = { recording: doc.recording, name: doc.name, startedAt: new Date().toISOString(), steps: [], downloads: [], ok: false };
  const log = (e) => report.steps.push({ at: Date.now(), ...e });
  const valueOf = (step, fallback) => {
    if (step.param && params[step.param] !== undefined) return params[step.param];
    const p = doc.params.find((x) => x.key === step.param);
    if (p && params[p.label] !== undefined) return params[p.label];
    if (step.masked || p?.secret) throw new Error(`第 ${step.id} 步需要参数 ${step.param}（${p?.label}），录制时是敏感值`);
    return fallback;
  };

  const task = await taskSpace(spaceName || `REPLAY ${doc.name}`);
  const page = task.page('p1');
  report.spaceId = task.spaceId;
  const t0 = Date.now();
  try {
    for (const step of doc.steps) {
      const s0 = Date.now();
      let res = { via: 'direct' };
      const opts = { jev, log };
      let downloadPromise = null;
      if (step.download) downloadPromise = page.waitForEvent('download', { timeout: 60_000 }).catch((e) => e);

      switch (step.kind) {
        case 'goto':
          await page.goto(cleanUrl(step.url), { waitUntil: 'domcontentloaded' });
          break;
        case 'click':
          res = await resolveAndAct(page, step, (sel, to) => page.click(sel, { timeout: to, label: `REPLAY ${step.id}` }), opts);
          break;
        case 'dblclick':
          res = await resolveAndAct(page, step, (sel, to) => page.dblclick(sel, { timeout: to }), opts);
          break;
        case 'fill': {
          const v = String(valueOf(step, step.example ?? ''));
          res = await resolveAndAct(page, step, (sel, to) => page.fill(sel, v, { clearFirst: true, timeout: to }), opts);
          if (step.submit) await page.press(res.selector, 'Enter');
          break;
        }
        case 'select': {
          const v = valueOf(step, step.value);
          res = await resolveAndAct(page, step, (sel, to) => page.selectOption(sel, v, { timeout: to }), opts);
          break;
        }
        case 'check':
          res = await resolveAndAct(page, step, async (sel, to) => {
            const checked = await page.evaluate((s) => { const el = document.querySelector(s); return el ? el.checked : null; }, (step.target?.selectors?.css) || 'body').catch(() => null);
            if (checked !== step.checked) await page.click(sel, { timeout: to });
          }, opts);
          break;
        case 'upload': {
          const file = valueOf(step, null);
          if (!file) throw new Error(`第 ${step.id} 步需要文件参数 ${step.param}`);
          res = await resolveAndAct(page, step, (sel) => page.setInputFiles(sel, file), opts);
          break;
        }
        case 'press':
          if (step.locators?.length) res = await resolveAndAct(page, step, (sel, to) => page.press(sel, step.key, { timeout: to }), opts);
          else await page.keyboard.press(step.key);
          break;
        case 'download':
        case 'note':
          log({ type: 'skip', step: step.id, kind: step.kind, note: step.note });
          continue;
        default:
          log({ type: 'skip', step: step.id, kind: step.kind });
          continue;
      }

      const check = {};
      if (step.expect?.url) {
        try {
          await page.waitForURL((u) => (u.origin + u.pathname).startsWith(step.expect.url), { timeout: 10_000 });
          check.url = 'ok';
        } catch {
          check.url = `未到达 ${step.expect.url}（当前 ${await page.url()}）`;
        }
      }
      if (downloadPromise) {
        const d = await downloadPromise;
        if (d instanceof Error) check.download = `没有等到下载：${d.message.slice(0, 120)}`;
        else {
          const name = d.suggestedFilename?.() || step.download.filename || `download-${step.id}`;
          const target = path.join(outDir, name);
          await d.saveAs(target);
          const size = fs.existsSync(target) ? fs.statSync(target).size : 0;
          check.download = size > 0 ? 'ok' : '文件为空';
          report.downloads.push({ step: step.id, path: target, bytes: size });
        }
      }
      log({ type: 'step', step: step.id, kind: step.kind, label: step.label || step.url, ...res, check, ms: Date.now() - s0 });
      if (Object.values(check).some((v) => v !== 'ok')) {
        report.warnings = (report.warnings || 0) + 1;
      }
    }
    report.ok = true;
  } catch (e) {
    report.error = String(e.message || e);
    report.attempts = e.attempts;
    report.url = await page.url().catch(() => null);
    try { report.snapshot = String(await page.snapshot()).slice(0, 6000); } catch {}
  }
  report.ms = Date.now() - t0;
  report.endedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, 'run.json'), JSON.stringify(report, null, 2));
  // On failure keep the space open so the slow model / user can take over.
  if (report.ok) await task.finish({ keep: keep ? ['p1'] : [] });
  return report;
}
