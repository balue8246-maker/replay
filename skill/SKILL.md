---
name: replay
description: REPLAY — computer use + browser use where you (the slow model) command, Jev (~0.5 s) judges every screen, and code acts. Use for multi-step work in Ego Lite or desktop apps; for "我演示一遍/你跟着学/录一下/下次你照着做/把这个流程记下来" (teach: ask → demo with voice or typed narration → recap → supervised trial); for "你自己去学一下这个系统/出个操作手册/去 XX 后台拉个数" (explore a GUI site read-only → manual → plan); for rerunning a learned workflow with new inputs; and for long task chains (wait/poll/human checkpoints/resume).
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

## 2. Teach: learn a task from one demonstration

Learning is not recording a trajectory. The point is to understand what each step is for, so the next run can follow intent when inputs or the page change. Protocol:

1. **Ask first.** `replay teach start "<name>" [--url …]` prints a checklist: goal, output, system, inputs (what changes and how it is decided), fixed options, frequency, evidence, pitfalls, after-steps. Ask only what the request has not already answered, in **one** message. The user may answer by voice or text. Record answers with `replay teach brief k=v …`.
2. **Demo with narration.** Start `replay teach record` as a background job, then tell the user to go ahead. They work in Ego Lite and talk while they work (`ReplayVoice` on-device speech recognition; the first time, macOS shows a microphone popup in the name "REPLAY 旁白"). If they would rather type, they use the box in the bottom-right of the page, or you relay their chat with `replay teach note "…"`. Use `--no-voice` to type only. Stop with `replay teach stop` or the extension icon.
3. **Understand, recap, confirm.** `understanding.md` lists the steps with narration attached, guesses which params vary or stay fixed, flags fumbles (repeated clicks, went-and-came-back), APIs behind the page (with query keys), downloads, spoken evidence, and questions. Read it, glance at screenshots if needed, then recap to the user in 3–5 sentences: what to get, what varies and how, what is fixed, how to prove it is right, and how you plan to do it next time. Ask the questions together in one message. Record replies with `replay teach answer <id> "…"`. Name params with `answer name_input_1 "brand 品牌"`. Record corrections with `replay teach correct "…"`.
4. **Compile.** `replay teach compile` writes `procedure.md` (the method, written as intent) and `plan.json`. Values become `{{key}}`. Confirmed fumbles are dropped, but their narration is kept. Spoken evidence becomes a check, and "rows = page total" becomes `rows:'page'`. Pagination stages get `skipIf: {allOnPage:true}`.
5. **Supervised trial.** `replay teach trial --param brand=Lenovo` uses **different** inputs. It pauses before the stage that produces the result. Show the user, then `replay plan resume`. Anything that went wrong goes back as `teach correct`.
6. **Save** only after a clean trial and the user's OK: `replay teach save --as <name>` → `~/.replay/skills/<name>/plan.json`.

The low-level `replay record` / `plan from` path (§4) still exists. Use `teach` whenever a human is teaching.

## 3. Explore: learn a GUI site without a demonstration

```bash
replay explore https://site/ --focus "资产 导出" [--max 25] [--as name]   # read-only crawl → sitemap.json + manual.md
replay explore manual name                                               # print the manual
replay explore plan "导出所有可部署、搜 Dell 的资产 CSV" --value "q=Dell::search keyword" --as name
replay explore note name "导出只导当前页，先把每页条数调大"                 # lessons from runs go back into the manual
```

Exploration never submits, creates, deletes or exports. It only opens nav, tabs and expanders, and stops at login walls (exit 4). It needs the user's logged-in Ego profile for private systems. The manual lists the map, where data lives (lists, totals, filters, export entries, APIs), and how to pull data. `explore plan` turns a request into stages: open the right page (a page the request names beats Jev's pick), set the filters (done once every given value is filled), show all rows if paged, then export (expected path taken from the manual). Evidence is the file plus `rows:'page'`, so page-only exports are caught. Review the plan's `note`, then `replay plan run`. Write what you learn back with `explore note`.

## 4. Record (low level)

```bash
replay record "<name>" --task "<goal>" --inputs "<what varies>"
```

On stop it distills into `<recording>/distilled/`: `steps.md`, `steps.json`, `plan.json`, `SKILL.draft.md`, `refine-prompt.md`. Recording is local only. Password/OTP/card fields are masked and query secrets are redacted.

## 5. Task chain (plan.json)

```bash
replay plan from <recording>                         # regenerate plan.json draft
replay plan run plan.json --param input_1=... [...]  # exit 0 done · 3 needs you · 4 needs the human · 1 failed
replay plan resume [--skip]                          # after you/the human handled the stop
```

Stage types: `open` (url or app/title), `do` (Jev inner loop; recorded actions become `hints` + `expect`, so the stage ends when all recorded actions are done), `act` (plan-approved action on a named element — writing it into the plan is your approval), `key`, `wait`, `poll` (repeat a check, optional reload), `human`, `check` (`url` glob, `text`, `jev` yes/no question, `file` glob newer than the stage, `rows` (number or `'page'` = the list total parsed from the page, CSV-aware, footers ignored), `allOnPage`). Any stage may carry `skipIf: <check>`. A `do` stage may carry `until: 'values'` (done once every given value is filled) and `trialStop` (pause here in `--trial`). See `examples/httpbin-pizza.plan.json`.

When a run stops with exit 3, the session stays on the stopping screen: use `replay look/act` to fix it, then `replay plan resume` (re-run the stage) or `--skip` (you finished it by hand). Edit the plan when the stop reveals a missing rule.

## 6. Save

Only after a clean run with new inputs **and the user's OK**: `replay teach save --as <name>` (or `replay save <recording> --as <name>`). Never save from an unreviewed run (trajectory poisoning).

## Limits

- Jev is text-only and weaker on CJK; a plurality is accepted only for reversible form controls or when it agrees with the recording.
- Desktop: windows on another Space are not observable until fronted; inside Chromium windows prefer Ego for web content (pointer clicks there do not land; REPLAY presses web elements through AX). Screenshots are taken only after the target window is verified frontmost.
- Voice: on-device recognition is good but can mishear homophones ("导出" → "到出"). The recap step exists to catch that.
- `replay run` (v0.1 locator replay) still exists for pure-browser recordings; `plan run` is the default.
