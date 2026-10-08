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

await test('offline: judge policy (guard, plurality, value, likely-done)', async () => {
  const { decide, formatView } = await import('../src/judge.mjs');
  const c = (id, role, name, p) => ({ id, role, name, p });
  const st = { none: 0.05, done: 0.1, stuck: 0.05 };
  const submit = c('@9', 'button', 'Submit order', 0.97);
  assert.equal(decide({ top: submit, margin: 0.9, st, ranked: [submit] }).auto, false, 'guarded click never auto');
  const link = c('@3', 'link', 'Reports', 0.95);
  assert.equal(decide({ top: link, margin: 0.9, st, ranked: [link] }).auto, true);
  const a = c('@1', 'radio', 'Medium', 0.5), b = c('@2', 'checkbox', 'Bacon', 0.4);
  assert.equal(decide({ top: a, margin: 0.1, st, ranked: [a, b] }).auto, true, 'form-control split is order, not doubt');
  const l1 = c('@4', 'link', 'A', 0.5), l2 = c('@5', 'link', 'B', 0.4);
  assert.equal(decide({ top: l1, margin: 0.1, st, ranked: [l1, l2] }).auto, false, 'link split is real doubt');
  const f = c('@6', 'textbox', 'Name', 0.5);
  const values = { name: { value: 'Dana', hint: 'name' } };
  assert.equal(decide({ top: f, margin: 0.1, st, ranked: [f], vk: ['name', 0.9], values }).auto, true);
  assert.equal(decide({ top: f, margin: 0.9, st, ranked: [f], vk: ['none', 0.9], values }).auto, false, 'no value → commander');
  assert.equal(decide({ top: null, margin: 0, st: { none: 0.95, done: 0.5 }, ranked: [] }).done, true);
  assert.match(formatView({ surface: 'web', where: 'x', ranked: [link], total: 1, state: st, decision: { auto: true, op: 'click', id: '@3', why: 'p' }, jev: { ms: 1 } }), /可自动执行/);
});

await test('offline: inner loop with recorded expectations, escalation on guard', async () => {
  const { innerLoop } = await import('../src/loop.mjs');
  const screen = { checked: false, filled: false };
  const obs = () => ({ surface: 'web', where: 'u', candidates: [{ id: '@1', role: 'textbox', name: 'Name', value: screen.filled ? 'Dana' : '' }, { id: '@2', role: 'checkbox', name: 'Bacon', checked: screen.checked }, { id: '@3', role: 'button', name: 'Submit order' }], texts: [] });
  // Fake Jev: order-split on the first step, then confident.
  const ask = async (state) => {
    const todo = !screen.filled ? { '@1': 0.4, '@2': 0.3, none: 0.3 } : !screen.checked ? { '@2': 0.9, none: 0.1 } : { '@3': 0.95, none: 0.05 };
    return { ms: 1, answers: { next: { probabilities: todo }, value_key: { probabilities: { name: 0.8, none: 0.2 } }, done: { noul: 0.1 }, stuck: { noul: 0.05 } } };
  };
  const act = async (c) => { if (c.id === '@1') screen.filled = true; if (c.id === '@2') screen.checked = true; return { ms: 1 }; };
  const values = { name: { value: 'Dana', hint: 'name' } };
  const r1 = await innerLoop({ observe: obs, act, goal: 'g', values, ask, expect: [{ op: 'fill', name: 'Name' }, { op: 'click', name: 'Bacon' }] });
  assert.equal(r1.status, 'done', r1.why);
  assert.equal(r1.steps.length, 2);
  const r2 = await innerLoop({ observe: obs, act, goal: 'g', values, ask });
  assert.equal(r2.status, 'escalate');
  assert.match(r2.why, /需确认/);
});

