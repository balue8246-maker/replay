---
name: replay
description: REPLAY — computer use + browser use where you (the slow model) command, Jev (~0.5 s) judges every screen, and code acts. Use for multi-step work in Ego Lite or desktop apps, for "录一下/我演示一遍/下次你照着做/回放/replay/把这个流程记下来", for rerunning a recorded workflow with new inputs, and for long task chains (wait/poll/human checkpoints/resume).
license: MIT
---

# REPLAY

Three roles (details: `docs/DESIGN.md`):

- **You = commander.** Split the task into stages, give each a sub-goal, the values it may use, and the evidence that proves it done. Handle what Jev hands back: confirmations, free text, logins, odd screens, waits.
- **Jev = judge.** After every action it reads the screen as text and answers: which elements matter for the sub-goal, which one next, which value goes where, and whether the screen is loaded / errored / has a dialog / is done / is stuck. It never acts.
- **Code = capability.** Ego Lite for web (background task space, does not take the screen), cua-driver for desktop apps (AX tree), Peekaboo for native open/save dialogs, and macOS Vision OCR when a window has no AX tree (the window is verified frontmost before any screenshot).

You read Jev's ~10-line view, not snapshots or screenshots. Look at pixels yourself only when the view says the screen has no readable structure.

CLI: `replay` (repo `bin/replay.mjs`; if not on PATH use `node <repo>/bin/replay.mjs`). Run every command yourself — never ask the user to run terminal commands. `replay doctor` checks readiness; `replay setup --yes` fixes what it can. Only macOS permission grants (Accessibility / Screen Recording) and QR scans need the human.

## 1. Commander loop (ad-hoc tasks)

```bash
replay open https://site/page --new --goal "子目标" --value name=Dana::顾客名 --hint "上次点的是「导出」"
replay open --app 计算器 --new --goal "…"          # desktop window (cua-driver)
replay do "子目标"        # inner loop: Jev-confident, safe steps run automatically; stops with a view when not
replay look [--all]       # observe + judge once
replay act @12            # you decide: click / --fill 文本 / --use 值键 / --select 选项 / --press return
replay act auto           # run Jev's suggestion when the view says 可自动执行
replay act --hotkey cmd+shift+g | --type 文本 | --goto URL | --scroll
replay end                # prints looks / acts (Jev auto vs you) / Jev calls / time
```

The view ends with either `→ 可自动执行` or `→ 交给指挥：<why>`. Escalations you must handle: guarded actions (submit / send / pay / delete / confirm — you decide, then `replay act <id>`), missing values, low confidence, stuck, Jev failure, no readable structure.

Jev's "done" is a claim. Prove completion with independent evidence: URL, a value on the result page, a downloaded file, an API result, a message id.

Dialogs: when an action opens an open/save window of the same app, the session follows it automatically; when it closes, the session falls back to the previous window. `replay open --title <窗口标题>` switches by hand. Native file choosers: `replay act --choose <path>` (or give the path as a value to `replay do`; the dialog shows a `file-chooser` candidate that Jev fills) — it goes to the path, presses the confirm button, and fails unless the dialog closes. Web `<input type=file>` in Ego: use Ego's `setInputFiles` instead of the native dialog.

## 2. Record (the human does it once)

Ask what the task is for and which inputs change each time, then run as a background job:

```bash
replay record "<name>" --task "<goal>" --inputs "<what varies>"
```

The user works normally in Ego Lite (extension badge REC); stop with the icon or `replay stop`. Recording is local only; password/OTP/card fields are masked; query secrets are redacted.

On stop it distills into `<recording>/distilled/`: `steps.md`, `steps.json`, `plan.json` (task chain draft), `SKILL.draft.md`, `refine-prompt.md`. Follow `refine-prompt.md`: drop mis-clicks, decide parameters vs. defaults, ask the user 1–3 questions about unstated rules, add evidence checks.

## 3. Task chain (plan.json)

```bash
replay plan from <recording>                         # regenerate plan.json draft
replay plan run plan.json --param input_1=... [...]  # exit 0 done · 3 needs you · 4 needs the human · 1 failed
replay plan resume [--skip]                          # after you/the human handled the stop
```

Stage types: `open` (url or app/title), `do` (Jev inner loop; recorded actions become `hints` + `expect`, so the stage ends when all recorded actions are done), `act` (plan-approved action on a named element — writing it into the plan is your approval), `key`, `wait`, `poll` (repeat a check, optional reload), `human`, `check` (`url` glob, `text`, `jev` yes/no question, `file` glob newer than the stage). See `examples/httpbin-pizza.plan.json`.

When a run stops with exit 3, the session stays on the stopping screen: use `replay look/act` to fix it, then `replay plan resume` (re-run the stage) or `--skip` (you finished it by hand). Edit the plan when the stop reveals a missing rule.

## 4. Save

Only after a clean run with new inputs **and the user's OK**: `replay save <recording> --as <name>`. Never save from an unreviewed run (trajectory poisoning).

## Limits

- Jev is text-only and weaker on CJK; a plurality is accepted only for reversible form controls or when it agrees with the recording.
- Desktop: windows on another Space are not observable until fronted; inside Chromium windows prefer Ego for web content (pointer clicks there do not land; REPLAY presses web elements through AX). Screenshots are taken only after the target window is verified frontmost.
- `replay run` (v0.1 locator replay) still exists for pure-browser recordings; `plan run` is the default.
