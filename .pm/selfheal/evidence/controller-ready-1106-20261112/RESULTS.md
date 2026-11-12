# Controller ready 与 26.1106 草稿绑定：self_verified

2026-11-12。工单：`HUB-CONTROLLER-READY-1106`。本轮由主会话实现并亲自执行下列检查；仅自检，独立 reviewed / 真机 accepted 均未完成。

- cwd：`/Volumes/RLY0Dev/Dev/Projects/codex插件助手/.runtime/agent-cli-autoupdate`
- 分支：`feat/agent-cli-autoupdate`；开工时干净，输入 HEAD：`544adb3764be081e52ca0449dfb32ce58e7be3fe`。
- 已读指定的父仓库 `.pm/selfheal/CONTROLLER-READY-AND-1106.md`、父仓库与 worktree 的 `CLAUDE.md` / `AGENTS.md`，并按 `.agents/skills/codexhost-pre-push-checks/SKILL.md` 选检查。按代码审查技能检查了本地 diff、入口调用与资源释放，没有第二审查会话。
- 收尾前发现同分支新增提交 `82eb6b798b29018bfda39fe9056f3e3f9c361590`，仅涉及 `apps/hub-desktop/www/pages/codex-updates.js` 和 `packages/host-runtime/test/rly0-codex-updates-ui.test.ts`。原样保留；本轮提交以它为父提交，不暂存或修改这两文件。不能把这笔既有界面提交算作本轮修复。
- 最终代码指纹见 [source-sha256.json](source-sha256.json)；逐次命令、cwd、退出码、耗时、隔离目录和输出摘要见 [checks.json](checks.json)。本轮本地提交 SHA 以包含此文件的提交为准。

## A. Controller 重复 ready / EPIPE

源码核对确认交接中的根因链：`begin()` 写入 `desktop:null`；原 `desktop()` 只改内存；Controller 首次按父 PID 读不到版本，策略回退 core；最终 Launcher ready 落盘后，轮询读到 full 并重建会话；原会话层再次写 ready，Launcher 的 stdout 读端此时已经关闭。Windows 堆栈来自指定交接文档，本轮没有在 Windows 重新复现。

| 修法 | 处理位置 | 实际行为与验证 |
| --- | --- | --- |
| 1. 每进程一次 ready | `packages/desktop-control/src/production-controller.ts:318` | 在进程入口建立 `readyPublished`，包装后交给所有会话，覆盖有/无策略读取、full/core/safe。core→full→safe→core 重建四次 attachment server，ready 仍只调用一次；模拟第二次调用会抛 EPIPE，整段运行仍正常结束。测试含初始 core 成功与 fetch 失败两种情况。 |
| 2. 默认输出容忍 EPIPE | `packages/desktop-control/src/production-controller.ts:130`、`:173` | 可注入 stdout writer，写前安装一次持久 `error` 监听，覆盖事件错误和同步 write 抛错，只忽略 EPIPE。EIO 和非法 readiness 继续报错。不会仅凭 writable 状态假定没有竞态。 |
| 3(a). 提前落盘版本 | `crates/launcher/src/startup_record.rs:134` | 记录 identity 后释放 mutex，再 `finish(Starting, None)`，避免重入锁；仍保留 best-effort 持久化。版本在启动 Controller 前可读，且仍是 starting、无结束时间。未选择替代方案 3(b)，未扩环境变量白名单。 |
| 3. 注释纠正 | `packages/desktop-control/src/codex-renderer-policy.ts:10` | 明确读取 `startup_record::desktop()` 发布的 starting 记录，并继续匹配真实父 PID。 |
| 4. 可选 stdout drain | 未实施 | 交接标为可选，本轮保留 bounded 单行握手。上述三项已处理重复输出、断管容错及初始版本缺失；没有另增长期读线程。 |
| 5. 回归 | `packages/desktop-control/test/production-controller.test.ts:24`、`:626`；`crates/launcher/src/startup_record.rs:283` | 5 项新增 TS 测试覆盖 EPIPE、非 EPIPE、一次 ready 和会话清理；Rust 新测试使用单独测试子进程与临时数据路径，实际读磁盘上的 starting 记录，不启动 Desktop。 |