await test('offline: recording → plan.json (do segments, approved act, check)', async () => {
  const { buildPlan } = await import('../src/distill.mjs');
  const plan = buildPlan({ name: 't', task: 'order', startUrl: 'https://x/form', params: [{ key: 'input_1', label: 'Name', example: 'A', kind: 'text' }], steps: [
    { kind: 'goto', url: 'https://x/form' },
    { kind: 'fill', param: 'input_1', target: { name: 'Name' }, label: 'Name' },
    { kind: 'check', checked: true, target: { name: 'Bacon' }, label: 'Bacon' },
    { kind: 'click', target: { name: 'Submit order' }, label: 'Submit order', expect: { url: 'https://x/post?id=1' } },
  ] });
  assert.deepEqual(plan.stages.map((s) => s.type), ['open', 'do', 'act']);
  assert.equal(plan.stages[1].until, 'confirm');
  assert.deepEqual(plan.stages[1].expect, [{ op: 'fill', name: 'Name' }, { op: 'click', name: 'Bacon' }]);
  assert.equal(plan.stages[2].check.url, 'https://x/post*');
  assert.equal(plan.inputs.input_1.default, 'A');
});

await test('offline: teach — narration, fumbles, spoken evidence → plan', async () => {
  const T2 = await import('../src/teach.mjs');
  const L = T2.startLesson('拉品牌清单', { url: 'https://inv.example.com/' });
  const r = await record({ name: 'teach', task: '拉品牌清单', quiet: true });
  const ev = [
    { source: 'nav', type: 'navigate', url: 'https://inv.example.com/list', transition: 'typed' },
    { source: 'page', type: 'narration', text: '搜品牌，这次是戴尔，每次品牌不一样', via: 'typed' },
    { source: 'page', type: 'input', target: T('searchbox', 'Search', { tag: 'input', css: 'input.s' }), value: 'Dell' },
    { source: 'page', type: 'click', target: T('button', '20') },
    { source: 'page', type: 'click', target: T('button', '20') },
    { source: 'page', type: 'click', target: T('link', '100', { tag: 'a', css: 'a.p100' }) },
    { source: 'page', type: 'click', target: T('button', 'Export data') },
    { source: 'download', type: 'download_started', url: 'https://inv.example.com/x.csv', filename: '/tmp/d/export.csv' },
    { source: 'download', type: 'download_complete', filename: '/tmp/d/export.csv', bytes: 99 },
    { source: 'page', type: 'narration', text: '文件行数和页面上的总条数一样就对了', via: 'typed' },
  ];
  for (const e of ev) { assert.equal((await post('/event', e)).status, 200); await new Promise((res) => setTimeout(res, 700)); }
  await stopRecording();
  const sess = await r.done;
  const U = T2.understand(L, sess);
  const md = fs.readFileSync(path.join(T2.lessonDir(L.id), 'understanding.md'), 'utf8');
  assert.match(md, /每次会变/, 'spoken "每次不一样" makes the search a variable');
  assert.ok(U.mistakeGroups.some((g) => g.length >= 1), 'repeated clicks flagged as fumbles');
  assert.ok(U.evidenceSaid, 'spoken evidence picked up');
  assert.ok(!U.questions.some((q) => q.id === 'evidence'), 'no evidence question when it was said');
  const L2 = T2.loadLesson(L.id);
  L2.answers = { ...(L2.answers || {}), [`m_${U.mistakeGroups[0][0]}`]: '是', name_input_1: 'brand 品牌' };
  T2.saveLesson(L2);
  const plan = JSON.parse(fs.readFileSync(T2.compile(T2.loadLesson(L.id)).plan, 'utf8'));
  assert.ok(plan.inputs.brand, 'renamed param');
  const st = plan.stages;
  assert.ok(st.some((x) => x.type === 'do' && /\{\{brand\}\}/.test(x.goal)), 'value stays a placeholder');
  assert.ok(st.some((x) => x.check?.rows === 'page' || (x.type === 'check' && x.rows === 'page')), 'row-count evidence becomes a rows:page check');
  assert.ok(st.some((x) => x.trialStop), 'trial stops before the producing stage');
});

