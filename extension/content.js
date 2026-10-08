// REPLAY Recorder — content script (runs in every frame, at document_start).
// Captures trusted user actions as semantic events and hands them to the
// extension background, which forwards them to the local REPLAY daemon only
// while a recording is active. Nothing leaves the extension otherwise.
//
// Event capture and masking rules are adapted from
// ugarchance/record-and-replay-skill (MIT) — see NOTICE.md.
(() => {
  if (window.__replayRecorderInstalled) return;
  window.__replayRecorderInstalled = true;

  const SENSITIVE = /passw|otp|one-?time|cvv|cvc|card|secret|token|pin\b|ssn|iban|auth|密码|验证码|口令|身份证|银行卡|卡号/i;
  const MASK = '***MASKED***';

  function isSensitive(el) {
    if (!el || !el.getAttribute) return false;
    if (el.type === 'password') return true;
    const ac = el.getAttribute('autocomplete') || '';
    if (/^cc-/.test(ac) || ac === 'one-time-code') return true;
    const probe = [el.name, el.id, ac, el.getAttribute('placeholder'), el.getAttribute('aria-label')]
      .filter(Boolean).join(' ').toLowerCase();
    return SENSITIVE.test(probe);
  }

  function looksLikeSecret(s) {
    const t = String(s || '').trim();
    if (/^\d{6,8}$/.test(t)) return true;
    if (/^(sk-|ghp_|gho_|xox|AKIA|eyJ|-----BEGIN)/.test(t)) return true;
    return /^\S{16,}$/.test(t) && /[A-Z]/.test(t) && /[a-z]/.test(t) && /\d/.test(t);
  }

  function truncate(s, n) {
    if (typeof s !== 'string') return s;
    s = s.replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  const ROLE_MAP = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', summary: 'button', option: 'option' };
  function roleOf(el) {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (['checkbox', 'radio'].includes(t)) return t;
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    return ROLE_MAP[tag] || null;
  }

  function accessibleName(el) {
    if (!el || !el.getAttribute) return null;
    const aria = el.getAttribute('aria-label');
    if (aria) return truncate(aria, 80);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const txt = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
      if (txt.trim()) return truncate(txt, 80);
    }
    if (el.labels && el.labels.length) return truncate(el.labels[0].textContent, 80);
    if (el.placeholder) return truncate(el.placeholder, 80);
    const tag = el.tagName;
    if (['BUTTON', 'A', 'SUMMARY', 'LABEL', 'OPTION'].includes(tag) || el.getAttribute('role')) {
      const t = truncate(el.textContent || '', 80);
      if (t) return t;
    }
    if (el.value && ['submit', 'button'].includes(el.type)) return truncate(el.value, 80);
    const title = el.getAttribute('title');
    if (title) return truncate(title, 80);
    const img = el.querySelector && el.querySelector('img[alt]');
    if (img) return truncate(img.getAttribute('alt'), 80);
    return null;
  }

  const ID_OK = /^[A-Za-z][\w-]{0,63}$/;
  // Framework-generated ids/classes change between builds; skip them.
  const VOLATILE = /\d{3,}|[a-f0-9]{8,}|^(ember|react|radix|headlessui|mui|el-id|rc_|:r)/i;

  function cssPath(el) {
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id && ID_OK.test(node.id) && !VOLATILE.test(node.id)) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const sib = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sib.length > 1) part += ':nth-of-type(' + (sib.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
      depth += 1;
    }
    return parts.join(' > ');
  }

  // Nearest heading / label / dialog title gives the step its context
  // ("导出" inside "数据报表" dialog vs. on the page header).
  function contextOf(el) {
    let node = el.parentElement;
    let hops = 0;
    while (node && hops < 8) {
      const role = node.getAttribute && node.getAttribute('role');
      if (role === 'dialog' || node.tagName === 'DIALOG') {
        const name = accessibleName(node) || truncate(node.querySelector('h1,h2,h3,[class*="title"]')?.textContent || '', 60);
        if (name) return 'dialog: ' + name;
      }
      if (/^(FORM|FIELDSET|SECTION|NAV|TABLE)$/.test(node.tagName) || ['tablist', 'menu', 'toolbar', 'navigation', 'region', 'form', 'grid', 'table'].includes(role)) {
        const name = accessibleName(node);
        if (name) return (role || node.tagName.toLowerCase()) + ': ' + name;
      }
      node = node.parentElement;
      hops += 1;
    }
    return null;
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return null;
    const d = { tag: el.tagName.toLowerCase(), selectors: {} };
    for (const attr of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-e2e']) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v) { d.selectors.testId = { attr, value: v }; break; }
    }
    if (el.id && ID_OK.test(el.id) && !VOLATILE.test(el.id)) d.selectors.id = el.id;
    const role = roleOf(el);
    const name = accessibleName(el);
    if (role) d.role = role;
    if (name) d.name = name;
    if (el.name && typeof el.name === 'string') d.selectors.nameAttr = el.name;
    const text = truncate(el.textContent || '', 60);
    if (text && !['input', 'select', 'textarea'].includes(d.tag)) d.text = text;
    d.selectors.css = cssPath(el);
    if (el.type) d.inputType = el.type;
    if (el.placeholder) d.placeholder = truncate(el.placeholder, 60);
    if (d.tag === 'a' && el.getAttribute('href')) d.href = truncate(el.getAttribute('href'), 200);
    const ctx = contextOf(el);
    if (ctx) d.context = ctx;
    const r = el.getBoundingClientRect && el.getBoundingClientRect();
    if (r) d.rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    return d;
  }

  function targetOf(e) {
    const p = e.composedPath ? e.composedPath() : [e.target];
    return p[0] && p[0].nodeType === 1 ? p[0] : e.target;
  }

  const CLICKABLE = 'button, a, [role="button"], [role="link"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="tab"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [role="treeitem"], [role="gridcell"], input, select, textarea, summary, label, [onclick], [tabindex]';

  function send(payload) {
    try {
      chrome.runtime.sendMessage({
        __replay: true,
        frameUrl: location.href,
        title: window === window.top ? document.title : undefined,
        top: window === window.top,
        ...payload,
      });
    } catch { /* extension reloaded or context gone */ }
  }

  for (const type of ['click', 'dblclick', 'contextmenu']) {
    window.addEventListener(type, (e) => {
      if (!e.isTrusted) return;
      const el = targetOf(e);
      const clickable = el && el.closest ? el.closest(CLICKABLE) || el : el;
      send({ type, target: describe(clickable), x: Math.round(e.clientX), y: Math.round(e.clientY) });
    }, { capture: true, passive: true });
  }

  const inputTimers = new WeakMap();
  function flushInput(el) {
    const timer = inputTimers.get(el);
    if (timer) { clearTimeout(timer); inputTimers.delete(el); }
    const masked = isSensitive(el);
    let value = el.isContentEditable ? el.textContent : el.value;
    value = masked ? MASK : truncate(String(value ?? ''), 300);
    send({ type: 'input', target: describe(el), value, masked });
  }
  window.addEventListener('input', (e) => {
    if (!e.isTrusted) return;
    const el = targetOf(e);
    if (!el || (!('value' in el) && !el.isContentEditable)) return;
    if (['checkbox', 'radio', 'file'].includes(el.type) || el.tagName === 'SELECT') return;
    const t = inputTimers.get(el);
    if (t) clearTimeout(t);
    inputTimers.set(el, setTimeout(() => flushInput(el), 800));
  }, { capture: true, passive: true });
  window.addEventListener('blur', (e) => {
    const el = targetOf(e);
    if (el && inputTimers.has(el)) flushInput(el);
  }, { capture: true, passive: true });

  window.addEventListener('change', (e) => {
    if (!e.isTrusted) return;
    const el = targetOf(e);
    if (!el) return;
    if ((el.tagName || '') === 'SELECT') {
      const opt = el.selectedOptions && el.selectedOptions[0];
      send({ type: 'select', target: describe(el), value: isSensitive(el) ? MASK : truncate(el.value, 100), label: opt ? truncate(opt.textContent, 100) : null });
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      send({ type: 'toggle', target: describe(el), checked: el.checked });
    } else if (el.type === 'file') {
      send({ type: 'file_chosen', target: describe(el), files: Array.from(el.files || []).map((f) => f.name) });
    } else if (inputTimers.has(el)) {
      flushInput(el);
    }
  }, { capture: true, passive: true });

  window.addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.repeat || e.isComposing) return;
    const special = e.key && e.key.length > 1 && !['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Process', 'Unidentified'].includes(e.key);
    const combo = (e.metaKey || e.ctrlKey || e.altKey) && e.key && e.key.length === 1;
    if (!special && !combo) return;
    const el = targetOf(e);
    if (e.key === 'Enter' && el && inputTimers.has(el)) flushInput(el);
    if (combo && isSensitive(el)) return;
    send({
      type: 'key',
      key: e.key,
      modifiers: [e.metaKey && 'Meta', e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean),
      target: describe(el),
    });
  }, { capture: true, passive: true });

  window.addEventListener('submit', (e) => {
    const form = targetOf(e);
    if (form && form.elements) for (const f of form.elements) if (inputTimers.has(f)) flushInput(f);
    send({ type: 'submit', target: describe(form) });
  }, { capture: true, passive: true });

  window.addEventListener('copy', () => {
    const sel = String(window.getSelection ? window.getSelection() : '');
    const masked = looksLikeSecret(sel) || isSensitive(document.activeElement);
    send({ type: 'copy', text: masked ? MASK : truncate(sel, 200), length: sel.length });
  }, { capture: true, passive: true });

  window.addEventListener('paste', (e) => {
    const el = targetOf(e);
    const text = e.clipboardData ? e.clipboardData.getData('text') : '';
    send({ type: 'paste', target: describe(el), length: text.length });
  }, { capture: true, passive: true });

  let scrollTimer = null;
  window.addEventListener('scroll', () => {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const se = document.scrollingElement || document.documentElement;
      send({ type: 'scroll', y: Math.round(se.scrollTop), maxY: Math.round(se.scrollHeight - se.clientHeight) });
    }, 1000);
  }, { capture: true, passive: true });

  if (window === window.top) {
    const announce = () => send({ type: 'page', url: location.href, readyState: document.readyState });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', announce, { once: true });
    else announce();
  }
})();
