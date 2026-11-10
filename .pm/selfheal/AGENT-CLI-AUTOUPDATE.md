# HUB-AGENT-CLI-AUTOUPDATE：AI 助手命令行工具自动更新（2026-11-10 用户确认“要自动更新”）

## 用户决定
- 自动更新 AI 助手页里的命令行工具（全自动），配保险：更新后立即做 Hub 现有的连接检查，对接不上就自动退回旧版并拉黑该版本，界面提示。
- AI 助手页有“自动更新”开关，默认开。
- 不管 Claude Code（自带自动更新）、不管 Codex（另有版本管控 HUB-CODEX-VERSION-GATE）、不管桌面应用类（ZCode、Antigravity 桌面、WorkBuddy）。

## 行为
- 每天一次（Hub 启动后也检查一次）查各 CLI 最新版本：npm 安装的用 registry 查询（走 Hub 的代理设置）；脚本安装的若有官方 update/self-update 子命令则用之，否则只检测不更新并写明。
- 只在该工具没有任何运行中的对话时更新（host-runtime 知道每个 harness 的线程是否在跑）；用原安装位置/前缀（npm -g 同一 prefix）。
- 更新后跑 agents 的连接检查（与 Codex 选择器同一检查）；不是 ready → 回退到原版本（npm install -g pkg@<原版本>），记录 badVersions，不再尝试该版本；回退失败也要明确报错。
- 状态接口给界面：每个 agent 的 当前版本 / 最新版本 / 上次检查 / 上次更新 / 结果（updated、rolled-back、skipped-busy、failed + 错误码）/ 开关。
- Mac 与 Windows 都要支持；Windows 注意 npm.cmd 与权限。

## 分工
- Codex（GPT-6.1-Sol max）：后台逻辑、状态接口契约、测试（全部隔离，绝不对真实全局 npm 前缀执行安装）。
- Claude：AI 助手页开关与状态显示、发布。
- 分支：基于 feat/codex-version-gate @9dfd747c 新开 feat/agent-cli-autoupdate（同一发布批次）。


## 独立复查 #1 修复（2026-11-10）

输入 976c0194，B1/B2、重要 1–5 与次要后台项已修；13 文件 174 项隔离 synthetic 回归通过，未执行真实安装。当前 self_verified，修复后 reviewed/accepted 待完成。契约以 v2 新节为准；逐条文件行号、命令与结果见 [RESULTS](evidence/agent-cli-autoupdate-review1-20261110/RESULTS.md)。Claude 既有界面保留，新增状态映射及发布交 Claude。