await test('offline: rows check counts CSV records, not footers or quoted newlines', async () => {
  const { runCheck } = await import('../src/plan.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-rows-'));
  fs.writeFileSync(path.join(dir, 'a.csv'), '\uFEFF"Tag","Note",Cost\n1,"two\nlines",3\n2,x,4\n,,7\n');
  const st = { params: {}, stages: [{ type: 'check', startedAt: 0 }], index: 0, started: 0 };
  const r = await runCheck({ file: path.join(dir, '*.csv'), rows: 2 }, st);
  assert.equal(r.ok, true, r.why);
  assert.match(r.why, /2 行（另有 1 行合计/);
  const bad = await runCheck({ file: path.join(dir, '*.csv'), rows: 3 }, st);
  assert.equal(bad.ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('offline: explore helpers — templates, export words, manual', async () => {
  const X = await import('../src/explore-ego.mjs');
  assert.equal(X.template('https://s.example.com/hardware/123/edit?b=1&a=2'), X.template('https://s.example.com/hardware/987/edit?a=9&b=3'));
  assert.ok(X.EXPORT.test('Export data') && X.EXPORT.test('导出') && !X.EXPORT.test('Printer Paper'));
  const { manualMd } = await import('../src/explore.mjs');
  const pg = { id: 'p1', url: 'https://s.example.com/list', title: 'List', depth: 0, from: null, via: null, headings: ['Assets'], breadcrumb: [], revealed: [], filters: [{ label: 'Status', kind: 'select', region: 'main', options: ['Ready'] }], rowChecks: 20, tables: [{ caption: '', columns: ['Tag', 'Name'] }], total: 'Showing 1 to 20 of 70 rows', apis: ['/api/v1/items'], exports: [{ text: 'Export data', region: 'main', href: null }], changes: ['Create New'], nav: [], tags: { lists: 0.99, filters: 0.9, exportable: 0.97, report: 0.1, form: 0.0, relevant: 0.9 }, template: 'https://s.example.com/list', same: 0 };
  const md = manualMd({ schema: 'replay-site/1', id: 's', origin: 'https://s.example.com', start: 'https://s.example.com/list', focus: '', pages: [pg], skipped: [], unvisited: [], jevCalls: 1, jevMs: 500, ms: 1000, exploredAt: '2026-10-08T00:00:00Z', notes: [{ at: '2026-10-08T00:00:00Z', text: '只导出当前页' }] });
  assert.match(md, /Export data/);
  assert.match(md, /只导出当前页/);
});

if (process.argv.includes('--ego')) {
  await test('ego: content script captures trusted input in Ego, distill, replay with new param', async () => {
    const r = await record({ name: 'httpbin-form', task: '提交披萨订单表单', quiet: true });
    const content = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'content.js'), 'utf8');
    // Shim chrome.runtime so the real content script queues events in-page;
    // the Ego-side script drains the queue and forwards it to the daemon.
    const shim = `window.chrome = window.chrome || {}; chrome.runtime = { sendMessage: (m) => window.__rrEmit(JSON.stringify(m)) };`;
    // If the real recorder extension is loaded in Ego it records by itself;
    // injecting the shim too would double every event.
    // (REPLAY_HOME is a temp dir here; the extension's install state lives in the real one.)
    const realCfg = path.join(os.homedir(), '.replay', 'config.json');
    const realExt = fs.existsSync(realCfg) && !!JSON.parse(fs.readFileSync(realCfg, 'utf8')).extensionVerifiedAt && !process.env.REPLAY_SELFTEST_SHIM;
    console.log(`  （录制来源：${realExt ? 'Ego 里已加载的真扩展' : '注入的 content script shim'}）`);
    const script = `
const post = (e) => fetch(${JSON.stringify(DAEMON_URL)} + "/event", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(e) });
const task = await taskSpace("REPLAY selftest");
const page = task.page("p1");
await page.goto("https://httpbin.org/forms/post");
const SHIM = ${!realExt};
if (SHIM) {
await post({ source: "nav", type: "navigate", url: await page.url(), transition: "typed" });
await page.cdp("Runtime.addBinding", { name: "__rrEmit" });
await page.evaluate(${JSON.stringify(shim + '\n' + content)});
await page.events();
}
const drain = async () => { if (!SHIM) return; for (const ev of await page.events()) { if (ev.method !== "Runtime.bindingCalled" || ev.params.name !== "__rrEmit") continue; const { __replay, ...rest } = JSON.parse(ev.params.payload); await post({ source: "page", ...rest }); } };
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
if (SHIM) await post({ source: "nav", type: "navigate", url: await page.url(), transition: "form_submit" });
else await new Promise((r) => setTimeout(r, 1500));
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
