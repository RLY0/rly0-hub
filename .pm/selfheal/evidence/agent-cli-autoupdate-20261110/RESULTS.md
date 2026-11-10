# HUB-AGENT-CLI-AUTOUPDATE 后台证据

状态：implemented / self_verified；仅本主会话自检，independent review 与 accepted 均未完成。输入 `9dfd747c71c229ba6f373a2cb4f7f64718b1a902`，分支 `feat/agent-cli-autoupdate`。精确 cwd、命令、退出码及测试分布见 [checks.json](checks.json)。改动文件见 [changed-files.json](changed-files.json)，源码指纹见 [source-sha256.json](source-sha256.json)。

## 已确认

- 本主会话亲跑 9 个文件，92 pass、0 fail、0 skip。命令是 `node node_modules/vitest/vitest.mjs run --config tests/vitest.config.js <checks.json 所列 9 文件>`。
- `npm run typecheck` exit 0。
- `node tools/check-boundaries.mjs` exit 0。
- `node node_modules/prettier/bin/prettier.cjs --check <改动文件>` exit 0。
- `npm run lint` exit 1：仅 `packages/host-runtime/test/rly0-hub-promo.test.ts:11:20` 的既有非空断言。把 `git show 9dfd747c:packages/host-runtime/test/rly0-hub-promo.test.ts` 通过 stdin 交给同一 ESLint、同一 filename，得到同一 exit 1 / 同一错误；该文件未修改。新增 lint 错误 0，lint 本身不记 pass。

全部命令由临时 HOME、USERPROFILE、CODEX_HOME、CODEXHOST_DATA_DIR、RLY0_MEMORY_DIR、CLAUDE_CONFIG_DIR、APPDATA、LOCALAPPDATA 包裹，`RLY0_SKIP_LEGACY_IMPORT=1`。依赖从相邻固定基线的 node_modules 复制到本 worktree，未安装新依赖；Workspace 软链接仍指向本 worktree。测试命令驱动、npm、native CLI、HTTP/Host 响应均注入 synthetic 实现；Windows npm.cmd 的实际 execFile 入口也被 mock。Host fixture 是内存流和 fake 官方进程，不是另起 hub-service。无真实全局 npm 安装/卸载、真实登录/付费探测或退出/重启日常程序。

覆盖默认开启/持久关闭、启动/每日检查、忙碌延期及缓存、前缀识别与 Windows shim、并发触发、工作围栏、线程启动竞争、更新后同选择器检查、坏版本跨重启跳过、安装失败与权限失败的回退、版本读回差异、回退失败后恢复、关闭期间的安全完成、坏状态 fail closed、事务日志写失败不安装和坏版本记录失败仍回退。

## 实现与交接

已实现启动及每日检查、默认开启的持久开关、管理 RPC、原 npm 全局位置安装/回退、每助手工作准入与全本机 Host 忙碌检查、更新后原生连接检查、坏版本持久跳过、异常事务恢复。原生 OpenCode 支持官方精确版本升降级；其他缺少可核实固定版本回退入口的脚本安装明确仅检测，不宣称已覆盖全部原生更新器。

契约：[AGENT-CLI-AUTOUPDATE-CONTRACT.md](../../AGENT-CLI-AUTOUPDATE-CONTRACT.md)。没有修改 `apps/hub-desktop/www`、没有打包、推送或发布。

next_action：Claude 按契约接 AI 助手页开关与状态；独立复核协议/工作准入；在获准独立环境做真实 npm、Mac/Windows、代理和连接/回退验收，再由 Claude 处理打包发布。原生脚本缺少可靠版本回退的能力缺口继续显式保留。

## 未确认与限制

- 未跑全量仓库测试；未运行 Rust/Renderer/打包/发行检查，因为没有修改对应实现，不运行会重启 Desktop 的 npm start。
- 未真实执行 npm 安装/卸载、官方 native updater、真实账号连接或联网 registry；没有真实 Windows 设备结论。
- 脚本安装只有核实官方精确版本回退入口后才可自动安装。当前支持标准位置的 native OpenCode；Pi/Grok/Cursor/OMP/Qoder/Hermes/Kimi/agy 原生安装仅检测，并报 ROLLBACK_UNSUPPORTED；Kiro/Devin 等未核实入口报 NO_OFFICIAL_UPDATER。npm 安装方式按实际已识别的 npm 包处理。
- Host 只能判断共享本机数据目录里的自身运行工作，无法知道另开终端或另一套数据目录的进程；厂商独立自动更新不由此开关控制。
- npm 包安装脚本可能写 prefix 外部，回装旧包不等于全系统快照恢复。损坏的 owner 围栏拒绝擅自回收。
- 协议与工作准入改动尚需独立审查。本轮没有委派第二会话，不伪称 reviewed。
- 界面、正式打包与发布交 Claude，未推送。

本地最终提交号由交付回复提供；源码指纹对应最终业务代码与契约，避免报告自引用尚未创建的提交。
