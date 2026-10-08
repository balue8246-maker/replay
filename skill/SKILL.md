---
name: replay
description: REPLAY — record a human doing a browser workflow once, distill it into a parameterized skill, and replay it in Ego Lite in the background (recorded locators first, Jev ~0.4 s self-healing when the page changed, slow model only on failure). Use when the user says "录一下/我演示一遍/下次你照着做/回放/replay/把这个流程记下来", or asks to rerun a recorded workflow with new inputs.
license: MIT
---

# REPLAY

REPLAY turns one human demonstration into a reusable, verifiable workflow.

- **Perception**: Ego Lite page snapshot (text), never pixels by default.
- **Fast layer**: recorded locators (R0, no model) → Jev picks the element on the live page when a locator broke (R1, ~0.4–1 s).
- **Slow layer (you)**: understand the demo, ask the user about implicit rules, write the skill, take over when replay stops (R2).

CLI: `replay` (repo `bin/replay.mjs`; if not on PATH use `node <repo>/bin/replay.mjs`). Check readiness with `replay doctor`; if anything required is missing, ask the user to run `replay setup` in a terminal (it is interactive: Ego Lite install, Jev key, loading the recorder extension into Ego).

## 1. Record (the human does the task)

Before recording, ask the user two things: **what the task is for**, and **which inputs change each time** (dates, accounts, filters, file names). Then:

```bash
replay record "<short name>" --task "<goal>" --inputs "<what varies>"
```

Run it as a background job. Tell the user: operate normally in Ego Lite; the extension icon shows REC; stop with the icon, Ctrl-C, or `replay stop`. During the demo they may add notes with `replay mark "<note>"` (e.g. "这里要等进度到 100%").

Recording is local only (127.0.0.1). Password/OTP/card fields are masked; URL query secrets are redacted; only request metadata (method, URL, status) is kept.

## 2. Distill (you finish the skill)

`replay record` auto-distills on stop; otherwise `replay distill [recording]`. Output in `<recording>/distilled/`:

- `steps.md` — readable steps, parameter candidates, consequences (navigations, downloads, API calls)
- `steps.json` — executable steps (locator candidates ordered most-stable first, params, checkpoints)
- `SKILL.draft.md` — when to use / inputs / steps / checkpoints / evidence of completion
- `refine-prompt.md` — your checklist

Follow `refine-prompt.md`: drop mis-clicks, decide parameters vs. user defaults, **ask the user 1–3 questions about unstated rules**, add checkpoints and independent completion evidence (file exists, row count, API result, message id — never trust a success banner), mark login/QR/payment/delete/send steps as needing a human. Edit `steps.json` if needed, then write `SKILL.md`.

## 3. Replay

```bash
replay run <recording-or-skill> --param input_1=... --param select_1=...
```

Runs in a background Ego space (does not take the user's screen). Per step it reports `R0` (recorded locator) or `Jev 自愈 p=…`. Downloads are saved into the run folder and checked non-empty. On failure the Ego space stays on the failing page and `run.json` contains the error, tried locators, URL and a snapshot — take over from there with ego-browser / ego-jev, then fix `steps.json`.

## 4. Save

Only after a clean replay with new parameters **and the user's OK**:

```bash
replay save <recording> --as <skill-name>
```

Never save a skill from an unreviewed run (trajectory poisoning: a few bad runs can teach the library bad behavior).

## Limits (v0.1)

- Browser only. Desktop apps (cua-driver) and long-running multi-stage workflows (wait/poll/resume, human checkpoints) are on the roadmap — see `docs/ROADMAP.md`.
- Jev is text-only and weaker on CJK pages; treat low-confidence heals (p < 0.75) as suspicious and verify.
- Canvas / custom-drawn UIs have no usable DOM; hand those steps to the slow model.
