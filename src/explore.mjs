// `replay explore` — learn a GUI website without a demonstration: read-only
// exploration in Ego → sitemap.json + manual.md (pages, what data each shows,
// filters, tables, export entries, endpoints, data-changing entries left alone).
// `replay explore plan "<request>"` turns the manual into a draft task chain.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPLAY_HOME, REPO_ROOT, egoRun, readJson, writeJson, color, OK, BAD, WARN, slug } from './util.mjs';
import { askJev, choiceOf } from './jev.mjs';

export const SITES = path.join(REPLAY_HOME, 'sites');
const siteDir = (name) => path.join(SITES, name);

export async function explore(url, { focus = '', maxPages = 25, name = null } = {}) {
  if (!url) throw new Error('用法：replay explore <网址> [--focus "关心什么"]');
  const host = new URL(url).host;
  const id = slug(name || host);
  const dir = siteDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(os.tmpdir(), `replay-explore-${process.pid}.json`);
  const mod = pathToFileURL(path.join(REPO_ROOT, 'src', 'explore-ego.mjs')).href;
  console.log(`${color.cyan('▶')} 只读探索 ${url}${focus ? `（关注：${focus}）` : ''}，最多 ${maxPages} 页。不会点任何新建/编辑/删除/提交/导出。`);
  const script = `const { crawl } = await import(${JSON.stringify(mod)});
const r = await crawl({ start: ${JSON.stringify(url)}, focus: ${JSON.stringify(focus)}, maxPages: ${Number(maxPages)}, space: ${JSON.stringify(`REPLAY explore ${host}`)} });
(await import('node:fs')).writeFileSync(${JSON.stringify(out)}, JSON.stringify(r));`;
  const r = egoRun(script, { timeout: 30 * 60_000, inherit: true });
  const res = readJson(out);
  fs.rmSync(out, { force: true });
  if (!res) throw new Error(`探索没有结果（Ego 退出码 ${r.code}）`);
  if (res.stopped === 'login') {
    console.log(`${WARN} 入口是登录页（${res.title}）。先登录（agent 用 replay open/do，或交给用户扫码），再重跑 explore。`);
    process.exitCode = 4;
    return res;
  }
  const site = { schema: 'replay-site/1', id, ...res, exploredAt: new Date().toISOString() };
  writeJson(path.join(dir, 'sitemap.json'), site);
  fs.writeFileSync(path.join(dir, 'manual.md'), manualMd(site));
  console.log(`${OK} ${res.pages.length} 页，${(res.ms / 1000).toFixed(0)}s，Jev ${res.jevCalls} 次 ${(res.jevMs / 1000).toFixed(1)}s → ${dir}/manual.md`);
  return site;
}

const pct = (x) => (x == null ? '' : x.toFixed(2));

