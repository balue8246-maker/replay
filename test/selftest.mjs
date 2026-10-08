// REPLAY self-test.
//   node test/selftest.mjs        offline: daemon + synthetic events + distill
//   node test/selftest.mjs --ego  end-to-end in Ego Lite: real page, real trusted
//                                 input, the real content script (shimmed), distill,
//                                 then replay with a new parameter value.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.REPLAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-test-'));
const { record, stopRecording, daemonStatus } = await import('../src/record.mjs');
const { distill } = await import('../src/distill.mjs');
const { REPO_ROOT, DAEMON_URL, egoRunAsync, egoRun } = await import('../src/util.mjs');

const post = (p, body, headers = {}) => fetch(`${DAEMON_URL}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); } catch (e) { failures += 1; console.log(`✗ ${name}\n  ${e.stack || e}`); }
}

const T = (role, name, extra = {}) => ({ tag: extra.tag || 'button', role, name, selectors: { css: extra.css || `#${name}` , ...(extra.selectors || {}) }, ...extra });

await test('offline: daemon records, refuses web origins, distills', async () => {
  const r = await record({ name: 'offline', task: '导出报表', quiet: true });
  assert.equal((await daemonStatus()).recording, true);
  const forged = await post('/event', { type: 'click' }, { origin: 'https://evil.example' });
  assert.equal(forged.status, 403, 'web origin must be refused');
  const ev = [
    { source: 'nav', type: 'navigate', url: 'https://app.example.com/dash', transition: 'typed' },
    { source: 'page', type: 'click', target: T('tab', '报表'), top: true, title: 'Dash' },
    { source: 'page', type: 'click', target: T('textbox', '开始日期', { tag: 'input', css: 'input.start' }) },
    { source: 'page', type: 'input', target: T('textbox', '开始日期', { tag: 'input', css: 'input.start' }), value: '2026-10' },
    { source: 'page', type: 'input', target: T('textbox', '开始日期', { tag: 'input', css: 'input.start' }), value: '2026-10-01' },
    { source: 'page', type: 'select', target: T('combobox', '粒度', { tag: 'select', css: 'select.g' }), value: 'day', label: '按天' },
    { source: 'page', type: 'input', target: T('textbox', '密码', { tag: 'input', css: 'input.pw' }), value: '***MASKED***', masked: true },
    { source: 'page', type: 'click', target: T('button', '导出', { selectors: { testId: { attr: 'data-testid', value: 'export' } } }) },
    { source: 'net', type: 'request', method: 'POST', url: 'https://app.example.com/api/export?token=[redacted]', status: 200, rtype: 'xmlhttprequest' },
    { source: 'download', type: 'download_started', url: 'https://cdn.example.com/x.csv', filename: '/Users/x/Downloads/report.csv' },
    { source: 'download', type: 'download_complete', filename: '/Users/x/Downloads/report.csv', bytes: 1234 },
  ];
  for (const e of ev) assert.equal((await post('/event', e)).status, 200);
  await stopRecording();
  const s = await r.done;
  assert.equal(s.status, 'stopped');
  const d = distill(s);
  const doc = JSON.parse(fs.readFileSync(path.join(d.outDir, 'steps.json'), 'utf8'));
  const kinds = doc.steps.map((x) => x.kind);
  assert.deepEqual(kinds, ['goto', 'click', 'fill', 'select', 'fill', 'click'], kinds.join(','));
  assert.equal(doc.steps[2].example, '2026-10-01', 'consecutive inputs merge to the final value');
  assert.equal(doc.params.find((p) => p.key === 'input_2').secret, true, 'masked field becomes a secret param');
  const exp = doc.steps[5];
  assert.equal(exp.locators[0], 'loc=css:[data-testid="export"]', 'testId locator first');
  assert.equal(exp.download.filename, 'report.csv');
  assert.equal(exp.download.bytes, 1234);
  assert.ok(exp.network[0].sig.startsWith('POST https://app.example.com/api/export'));
  const skill = fs.readFileSync(path.join(d.outDir, 'SKILL.draft.md'), 'utf8');
  assert.match(skill, /## 输入/);
  assert.doesNotMatch(skill, /MASKED\*\*\*，例/);
});

if (process.argv.includes('--ego')) {
  await test('ego: content script captures trusted input in Ego, distill, replay with new param', async () => {
    const r = await record({ name: 'httpbin-form', task: '提交披萨订单表单', quiet: true });
    const content = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'content.js'), 'utf8');
    // Shim chrome.runtime so the real content script queues events in-page;
    // the Ego-side script drains the queue and forwards it to the daemon.
    const shim = `window.chrome = window.chrome || {}; chrome.runtime = { sendMessage: (m) => window.__rrEmit(JSON.stringify(m)) };`;
    const script = `
const post = (e) => fetch(${JSON.stringify(DAEMON_URL)} + "/event", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(e) });
const task = await taskSpace("REPLAY selftest");
const page = task.page("p1");
await page.goto("https://httpbin.org/forms/post");
await post({ source: "nav", type: "navigate", url: await page.url(), transition: "typed" });
await page.cdp("Runtime.addBinding", { name: "__rrEmit" });
await page.evaluate(${JSON.stringify(shim + '\n' + content)});
await page.events();
const drain = async () => { for (const ev of await page.events()) { if (ev.method !== "Runtime.bindingCalled" || ev.params.name !== "__rrEmit") continue; const { __replay, ...rest } = JSON.parse(ev.params.payload); await post({ source: "page", ...rest }); } };
await page.click("input[name=custname]");
await page.fill("input[name=custname]", "Alice");
await page.click("input[value=medium]");
await page.click("input[value=bacon]");
await page.fill("textarea[name=comments]", "ring twice");
await new Promise((r) => setTimeout(r, 1000));
await drain();
await page.click("text=Submit order");
await page.waitForURL("**/post", { timeout: 15000 });
await drain();
await post({ source: "nav", type: "navigate", url: await page.url(), transition: "form_submit" });
await task.finish({ keep: [] });
console.log("SELFTEST_OK");`;
    const res = await egoRunAsync(script, { timeout: 120000 });
    assert.match(res.out + res.err, /SELFTEST_OK/, res.err.slice(-1500));
    await stopRecording();
    const s = await r.done;
    const d = distill(s);
    const doc = JSON.parse(fs.readFileSync(path.join(d.outDir, 'steps.json'), 'utf8'));
    console.log(fs.readFileSync(path.join(d.outDir, 'steps.md'), 'utf8'));
    const fills = doc.steps.filter((x) => x.kind === 'fill');
    assert.equal(fills.length, 2, 'two text fields');
    assert.equal(fills[0].example, 'Alice');
    assert.ok(doc.steps.some((x) => x.kind === 'check' || (x.kind === 'click' && /Bacon/.test(x.label))), 'checkbox captured');
    const submit = doc.steps.find((x) => /Submit order/.test(x.label || ''));
    assert.ok(submit, 'submit click captured');
    assert.equal(submit.expect?.url, 'https://httpbin.org/post', 'navigation checkpoint attached to submit');

    // Replay with a new value through the real runner inside Ego.
    const outDir = path.join(s.dir, 'runs', 'selftest');
    const runner = pathToFileURL(path.join(REPO_ROOT, 'src', 'runner.mjs')).href;
    const run = egoRun(`const { runSteps } = await import(${JSON.stringify(runner)});
const r = await runSteps({ doc: ${JSON.stringify(doc)}, params: { input_1: "Bob" }, outDir: ${JSON.stringify(outDir)}, jev: true, spaceName: "REPLAY selftest replay" });
console.log("__REPLAY__" + JSON.stringify(r));`, { timeout: 180000 });
    const line = (run.out + '\n' + run.err).split('\n').find((l) => l.startsWith('__REPLAY__'));
    assert.ok(line, run.err.slice(-1500));
    const rep = JSON.parse(line.slice(10));
    for (const st of rep.steps) console.log('   ', JSON.stringify(st));
    assert.equal(rep.ok, true, rep.error);
    const last = rep.steps.filter((x) => x.type === 'step').pop();
    assert.equal(last.check?.url, 'ok', 'replay reached /post');

    // Simulate a site redesign: every recorded locator for the name field and
    // the submit button is now wrong. Jev must find both on the live page.
    const broken = JSON.parse(JSON.stringify(doc));
    for (const st of broken.steps) if ((st.kind === 'fill' && st.param === 'input_1') || /Submit order/.test(st.label || '')) st.locators = ['loc=css:#gone-after-redesign'];
    const run2 = egoRun(`const { runSteps } = await import(${JSON.stringify(runner)});
const r = await runSteps({ doc: ${JSON.stringify(broken)}, params: { input_1: "Carol" }, outDir: ${JSON.stringify(outDir + '-heal')}, jev: true, spaceName: "REPLAY selftest heal" });
console.log("__REPLAY__" + JSON.stringify(r));`, { timeout: 180000 });
    const line2 = (run2.out + '\n' + run2.err).split('\n').find((l) => l.startsWith('__REPLAY__'));
    assert.ok(line2, run2.err.slice(-1500));
    const rep2 = JSON.parse(line2.slice(10));
    for (const st of rep2.steps) console.log('   ', JSON.stringify(st));
    assert.equal(rep2.ok, true, rep2.error + ' ' + JSON.stringify(rep2.attempts));
    assert.equal(rep2.steps.filter((x) => x.via === 'R1-jev').length, 2, 'two steps healed by Jev');
  });
}

fs.rmSync(process.env.REPLAY_HOME, { recursive: true, force: true });
console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
