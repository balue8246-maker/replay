# REPLAY

**人做一遍，机器记住。** 录下你在浏览器里做一件事的过程，整理成带参数的技能，下次让 agent 在后台照着做——用录到的定位器直接跑，页面改版了用 Jev 在 0.4–1 秒内找回元素，实在不行才交给慢模型（如 Opus）接手。

*Record once, replay fast. A human demo becomes a parameterized skill; replay runs in the background in Ego Lite, using recorded locators first, Jev (TypeSafe System One) for ~1 s self-healing, and a slow model only on failure.*

> 状态：v0.1 MVP，仅 macOS，仅浏览器。桌面 App 与长任务工作流见 [路线图](docs/ROADMAP.md)。

## 它解决什么

日常工作流常常是：登录某个后台 → 切标签 → 选日期 → 导出 → 下载 → 跑脚本 → 截图发给自己。不是每一步都有 CLI 或 API，让大模型每次从头看页面又慢又贵、还不稳。REPLAY 把一次人工演示变成可复用的步骤：

| 层 | 谁来做 | 代价 |
|---|---|---|
| R0 | 录制时的定位器（test-id → 角色+名字 → name → id → 文本 → CSS） | 0 次模型调用 |
| R1 | Jev 在实时页面快照里挑出"同一个控件" | 每次约 1 秒、不到一分钱 |
| R2 | 慢模型接手：失败现场（URL、快照、尝试过的定位器）保留在 Ego 里 | 只在出错时 |

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
4. **录制扩展**——引导你在 Ego 里加载一次，并自动验证连通
5. **REPLAY 技能**——链接到 `~/.agents/skills/replay`，让 Claude Code / Codex / 其他 agent 会用
6. （可选）cua-driver 桌面权限

随时可用 `replay doctor` 复查。

## 用法

```bash
replay record "导出周报" --task "导出上周的销售明细" --inputs "日期范围"
# 在 Ego Lite 里正常操作；结束：点扩展图标 / Ctrl-C / replay stop
# 中途可以 replay mark "这里要等进度到 100%"

replay show                 # 看整理出的步骤和参数候选
replay run --param input_1=2026-10-01
replay save --as weekly-export
```

`replay record` 结束后会自动整理出：

- `steps.md`：可读步骤，每步后果（跳转、下载、调用了哪些接口）
- `steps.json`：可执行步骤（多个候选定位器、参数、检查点）
- `SKILL.draft.md`：技能草稿
- `refine-prompt.md`：交给慢模型的整理清单——删误操作、定参数、**问你 1–3 个没说出口的规则**、写完成证据

建议让 agent（装了 REPLAY 技能后）来驱动：说"我演示一遍，你记下来"即可。

## 隐私

- 只在 `replay record` 运行时记录，数据只发到 `127.0.0.1`，存在 `~/.replay/recordings/`
- 密码、验证码、卡号等字段遮蔽；URL 里的 token/key/sig 等参数脱敏
- 接口只记方法、地址、状态码，不记请求体和响应体
- 本地守护进程拒绝来自网页的写入（只接受扩展和本机工具）

## 自测

```bash
npm test             # 离线：守护进程 + 合成事件 + 整理
npm run test:ego     # 真实 Ego：录制表单 → 整理 → 换参数回放 → 破坏定位器后 Jev 自愈
```

## 致谢

录制脚本改编自 [ugarchance/record-and-replay-skill](https://github.com/ugarchance/record-and-replay-skill)（MIT）；Jev 调用方式与密钥位置沿用 [ZephyrDeng/ego-jev](https://github.com/ZephyrDeng/ego-jev)（MIT）。思路参考 Ghost OS、OpenAdapt、Skyvern 等，详见 [NOTICE](NOTICE.md)。

MIT License.