EPIPE 的 TS 验证是 `Writable` 错误事件 / write 故障注入，不是 Windows 原生 pipe 验收。原有 Launcher 严格 JSON、长度限制和监督规则保留；相关 8 项 Rust controller 测试通过。

## B. 26.1106 草稿布局

| 位置 | 处理 |
| --- | --- |
| `packages/desktop-control/src/renderer-scoped-draft-model.ts:67` | 同时识别 24/25 位 Model 模块。25 位时 index 8 插槽之后统一 +1：10→11、12→13、13→14、14→15、20→21、21→22、23→24；index 7 仍严格为 null。14 位草稿模块与 draft 身份校验保留。 |
| `packages/desktop-control/src/renderer-scoped-draft-model.ts:98` | 同时保留 52/53/55 位协作模块。55 位 offset=3：42 model、43 effort、44 settings、47/52 同一 mode、54 返回结果；继续校验对象身份和 model/effort。 |
| `packages/desktop-control/src/codex-update-hold.ts:2` | 去掉会随构建变化的固定 webview 块号，不改变更新控制逻辑。 |
| `packages/desktop-control/test/renderer-scoped-creation-1106.test.ts:67` | 新增 synthetic 25/55 fixture，分别验证 25 位 Model、配旧 24 位 Model 的 55 位协作模块，以及完整 25/55 组合。组合验证外部 Agent 草稿设置、背景新建路由、恢复原设置且不调用默认 Model setter；逐位破坏身份/设置关系时拒绝绑定或拒绝协作 mode；拒绝未知长度和其他草稿。 |

旧 `renderer-scoped-creation.test.ts` 的 24/52/53 用例原样保留并通过。没有调用真实外部 Agent，也没有把 26.1106 加进已适配名单：`packages/shared-contracts/src/desktop-compatibility.ts`、`codex-compat.json` 与本轮工作区 HEAD 相比均无修改；nightly 状态未写入。已适配系列仍为 26.1029 / 26.1103。

## 先失败，再通过

红测之前仅将原 stdout.write 等价提取为可注入 writer，未加错误防护、ready once、版本落盘或新布局识别。

| 执行 | 退出码 | 结果 |
| --- | --- | --- |
| `red-vitest`：production-controller + 旧 scoped-creation + 新 1106 三文件 | 1，预期失败 | 7 failed / 52 passed。A：同步 EPIPE、error 事件、两种 core→full 的第二次 ready 导致运行拒绝；B：25 位返回 null、55 位 creationModes 为 undefined、25/55 组合无法绑定。 |
| `red-cargo`：`startup_record::tests` | 101，预期失败 | 5 passed / 1 failed。新测试磁盘上读到 `desktop: None`，期望 `Some(26.1106.51428 / 26605)`。 |
| `green-focused-vitest`：同三文件 | 0 | 59 passed / 0 failed / 0 skipped。 |
| `green-cargo`：同一 Rust 分组 | 0 | 6 passed / 0 failed / 0 ignored。 |
| `regression-vitest`：最终相邻回归十文件 | 0 | 145 passed / 0 failed / 0 skipped。包含上述三文件、策略、状态、草稿路由、预热、更新 hold 与 early hold。 |
| `cargo-controller` | 0 | 8 passed / 0 failed / 0 ignored；与前述 6 项 startup-record 测试不重叠。 |

首次改动文件 ESLint 检查发现新测试 mock 的 `_options` 未使用（exit 1），已改成带明确函数类型的 mock；`eslint-final` 与 `typecheck-final` 均 exit 0，没有残留此错误。

## 最终命令与检查

所有测试、构建和工具链检查均由临时 wrapper 为各自子进程设置独立目录，未修改当前执行会话的全局环境：`HOME=USERPROFILE=<run>/home`、`CODEX_HOME=<run>/codex`、`CODEXHOST_DATA_DIR=<run>/data`、`RLY0_MEMORY_DIR=<run>/memory`；另隔离 CLAUDE_CONFIG_DIR、APPDATA、LOCALAPPDATA、XDG 和 npm cache。固定 `RLY0_SKIP_LEGACY_IMPORT=1`、`RLY0_CODEX_UPDATE_CONTROL=0`。Rust 固定 `RUSTUP_HOME=/Volumes/RLY0Dev/Dev/Cache/rustup`、`CARGO_HOME=/Volumes/RLY0Dev/Dev/Cache/cargo`、`CARGO_NET_OFFLINE=true`，没有转到 `~`。