export function manualMd(site) {
  const P = site.pages;
  const md = [`# ${new URL(site.start).host} 操作手册`, '',
    `> 只读探索生成（${site.exploredAt.slice(0, 10)}，${P.length} 页${site.focus ? `，关注：${site.focus}` : ''}）。没有点过任何会改数据的按钮；"导出"入口只记录不点。`, ''];
  if (site.notes?.length) md.push('## 实际跑过之后学到的', '', ...site.notes.map((n) => `- ${n.text}（${n.at.slice(0, 10)}）`), '');
  // Map: nav structure from the entry page plus page tree.
  md.push('## 网站地图', '');
  const byFrom = new Map();
  for (const p of P) { if (!byFrom.has(p.from)) byFrom.set(p.from, []); byFrom.get(p.from).push(p); }
  const walk = (from, depth) => { for (const p of byFrom.get(from) || []) { md.push(`${'  '.repeat(depth)}- [${p.id}] ${p.headings[0] || p.title}  \`${new URL(p.url).pathname}${new URL(p.url).search}\``); if (depth < 4) walk(p.id, depth + 1); } };
  walk(null, 0);
  md.push('');
  // Where the data is.
  const data = P.filter((p) => p.tables.length || (p.tags?.lists ?? 0) > 0.6);
  if (data.length) {
    md.push('## 数据在哪', '', '| 页面 | 表格列 | 条数 | 筛选 | 导出入口 |', '|---|---|---|---|---|');
    for (const p of data) md.push(`| [${p.id}] ${p.headings[0] || p.title} | ${p.tables.map((t) => t.columns.slice(0, 8).join('、')).join(' / ') || '-'} | ${p.total || p.tables.map((t) => t.rows).join('/') || '-'} | ${p.filters.slice(0, 5).map((f) => f.label || f.kind).filter(Boolean).join('、') || '-'} | ${p.exports.map((e) => e.text).join('、') || '-'} |`);
    md.push('');
  }
  md.push('## 各页面', '');
  for (const p of P) {
    md.push(`### [${p.id}] ${p.headings[0] || p.title}`, '', `- 网址：${p.url}${p.same ? `（同类页面还有 ${p.same} 个，模板 \`${new URL(p.template).pathname}\`）` : ''}`, `- 从哪进：${p.from ? `[${p.from}] 点「${p.via}」` : '入口'}`);
    if (p.breadcrumb.length) md.push(`- 位置：${p.breadcrumb.join(' › ')}`);
    if (p.tags && !p.tags.error) md.push(`- 判断（Jev）：列表 ${pct(p.tags.lists)} · 可筛选 ${pct(p.tags.filters)} · 可导出 ${pct(p.tags.exportable)} · 报表 ${pct(p.tags.report)} · 表单 ${pct(p.tags.form)}${p.tags.relevant != null ? ` · 与关注相关 ${pct(p.tags.relevant)}` : ''}`);
    for (const t of p.tables) md.push(`- 表格${t.caption ? `「${t.caption}」` : ''}：${t.columns.join('、') || '（无表头）'}（本页 ${t.rows} 行${p.total ? `；${p.total}` : ''}）`);
    if (p.filters.length) md.push(`- 筛选/输入：${p.filters.slice(0, 12).map((f) => `${f.label || '(无标签)'}〔${f.kind}${f.options ? `：${f.options.slice(0, 8).join('/')}` : ''}〕`).join('；')}`);
    if (p.rowChecks) md.push(`- 每行有勾选框（${p.rowChecks} 个），可批量操作`);
    if (p.revealed.length) md.push(`- 展开过的菜单/标签：${p.revealed.join('、')}`);
    if (p.exports.length) md.push(`- 导出/下载入口（没点）：${p.exports.map((e) => `「${e.text}」`).join('、')}`);
    if (p.changes.length) md.push(`- 会改数据的入口（没点）：${p.changes.join('、')}`);
    if (p.apis.length) md.push(`- 背后接口：${p.apis.slice(0, 8).map((a) => `\`${a}\``).join('、')}`);
    md.push('');
  }
  // Recipes: how to pull data from each exportable list.
  const recipes = P.filter((p) => p.exports.length && (p.tables.length || (p.tags?.lists ?? 0) > 0.6));
  if (recipes.length) {
    md.push('## 怎么拉数（配方草稿）', '');
    for (const p of recipes) {
      const path_ = []; let cur = p;
      while (cur?.from) { path_.unshift(`点「${cur.via}」`); cur = P.find((x) => x.id === cur.from); }
      md.push(`- **${p.headings[0] || p.title}**：${path_.length ? `${path_.join(' → ')}（或直接打开 ${p.url}）` : `打开 ${p.url}`} → ${p.filters.length ? `按需设置 ${p.filters.slice(0, 4).map((f) => f.label || f.kind).join('、')} → ` : ''}点「${p.exports[0].text}」→ 文件进 ~/Downloads${p.apis.length ? `。数据接口可能是 \`${p.apis.find((a) => /api|json|list|search/i.test(a)) || p.apis[0]}\`` : ''}`);
    }
    md.push('');
  }
  if (site.skipped.length) md.push('## 没进去的', '', ...site.skipped.slice(0, 25).map((s) => `- ${s.text ? `「${s.text}」 ` : ''}${s.url}：${s.why}`), '');
  if (site.unvisited.length) md.push(`## 还没逛到的链接（页数上限）`, '', site.unvisited.slice(0, 25).map((u) => `「${u.text}」`).join('、'), '');
  return md.join('\n');
}

// Lessons learned while running against the site go back into the manual and
// become hints for every later plan on that site.
export function addNote(name, text) {
  const id = slug(name);
  const f = path.join(siteDir(id), 'sitemap.json');
  const site = readJson(f);
  if (!site) throw new Error(`没有网站 ${id}`);
  (site.notes ||= []).push({ at: new Date().toISOString(), text });
  writeJson(f, site);
  fs.writeFileSync(path.join(siteDir(id), 'manual.md'), manualMd(site));
  return site.notes.length;
}

export function readManual(name) {
  const id = name ? slug(name) : (fs.existsSync(SITES) ? fs.readdirSync(SITES).sort((a, b) => fs.statSync(siteDir(b)).mtimeMs - fs.statSync(siteDir(a)).mtimeMs)[0] : null);
  const f = id && path.join(siteDir(id), 'manual.md');
  return f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : `${BAD} 没有这个网站的手册（先 replay explore <网址>）`;
}

// Request → draft plan from the manual. Jev picks the page; the commander
// reviews the draft (filters, values, evidence) before running it.
export async function planFromManual(request, { site: name = null, out = null, values = {} } = {}) {
  const id = name ? slug(name) : fs.readdirSync(SITES).sort((a, b) => fs.statSync(siteDir(b)).mtimeMs - fs.statSync(siteDir(a)).mtimeMs)[0];
  const site = readJson(path.join(siteDir(id), 'sitemap.json'));
  if (!site) throw new Error('没有网站地图（先 replay explore）');
  const cands = site.pages.filter((p) => p.tables.length || p.exports.length || (p.tags?.lists ?? 0) > 0.5);
  const r = await askJev({ request, pages: cands.map((p) => `${p.id}: ${p.headings[0] || p.title}`) }, {
    page: { type: 'choice', instructions: `Which page is the right place to fulfil this request: ${request}`, criteria: Object.fromEntries(cands.map((p) => [p.id, `${p.headings[0] || p.title} — columns: ${p.tables.map((t) => t.columns.slice(0, 10).join(', ')).join(' / ')}; filters: ${p.filters.map((f) => f.label).filter(Boolean).slice(0, 8).join(', ')}; export: ${p.exports.map((e) => e.text).join(', ')}`])) },
  });
  let { choice, p: prob } = choiceOf(r.answers.page);
  // A page whose own heading is named in the request (e.g. a status or report
  // name) is a more specific answer than a general list: prefer it.
  const low = request.toLowerCase();
  // Headings often carry the breadcrumb ("Status Labels Ready to Deploy"): try every word suffix.
  const nameHit = (p) => {
    const words = String(p.headings[0] || '').trim().split(/\s+/);
    let best = '';
    for (let i = 0; i < words.length; i++) {
      const tail = words.slice(i).join(' ');
      if ((words.length - i >= 2 || tail.length >= 8) && tail.length > best.length && low.includes(tail.toLowerCase())) best = tail;
    }
    return best;
  };
  const named = cands.map((p) => ({ p, hit: nameHit(p) })).filter((x) => x.hit).sort((a, b) => b.hit.length - a.hit.length)[0]?.p;
  let why = `Jev 选页 ${choice}（p=${prob.toFixed(2)}）`;
  if (named && named.id !== choice) { why = `需求里点名了「${nameHit(named)}」，用 ${named.id}（Jev 原选 ${choice}，p=${prob.toFixed(2)}）`; choice = named.id; prob = Math.max(prob, 0.9); }
  const pg = site.pages.find((x) => x.id === choice);
  if (!pg) throw new Error('Jev 没找到合适的页面');
  // Values named in the request become {{key}} references in stage goals.
  let req = request;
  for (const [k, v] of Object.entries(values)) if (v.value) req = req.split(v.value).join(`{{${k}}}`);
  const already = await askJev({ request, page: `${pg.headings.join(' / ')} — ${pg.title} — ${pg.url}` }, { ok: { type: 'noul', instructions: 'Opening this page already shows exactly the records the request asks for, so no extra filter or search is needed.' } }).then((x) => x.answers?.ok?.noul ?? 0).catch(() => 0);
  const stages = [
    { id: 's1', type: 'open', url: pg.url },
    ...(already >= 0.7 ? [] : [{ id: 's2', type: 'do', goal: `按需求设置页面上的筛选/搜索条件：${req}。只设置条件、让列表刷新，不要导出、不要改任何数据`, values: Object.keys(values), valueHints: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.hint])), hints: [`操作手册：这页的筛选有 ${pg.filters.map((f) => f.label || f.kind).filter(Boolean).join('、') || '（无）'}`, '条件都设好、列表（和总条数）已经按条件刷新，这一段就完成了；不用再点刷新'], maxSteps: 10, until: Object.keys(values).length ? 'values' : 'confirm' }]),
  ];
  if (pg.exports.length) {
    const fmt = (/csv/i.test(request) && 'CSV') || (/excel|xlsx?/i.test(request) && 'Excel') || (/pdf/i.test(request) && 'PDF') || null;
    const ext = { CSV: 'csv', Excel: 'xls*', PDF: 'pdf' }[fmt] || '*';
    const all = /所有|全部|全量|\ball\b|entire|every/i.test(request);
    const paged = /\bof\s+[\d,]+\s+(rows|entries|items|records)|共\s*[\d,]+\s*条/i.test(pg.total || '');
    const hints = [`操作手册：这页的导出/下载入口有 ${pg.exports.map((e) => `「${e.text}」`).join('、')}`];
    for (const n of site.notes || []) hints.push(`这个网站的经验：${n.text}`);
    if (all && paged) hints.push(`列表是分页的（${pg.total}）：要导出全部，先把每页条数调到最大/"全部"，或找"导出全部"的入口；只导出当前页不算完成`);
    // Paged list + "all": first get every row onto one page (skipped when it already is).
    if (all && paged) stages.push({ id: 'sx', type: 'do', goal: '把列表每页显示条数调到不少于总条数（例如 100/200/500/全部），让所有记录显示在一页上；不要改任何数据', hints: [`操作手册：列表 ${pg.total}`, ...(site.notes || []).map((n) => `这个网站的经验：${n.text}`)], maxSteps: 4, skipIf: { allOnPage: true } });
    // The manual saw which control opens the export menu and which items it has:
    // that becomes the expected path, so Jev's matching pick can go ahead.
    const trig = pg.exports.find((e) => !e.href && /^(export( data)?|导出)$/i.test(e.text.trim())) || pg.exports.find((e) => !e.href && /export|导出/i.test(e.text) && !/custom|自定义/i.test(e.text));
    const item = fmt && pg.exports.find((e) => new RegExp(fmt === 'Excel' ? 'excel' : `^${fmt}$`, 'i').test(e.text.trim()));
    const expect = trig ? [{ op: 'click', name: trig.text.trim() }, ...(item ? [{ op: 'click', name: item.text.trim() }] : [])] : null;
    stages.push({ id: 's3', type: 'do', ...(expect ? { expect } : {}), goal: `用页面自带的导出功能把${all ? '全部记录' : '当前列表'}导出${fmt ? `成 ${fmt}` : ''}。导出菜单可能要先展开再选格式；不要改任何数据`, hints, maxSteps: 10, check: { file: `~/Downloads/*.${ext}`, ...(all && paged && ext === 'csv' ? { rows: 'page' } : {}) } });
  } else {
    stages.push({ id: 's3', type: 'check', jev: `页面上的列表已经是按「${request}」筛选后的结果` });
  }
  stages.forEach((st, i) => { st.id = `s${i + 1}`; });
  const plan = { schema: 'replay-plan/1', name: `${request}`.slice(0, 40), task: request, site: id, inputs: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { hint: v.hint, default: v.value }])), stages, note: `${why}；页面本身已满足筛选 ${already.toFixed(2)}。指挥检查筛选目标和完成证据后再跑。` };
  const file = out || path.join(siteDir(id), `plan-${slug(request).slice(0, 30)}.json`);
  writeJson(file, plan);
  return { file, plan, page: pg, p: prob };
}
