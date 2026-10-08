// Web capability layer. Runs INSIDE `ego-browser nodejs` (taskSpace is a global).
// Observes a Page as text candidates and executes one action. No judging here.
// Candidate parsing and DOM "dark matter" discovery reuse ego-jev (MIT) when it
// is installed; a small built-in parser is the fallback.
import os from 'node:os';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const EGO_JEV = `${os.homedir()}/.agents/skills/ego-jev/scripts/jev-loop.ts`;
let egoJev;
async function lib() {
  if (egoJev !== undefined) return egoJev;
  try { egoJev = fs.existsSync(EGO_JEV) ? await import(pathToFileURL(EGO_JEV).href) : null; } catch { egoJev = null; }
  return egoJev;
}

const ACTIONABLE = /^(link|anchor|button|textbox|searchbox|checkbox|radio|combobox|listbox|option|listboxoption|spinbutton|slider|switch|tab|menuitem|menuitemcheckbox|menuitemradio|treeitem|textarea)/;

function fallbackParse(snap) {
  const out = [];
  const lines = snap.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*([a-z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\[ref=(\d+)([^\]]*)\]/);
    if (!m) continue;
    let name = m[2] || '';
    if (!name) { const nx = (lines[i + 1] || '').match(/^\s*text "([^"]*)"/); if (nx) name = nx[1]; }
    out.push({ ref: Number(m[3]), role: m[1], name, context: '', css: (m[4].match(/loc=css:(.+?)(?:,\s*\w+=|$)/) || [])[1] || null, actionable: ACTIONABLE.test(m[1]) });
  }
  return out;
}

function textsOf(snap) {
  const seen = new Set();
  const out = [];
  for (const l of snap.split('\n')) {
    // Greedy to the last quote: snapshot text is not escaped (JSON, quotes in prose).
    const m = l.match(/^\s*(text|heading|alert|status|paragraph|caption|cell|label|code|blockquote)\s+"(.*)"(?:\s*\[[^\]]*\])?\s*$/);
    if (!m) continue;
    const t = m[2].replace(/\s+/g, ' ').trim();
    if (t.length < 2 || seen.has(t)) continue;
    seen.add(t);
    out.push(m[1] === 'text' ? t : `${m[1]}: ${t}`);
  }
  return out;
}

export async function observeWeb(page, { maxDom = 40 } = {}) {
  const t0 = Date.now();
  let snap = await page.snapshot();
  const L = await lib();
  let parsed = L ? L.parseSnapshot(snap) : fallbackParse(snap);
  if (!parsed.some((c) => c.actionable)) { snap = await page.snapshot({ scope: 'full_page' }); parsed = L ? L.parseSnapshot(snap) : fallbackParse(snap); }
  const cands = parsed.filter((c) => c.actionable).map((c) => ({ id: `@${c.ref}`, role: c.role, name: c.name || '', context: c.context || '', css: c.css || null }));
  if (L) {
    try {
      const dom = await L.collectDomInteractives(page, parsed.filter((c) => c.css).map((c) => c.css), maxDom);
      // A DOM clickable that repeats an a11y candidate's name is the same control
      // seen twice; offering both splits Jev's probability mass between them.
      const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const named = new Set(cands.map((c) => norm(c.name)).filter(Boolean));
      for (const d of dom) if (!named.has(norm(d.name))) cands.push({ id: `d${d.idx}`, role: `dom:${d.role || d.tag}`, name: d.name, context: '', xy: d.xy || null });
    } catch {}
  }
  // Current values / checked state / select options for fields we can address by CSS.
  const withCss = cands.filter((c) => c.css);
  if (withCss.length) {
    try {
      const info = await page.evaluate((list) => list.map((css) => {
        const el = document.querySelector(css);
        if (!el) return null;
        const o = {};
        if (el.tagName === 'SELECT') { o.options = [...el.options].map((x) => (x.label || x.text || x.value || '').trim()).filter(Boolean); o.value = el.selectedOptions[0]?.label || ''; }
        else if (el.type === 'checkbox' || el.type === 'radio') o.checked = el.checked;
        else if ('value' in el && el.value) o.value = String(el.value).slice(0, 80);
        return o;
      }), withCss.map((c) => c.css));
      withCss.forEach((c, i) => Object.assign(c, info[i] || {}));
    } catch {}
  }
  // The snapshot clips long text ("…"); give the judge a bounded plain-text
  // excerpt so result pages (JSON, tables, confirmations) can be judged.
  let excerpt = '';
  try { excerpt = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1200)); } catch {}
  return { surface: 'web', where: await page.url().catch(() => ''), title: await page.title().catch(() => ''), candidates: cands, texts: textsOf(snap), excerpt, ms: Date.now() - t0 };
}

function selectorFor(c) {
  if (String(c.id).startsWith('@')) return c.id;
  if (String(c.id).startsWith('d')) return `loc=css:[data-ego-jev="${String(c.id).slice(1)}"]`;
  return c.id;
}

// action = { op: click|dblclick|fill|select|press|check, value?, key? }
export async function actWeb(page, cand, action) {
  const t0 = Date.now();
  const before = await page.url().catch(() => '');
  const sel = cand ? selectorFor(cand) : null;
  const to = { timeout: 5000 };
  switch (action.op) {
    case 'click':
      if (cand?.xy) await page.mouse.click(cand.xy.x, cand.xy.y);
      else await page.click(sel, { ...to, label: cand?.name?.slice(0, 30) || undefined });
      break;
    case 'dblclick': await page.dblclick(sel, to); break;
    case 'fill': await page.fill(sel, String(action.value ?? ''), { clearFirst: true, ...to }); break;
    case 'select': await page.selectOption(sel, String(action.value ?? ''), to); break;
    case 'press': if (sel) await page.press(sel, action.key, to); else await page.keyboard.press(action.key); break;
    case 'type': await page.keyboard.type(String(action.value ?? '')); break;
    case 'goto': await page.goto(action.value, { waitUntil: 'domcontentloaded' }); break;
    case 'scroll': await page.mouse.wheel(0, 700); break;
    default: throw new Error(`unknown web op ${action.op}`);
  }
  // Let the consequence land: navigation, XHR re-render, or nothing.
  await page.waitForLoadState('load', { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(350).catch(() => {});
  const after = await page.url().catch(() => '');
  return { ms: Date.now() - t0, navigated: after !== before, url: after };
}