本机工具链：macOS 27.2 arm64；Node 24.22.2；npm 11.19.1；cargo / rustc 1.97.1。原始输出留在临时检查目录，不提交原始日志；文件哈希和关键摘要已保留在 checks.json。

| 命令 | 结果 |
| --- | --- |
| `npm run build:typescript` | exit 0；TS 与隔离源码树的 plugin 产物构建完成。 |
| `npm run build:renderer` | exit 0；只构建源码产物，没有安装或发布。 |
| `npm run typecheck` | 最终 exit 0；包含 tests/tsconfig.json；在保留新增父提交 `82eb6b79` 后又完成 `typecheck-integration-parent` 复验。 |
| 下方完整 Vitest 命令 | exit 0；10 文件，145 pass。 |
| `cargo test --locked --package codexhost-launcher --bin codexhost startup_record::tests` | exit 0；6 pass。 |
| `cargo test --locked --package codexhost-launcher --bin codexhost controller` | exit 0；8 pass。 |
| `cargo clippy --locked --package codexhost-launcher --all-targets -- -D warnings` | exit 0。该 crate 没有需要额外启用的测试 feature。 |
| `cargo fmt --package codexhost-launcher --check` | exit 0。 |
| `node tools/check-boundaries.mjs` | exit 0。 |
| 改动的六个 TS 文件：`node node_modules/eslint/bin/eslint.js ...` | 最终 exit 0；完整 argv 见 checks.json 的 `eslint-final`。 |
| 同六文件：`node node_modules/prettier/bin/prettier.cjs --check ...` | exit 0；完整 argv 见 `format-source-check`。 |
| `git diff --check` | exit 0；暂存前再次检查。 |

```sh
node node_modules/vitest/vitest.mjs run --config tests/vitest.config.js \
  packages/desktop-control/test/production-controller.test.ts \
  packages/desktop-control/test/codex-renderer-policy.test.ts \
  packages/desktop-control/test/controller-status.test.ts \
  packages/desktop-control/test/renderer-scoped-creation.test.ts \
  packages/desktop-control/test/renderer-scoped-creation-1106.test.ts \
  packages/desktop-control/test/renderer-scoped-creation-routing.test.ts \
  packages/desktop-control/test/renderer-draft-prewarm-policy.test.ts \
  packages/desktop-control/test/renderer-prewarm-cleanup.test.ts \
  packages/desktop-control/test/codex-update-hold.test.ts \
  packages/desktop-control/test/early-update-hold.test.ts
```

按技能选择聚焦检查，没有运行全仓 `npm run check`、全仓 lint / Rust workspace 测试、live gate 或真机探针，也没有以这些未运行项声称全仓或发布验收通过。

## 未完成与现场边界

1. Windows 0.11.40-rc.3 原复现环境：核对修复产物的首次策略直接命中、core→full 切换与初始 core fetch 失败、附件服务恢复、没有第二条 ready / EPIPE / Controller exit 1，也没有 Launcher 连带关闭 Desktop。Mac 原生启动和断管行为亦待独立确认。
2. Codex 26.1106.51428 build 26605：在独立真机验证新草稿选择外部 Agent、首次发送、后台新建、不同草稿隔离、切回官方、已有对话和恢复。synthetic 元组与路由测试不能代替实际 applyAgent / Agent 执行验收。
3. 版本落盘是 best effort；磁盘拒绝写入等情况仍可能先降级 core，但 once + EPIPE 防护不依赖这次落盘成功。可选 stdout drain 未做。非 EPIPE 错误仍如实失败。
4. 独立审查未做；26.1106 其他关键路径未完整验收。等待 Claude 真机确认后再单独决定加入适配名单；打包、发布和更新清单仍归 Claude。

没有写真实 defaults、改已安装 App、退出/重启用户 Codex 或 Hub、另起 hub-service、推送或发布。只读复核时，原 Hub、Launcher、Desktop 和 Controller 的 PID 仍为 55618/55640、57667、57669、57670。`.pm/PROGRESS.md`、`.pm/PROGRESS_CODEX.md`、BOARD 与 `老板看这里.md` 同步本轮自检结果。
