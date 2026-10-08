// Inner loop for one sub-goal: observe → Jev judges → act if confident & safe
// → observe … Stops and hands the commander a compressed view when Jev is
// unsure, the action needs confirmation, a value is missing, the screen has
// no readable structure, actions repeat without effect, or Jev claims done.
// Surface-agnostic: the caller supplies observe() and act().
import { judge, opFor, GUARD } from './judge.mjs';

const sig = (a) => `${a.op}:${a.id}:${a.valueKey || ''}`;

const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();

export async function innerLoop({ observe, act, goal, values = {}, hints = [], history = [], maxSteps = 15, ask, expect = null, untilValues = false }) {
  // untilValues: the sub-goal is "set these values" — once every provided value
  // has been filled without error and Jev has no confident next step, it is done.
  const used = new Set();
  // expect: recorded actions for this segment [{op, name}]. When all of them
  // have been executed successfully the segment is done — a deterministic
  // completion signal that does not depend on Jev's "done" judgment.
  const pending = expect ? expect.map((e) => ({ op: e.op, name: norm(e.name) })) : null;
  const steps = [];
  const stats = { jevCalls: 0, jevMs: 0, observeMs: 0, actMs: 0, autoActs: 0 };
  let lastObs = null;
  let view = null;
  let actFailures = 0;
  let waits = 0;
  const finish = (status, why) => ({ status, why, view, steps, history, stats, obs: lastObs });
  for (let step = 1; step <= maxSteps; step++) {
    lastObs = await observe();
    stats.observeMs += lastObs.ms || 0;
    try {
      view = await judge(lastObs, { goal, values, hints, history, ask });
    } catch (e) {
      view = null;
      return finish('escalate', `Jev 调用失败：${String(e.message || e).slice(0, 120)}`);
    }
    if (view.jev) { stats.jevCalls++; stats.jevMs += view.jev.ms; }
    let d = view.decision;
    // Recording × Jev: when Jev's top pick is one of the recorded actions still
    // pending, two independent signals agree — a plurality is enough.
    if (!d.auto && !d.done && pending?.length) {
      // The recorded element may be Jev's second or third pick (similar links
      // elsewhere on the page); accept it if it is close enough to the top.
      const best = view.ranked[0];
      const top = view.ranked.slice(0, 3).find((c) => pending.some((e) => e.op === opFor(c) && e.name && norm(c.name).includes(e.name)) && c.p >= (best?.p || 0) * 0.5) || best;
      const op = top && opFor(top);
      const matches = top && pending.some((e) => e.op === op && e.name && norm(top.name).includes(e.name));
      const valOk = op === 'click' || (d.value && d.value.key !== 'none' && d.value.p >= 0.6 && values[d.value.key]);
      if (matches && top.p >= 0.25 && valOk && !GUARD.test(top.name || '')) d = { auto: true, op, id: top.id, valueKey: op === 'click' ? undefined : d.value.key, why: `录制提示 + Jev p=${top.p.toFixed(2)}` };
    }
    if (d.done) return finish('done', d.why);
    if (!d.auto && untilValues && Object.keys(values).length && Object.keys(values).every((k) => used.has(k)) && !(view.ranked[0] && GUARD.test(view.ranked[0].name || ''))) return finish('done', `给定的值（${[...used].join('、')}）都已填入，Jev 没有更有把握的下一步`);
    // The recorded element is not on screen yet (page still rendering): wait and look again.
    if (!d.auto && pending?.length && waits < 3 && !lastObs.candidates.some((c) => pending.some((e) => e.name && norm(c.name).includes(e.name)))) {
      waits++; step--;
      await new Promise((r) => setTimeout(r, 1200));
      continue;
    }
    if (!d.auto) return finish('escalate', pending?.length ? `${d.why}（录制里还差：${pending.map((e) => `${e.op}「${e.name}」`).join('、')}；Jev 前三：${view.ranked.slice(0, 3).map((c) => `${opFor(c)}「${String(c.name || '').trim().slice(0, 30)}」${c.p.toFixed(2)}`).join('、')}）` : d.why);
    // Same action three times in a row without the screen moving on = no effect.
    const s = sig(d);
    const recent = steps.slice(-2).map((x) => x.sig);
    if (recent.length === 2 && recent.every((x) => x === s)) return finish('escalate', `同一个动作重复了 3 次仍未推进（${d.op} ${d.id}）`);
    const cand = lastObs.candidates.find((c) => String(c.id) === String(d.id));
    const action = { op: d.op, valueKey: d.valueKey, value: d.valueKey ? values[d.valueKey]?.value : undefined };
    const what = `${d.op} ${cand.role} "${(cand.name || '').slice(0, 40)}"${d.valueKey ? ` ← ${d.valueKey}` : ''}`;
    let res = null;
    let err = null;
    try { res = await act(cand, action); } catch (e) { err = String(e.message || e).slice(0, 200); }
    stats.actMs += res?.ms || 0;
    stats.autoActs++;
    history.push(err ? `${what} → FAILED: ${err.slice(0, 80)}` : what);
    steps.push({ step, sig: s, what, p: view.ranked[0]?.p, jevMs: view.jev?.ms, actMs: res?.ms, err, url: res?.url });
    if (!err && d.valueKey) used.add(d.valueKey);
    if (!err && pending) {
      const i = pending.findIndex((e) => e.op === d.op && e.name && norm(cand.name).includes(e.name));
      if (i >= 0) pending.splice(i, 1);
      if (!pending.length) { lastObs = await observe(); return finish('done', `录制里这一段的 ${expect.length} 个动作都已完成`); }
    }
    if (err && ++actFailures >= 2) { lastObs = await observe(); view = await judge(lastObs, { goal, values, hints, history, ask }).catch(() => view); return finish('escalate', `动作连续失败：${err}`); }
  }
  return finish('max_steps', `达到步数上限 ${maxSteps}`);
}
