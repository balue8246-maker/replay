# NOTICE

REPLAY is MIT-licensed. It adapts code and borrows ideas from the projects below.

## Adapted code (MIT)

- **ugarchance/record-and-replay-skill** — MIT, Copyright (c) 2026 ugarchance.
  `extension/content.js` adapts its in-page recorder: trusted-event listeners, element description
  (test-id / id / role+name / name / text / CSS path), debounced input capture, sensitive-field
  masking and secret-shape detection. Changes: runs as a Chrome extension content script inside
  Ego Lite instead of a Playwright init script; Chinese sensitive-field keywords; context capture
  (enclosing dialog/form/tablist); element rects.
  https://github.com/ugarchance/record-and-replay-skill
- **ZephyrDeng/ego-jev** — MIT. The TypeSafe System One request format and key-file location
  (`~/.config/ego-jev/secrets.env`) follow ego-jev so both tools share one credential.
  `src/web.mjs` adapts its page-snapshot parser and DOM candidate discovery (`jev-loop.ts`, v0.4.1).
  https://github.com/ZephyrDeng/ego-jev

## Ideas only (no code copied)

- **Agent Workflow Memory** (zorazrw/agent-workflow-memory, Apache-2.0) — induce reusable workflows from experience and abstract non-fixed values into named variables; REPLAY's `{{key}}` params and lesson compile follow this idea. No code copied.
- **SkillWeaver** (MIT) — explore a site → practice → distill skills; shape of `replay explore` (read-only crawl → manual → plan → run → write lessons back). No code copied.
- **AutoManual** (no license stated) — an agent writes its own manual of an environment from interaction; idea only.
- Research on GUI-agent reliability (self-reported confidence is poorly calibrated; completion detection is weak; poisoned trajectories get admitted as skills) motivated independent evidence checks and the supervised trial before saving.
- **Ghost OS** (MIT) — recipes learned from demonstrations, AX-tree-first perception.
- **OpenAdapt** / **openadapt-capture** (MIT) — desktop demonstration capture; planned desktop recorder.
- **Skyvern** (AGPL-3.0) — workflow block taxonomy (navigation / extraction / download / wait / human interaction / validation / loops). Ideas only; no AGPL code is included.
- **browser-use workflow-use** (AGPL-3.0) — deterministic replay with LLM fallback. Ideas only.
- **Browser-BC** — behaviour-cloning view of browser demos. Ideas only.
- **OpenAI Codex "record & replay"**, **Doubao recording** (closed source) — product shape only.

## Runtime dependencies (installed separately, not bundled)

- **Ego Lite** (citrolabs) — agent browser; https://github.com/citrolabs/ego-lite
- **TypeSafe System One / Jev** — fast typed judgments; https://typesafe.ai
- **cua-driver** (trycua, optional) — macOS desktop automation.
- **Peekaboo** (openclaw, MIT, optional) — native open/save dialogs (`dialog list`, `dialog click`); https://github.com/openclaw/Peekaboo
- **Apple Vision** (system framework) — on-device OCR via `native/ocr.swift`, compiled locally on first use.
