# REPLAY

**computer use + browser use，快慢搭配。** 慢模型（如 Opus）当指挥：拆任务、处理例外、批准高风险动作；Jev（TypeSafe System One，每次约 0.5–1 秒）当判断：每一屏看什么、点哪个、填哪个值、做完没有；代码当手脚：网页用 Ego Lite，桌面用 cua-driver，系统文件对话框用 Peekaboo，读不到结构的界面用 macOS 自带文字识别。人演示一遍的录制会变成任务链和提示，下次照着跑。

*Slow model commands, Jev (~0.5–1 s typed judgments) decides each screen, code acts: Ego Lite for web, cua-driver + Peekaboo for macOS apps and native dialogs, Apple Vision OCR as a fallback. Demonstrations become task chains with hints.*

> 状态：v0.2，仅 macOS。设计见 [DESIGN](docs/DESIGN.md)，进度见 [路线图](docs/ROADMAP.md)。

## 实测（2026-10-08，本机）

| 用例 | 耗时 | 指挥介入 | Jev |
|---|---|---|---|
| 网页表单任务链（打开 → 填 4 项 → 计划内提交 → 等待 → 轮询核验） | 13.6 秒 | 0 次（提交是写在计划里的确认） | 9 次，共 4.2 秒 |
| 在 Ego 里重新加载扩展（点按钮 → 系统选目录窗口 → 确认） | 14 秒 | 0 次 | 4 次，共 2.1 秒 |
| 同上，v0.1 时全靠慢模型 | 约 9 分钟 | 全程 | — |

## 它解决什么

日常工作流常常是：登录某个后台 → 切标签 → 选日期 → 导出 → 下载 → 跑脚本 → 截图发给自己，中间还要等、要轮询、偶尔要人扫码。不是每一步都有 CLI 或 API，让大模型每一步都看屏幕又慢又贵。REPLAY 把"每一屏点哪个"交给 Jev，把"整件事怎么做、出了岔子怎么办"留给慢模型：

| 层 | 谁来做 | 代价 |
|---|---|---|
| 判断 | Jev 在实时页面/窗口的元素列表里打分：相关元素、下一步、填哪个值、状态（加载完/报错/弹窗/完成/卡住） | 每次约 0.5–1 秒、不到一分钱 |
| 自动执行 | 有把握且不是高风险动作（付款/删除/发送/提交…）就直接做 | 0 次慢模型 |
| 指挥 | 拆阶段、批准高风险动作、处理上交的异常、看证据 | 只在上交时 |

## 安装

需要 macOS、Node 20+。

```bash
git clone https://github.com/balue8246-maker/replay.git
cd replay
node bin/replay.mjs setup      # 或 npm link 后直接用 replay
```

初始化向导会逐项检查并补齐：

1. **Ego Lite**（agent 浏览器，可迁移 Chrome 登录态）——没装就给出官方下载
2. **ego-browser / ego-jev 技能**（`npx skills add …`）
3. **Jev API key**——到 [TypeSafe 控制台](https://console.typesafe.ai/) 申请；隐藏输入、在线验证、以 600 权限存到 `~/.config/ego-jev/secrets.env`（与 ego-jev 共用）
4. **录制扩展**——agent 通过 Ego 自己的扩展页面加载（需要 Ego 里开着 `ego://extensions`），并自动验证连通
5. **REPLAY 技能**——链接到 `~/.agents/skills/replay`，让 Claude Code / Codex / 其他 agent 会用
6. （可选）桌面：cua-driver、Peekaboo（`npm i -g @steipete/peekaboo`）；系统会弹窗要辅助功能权限，这一步要人点

随时可用 `replay doctor` 复查。

## 用法

建议让 agent（装了 REPLAY 技能后）来驱动。命令本身：

```bash
# 指挥循环：看一眼 → 做一步
replay open https://example.com --goal "提交订单" --value name=Alice
replay look                       # 约 10 行候选 + 状态 + Jev 的建议
replay act auto                   # 执行 Jev 有把握的那一步；或 replay act @3 / --fill / --press return
replay do "填好表单，不要提交"     # 内循环：Jev 自动做到有把握的地方，拿不准就上交
replay open --app 计算器 --new --goal "…"     # 桌面窗口同样用法
replay act --choose ~/Downloads/a.csv          # 系统打开/存储对话框
replay end                        # 指挥/Jev/耗时统计

# 任务链：阶段、证据、等待、轮询、人工节点、断点续跑
replay plan run examples/httpbin-pizza.plan.json --param input_1=Bob
replay plan resume <run-id> [--skip]

# 录制：人演示一遍 → 任务链
replay record "导出周报" --task "导出上周的销售明细" --inputs "日期范围"
replay plan from <录制>            # 生成 plan.json（阶段 + 上次的做法当提示）
```

## 隐私

- 只在 `replay record` 运行时记录，数据只发到 `127.0.0.1`，存在 `~/.replay/recordings/`
- 密码、验证码、卡号等字段遮蔽；URL 里的 token/key/sig 等参数脱敏
- 接口只记方法、地址、状态码，不记请求体和响应体
- 本地守护进程拒绝来自网页的写入（只接受扩展和本机工具）
- 截图识字前先把目标窗口调到最前并核验，核验不过就不截图；系统对话框走 Peekaboo 读结构，不截图

## 自测

```bash
npm test             # 离线：守护进程、判断规则、内循环、录制 → 任务链
npm run test:ego     # 真实 Ego：录制表单 → 整理 → 换参数回放
```

## 致谢

录制脚本改编自 [ugarchance/record-and-replay-skill](https://github.com/ugarchance/record-and-replay-skill)（MIT）；网页观察与 Jev 调用方式沿用 [ZephyrDeng/ego-jev](https://github.com/ZephyrDeng/ego-jev)（MIT）；桌面用 [cua-driver](https://github.com/trycua/cua)（MIT）和 [Peekaboo](https://github.com/openclaw/Peekaboo)（MIT）。思路参考 Ghost OS、OpenAdapt、Skyvern 等，详见 [NOTICE](NOTICE.md)。

MIT License.
