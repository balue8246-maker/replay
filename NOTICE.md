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
  (`~/.config/ego-jev/secrets.env`) follow ego-jev so both tools share one credential. REPLAY
  recommends installing ego-jev for open-ended multi-step page work; it does not vendor its code.
  https://github.com/ZephyrDeng/ego-jev

## Ideas only (no code copied)

- **Ghost OS** (MIT) — recipes learned from demonstrations, AX-tree-first perception.
- **OpenAdapt** / **openadapt-capture** (MIT) — desktop demonstration capture; planned desktop recorder.
- **Skyvern** (AGPL-3.0) — workflow block taxonomy (navigation / extraction / download / wait / human interaction / validation / loops). Ideas only; no AGPL code is included.
- **browser-use workflow-use** (AGPL-3.0) — deterministic replay with LLM fallback. Ideas only.
- **OpenAI Codex "record & replay"**, **Doubao recording** (closed source) — product shape only.

## Runtime dependencies (installed separately, not bundled)

- **Ego Lite** (citrolabs) — agent browser; https://github.com/citrolabs/ego-lite
- **TypeSafe System One / Jev** — fast typed judgments; https://typesafe.ai
- **cua-driver** (trycua, optional) — macOS desktop automation.
