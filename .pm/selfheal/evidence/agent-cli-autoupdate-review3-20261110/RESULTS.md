# HUB-AGENT-CLI-AUTOUPDATE 第三次复查修复证据

2026-11-10，分支 `feat/agent-cli-autoupdate`，输入 HEAD `bc3fd9a1a2ee46484b6fed843adef14a2e9bf28f`（包含 Claude 界面提交）。本轮状态为 **implemented / self_verified**；修复后的独立复核、reviewed、accepted 与真机验收尚未完成。最终本地提交号由交付回复给出，避免提交自引用。

cwd：`/Volumes/RLY0Dev/Dev/Projects/codex插件助手/.runtime/agent-cli-autoupdate`。先读指定报告，副本为 [REVIEW-3.md](REVIEW-3.md)，原路径、SHA-256、工具链与边界见 [input.json](input.json)。源码/测试/编译产物 SHA-256 见 [source-sha256.json](source-sha256.json)。没有修改 `apps/hub-desktop/www`；界面与发布仍归 Claude。

## 必修项

下表路径相对 worktree。命令、网络、Host、账号与进程表数据均为 **synthetic**，不是真实 CLI/账号验收。

| 项目 | 修法与实现文件:行号 | 回归测试与结果 |
| --- | --- | --- |
| N1 阻断：回退后 CHECK_TIMEOUT/HOST_UNAVAILABLE 进入分钟重装循环 | `packages/host-runtime/src/rly0-hub-service/agent-cli-updates.ts:256`，完成回退、日志已清且 causeCode 非空的结果不进分钟重试。仍有恢复日志的等待可以继续恢复，不试装新版。每日/手动检查与确定坏版本的拉黑保持 | `packages/host-runtime/test/agent-cli-updates.test.ts:837` 起，5 种情况：新旧版首次检查超时、旧版 Host 丢失/超时、真实坏版本、只新版检查超时而原版 ready。连续四次分钟 tick 安装均仅前进/回退各一次、围栏已释放；临时故障每日/手动仍可试。compiled probe 的两种回退异常场景均为 `[2,2,2,2,2]`，每日变 4、手动变 6 |
| N2 外部占用时反复关空闲会话 | `packages/host-runtime/src/rly0-hub-service/agent-cli-update-driver.ts:413`，先对所有 Host 只读 busy，再扫外部占用，全部空闲才释放，释放后不排除任何进程再扫；`:437` 按助手/原可执行文件/目标版本每 15 分钟最多尝试释放一次。`packages/host-runtime/src/rly0-hub-service/agent-cli-update-system.ts:100` 只排除空闲 Host 下属于当前 CLI 的进程分支，其他助手工具派生的同名 CLI 仍计外部占用 | `agent-cli-update-driver.test.ts:173` 顺序及扫描范围；`:189` 6 轮外部占用 0 释放；`:206` 另一 Host 忙/失联不关本 Host；`:226` 失败/成功计入限频、到期和不同目标；`:253` 释放期间出现新外部进程仍忙。`agent-cli-update-system.test.ts:144` Mac/Windows 假进程表验证 CLI 分支/其他助手分支/外部终端。compiled probe 16 助手×6 轮：96 次只读扫描、0 释放、0 安装 |
| N3 只读子代理残留永远阻止更新 | `packages/host-runtime/src/external-thread-idle-release.ts:203`、`:236` 与 `packages/host-runtime/src/app-server-host.ts:1995`，忙碌和最终残留判定忽略只读子代理，仍保护父会话实际后台/子任务。`:191` 显式保留真实预热会话，即使已有 native identity；有不可释放会话先返回 busy，避免顺手关父会话 | `external-thread-idle-release.test.ts:93` 只读子代理即使快照状态 running 也不占 CLI；`:120` 无身份/有身份的真实预热均阻塞且不关父会话。`agent-cli-update-host.test.ts:59` 真实走 Runtime 的 ReadonlySnapshotSession 恢复与 Host RPC；`:111` 预热忙。compiled probe 原生 open 仅 1 次、父会话释放后 child 保留、released=true；真实预热仍 busy |

## 次要项

| 项目 | 实现与验证 |
| --- | --- |
| 释放失败不应永久锁到重启 | `packages/host-runtime/src/external-thread-runtime.ts:255` 将更新释放接到既有 lifecycle.release；`external-thread-idle-release.ts:300` 不写永久 closeFailed，改标记 sessionUnavailable。未完成 close Promise 及旧 owner 保留；下一次用户使用先重试关闭与排空输出，确认后按原身份恢复，绝不提前开第二个 writer。`external-thread-idle-release.test.ts:149` 覆盖 reject/60 秒 timeout；超时期间不并发 close、不 open，晚到关闭后可以恢复，无需 Desktop 重启。普通自动空闲释放的原有失败保护及其断言保留 |
| INSTALL_FILE_BUSY 预检等待类结果 | `agent-cli-updates.ts:403` 返回 skipped-busy / INSTALL_FILE_BUSY，分钟重查预检；`agent-cli-updates.test.ts:901` 确认可写前 0 次释放/安装，恢复后下一分钟更新。真正安装中的同码仍按事务读回/恢复，不转成分钟重装 |
| 更新时 AI 助手页可读状态 | `app-server-host.ts:1600` 写 unavailable / AGENT_CLI_UPDATE_BUSY / 中文 message，`packages/host-runtime/src/rly0-hub-service/agent-connection-hint.ts:14` 给“正在更新”hint。`agent-cli-update-host.test.ts:132` 通过隔离文件通道取真实结构的报告并断言 adapter.inspect 没有被调用；`agent-connection-hint.test.ts:36` 验证等待提示。只改后台报告/提示，不改界面 |
| 协调锁抢占退避 | `agent-cli-updates.ts:290` 使用 250ms 起、指数增长到 10 秒基值加最多 20% 抖动，stop 用 AbortSignal 立即中断等待，队列不丢。`agent-cli-updates.test.ts:929` 持锁等待期间测探针次数，旧 100ms 循环超过上限；保留现有双 Hub 排队后执行的断言 |

## 编译产物状态机

按复查者 loop/scen/idle 方法，执行 [compiled-state-machine.mjs](compiled-state-machine.mjs)，直接 import `packages/*/dist`，实际 npm/系统命令和 HTTP 均为注入假驱动；出现意外系统/npm/HTTP 调用会抛错。

| 场景 | 重建前留存的 dist | 本轮源码重新编译后 |
| --- | --- | --- |
| N1 原版检查超时 | 四次分钟触发安装数 2→4→6→8→10 | 2→2→2→2→2；每日 4、手动 6 |
| N1 原版 Host 暂不在线 | 同样 2→4→6→8→10 | 同样保持 2；每日/手动可再试 |
| N2 外部一直占用，16 助手、6 轮 | 释放 96 次 | 扫描 96 次，释放 0，安装 0 |
| N3 父会话+恢复的只读子代理 | 父已关而 child 残留，released=false | child 保留，released=true；真实预热仍阻塞 |

[baseline-compiled.json](baseline-compiled.json) exit 1 为预期复现失败（4 个场景）；旧产物是重建前留存的 dist，本轮没有声称另做了 bc3fd9a1 的干净重建。[final-compiled.json](final-compiled.json) exit 0，4 场景全过，来自本轮 `npm run build:typescript` 的编译产物。

## 契约变化

[CONTRACT v4](../../AGENT-CLI-AUTOUPDATE-CONTRACT.md) 新增内部 busy/release 的可选 `hostPid: number` 正整数；旧 Host 缺该字段不推断归属、保守算进程占用。连接报告明确 code `AGENT_CLI_UPDATE_BUSY`，仍用现有 unavailable/message/hint；管理 RPC 请求、entry 字段及更新 Result/ErrorCode 枚举未新增。

写明回退完成后的分钟重试边界、只读预检/释放后复查、同目标在当前驱动实例内 15 分钟释放限频、失败关闭重试、协调锁退避。v3 第 148 行已按要求改为“除 ROLLBACK_FAILED、COMMAND_TREE_STOP_FAILED、STATE_WRITE_FAILED 外”优先显示 recoveryPending；保留 Claude `bc3fd9a1` 的相应界面修复。Claude 只需核对 v4 的等待状态接线，不由 Codex 代做视觉或发布。

## 检查命令与结果

按 `.agents/skills/codexhost-pre-push-checks/SKILL.md` 选择跨包编译、受影响的 16 文件、类型（含测试）、依赖边界、lint 和改动文件格式；未跑无关全量、Rust、Renderer 构建、原生进程/真实 CLI Gate 或打包发布。下列均在上述 cwd，通过 `node .pm/selfheal/evidence/agent-cli-autoupdate-review3-20261110/run-check.mjs <name> <command...>` 包裹。

| 检查 | 命令 | 结果与证据 |
| --- | --- | --- |
| TypeScript/插件编译 | `npm run build:typescript` | [final-build.json](final-build.json)，exit 0；无正式打包 |
| 聚焦回归 | 下方完整命令 | [final-tests.json](final-tests.json)，exit 0；16 文件、244 pass、0 fail、0 skip |
| 编译产物状态机 | `node .pm/selfheal/evidence/agent-cli-autoupdate-review3-20261110/compiled-state-machine.mjs` | [final-compiled.json](final-compiled.json)，exit 0；4 场景 |
| 类型含测试 | `npm run typecheck` | [final-typecheck.json](final-typecheck.json)，exit 0 |
| 依赖边界 | `node tools/check-boundaries.mjs` | [final-boundaries.json](final-boundaries.json)，exit 0 |
| 全仓 lint | `npm run lint` | [final-lint.json](final-lint.json)，exit 1；仅输入已有的 rly0-hub-promo.test.ts:11:20，未标通过 |
| 改动源文件 lint | `node node_modules/eslint/bin/eslint.js <14 个改动 TS 文件>` | [final-changed-lint.json](final-changed-lint.json)，exit 0；完整参数在 JSON |
| 改动源文件/新增脚本/JSON 格式 | `node node_modules/prettier/bin/prettier.cjs --check <改动 TS 和新增文件>` | [final-format.json](final-format.json)，exit 0；完整参数在 JSON |
| diff/UI/证据完整性 | `node .pm/selfheal/evidence/agent-cli-autoupdate-review3-20261110/verify-delivery.mjs`（diff/UI/文件 SHA-256/证据链接） | [final-integrity.json](final-integrity.json)，exit 0 |

完整聚焦回归命令（实际命令数组见 final-tests.json）：

```sh
node node_modules/vitest/vitest.mjs run --config tests/vitest.config.js packages/host-runtime/test/agent-cli-updates.test.ts packages/host-runtime/test/agent-cli-update-driver.test.ts packages/host-runtime/test/agent-cli-update-system.test.ts packages/host-runtime/test/agent-cli-update-host.test.ts packages/host-runtime/test/external-thread-idle-release.test.ts packages/host-runtime/test/agent-connection-hint.test.ts packages/host-runtime/test/agent-cli-update-rpc.test.ts packages/host-runtime/test/external-thread-recovery.test.ts packages/host-runtime/test/external-subagent-threads.test.ts packages/host-runtime/test/external-thread-runtime.test.ts packages/host-runtime/test/app-server-host.prewarm.test.ts packages/host-runtime/test/app-server-host.prewarm-route.test.ts packages/host-runtime/test/rly0-backend-reload-channel.test.ts packages/host-runtime/test/harness-installation-tasks.test.ts packages/host-runtime/test/app-server-host.installation.test.ts packages/host-runtime/test/rly0-agent-cli-updates-ui.test.ts
```

[preexisting-lint.json](preexisting-lint.json) 记录输入 bc3fd9a1 和当前 rly0-hub-promo.test.ts 的相同哈希与原始行，确认该全仓 lint 错误未由本轮引入。`focused-tests.json`、`typecheck.json`、`initial-lint.json` 保留了已修正的测试夹具/类型/新增 lint 问题；只有 final-* 是最终结果，不把中间失败标通过。仓库 `.prettierignore` 排除了 Markdown；格式 pass 的范围是列出的 TypeScript、脚本与 JSON，RESULTS 链接另由 verify-delivery 核实。

隔离包装器设置临时 HOME、USERPROFILE、CODEX_HOME、CODEXHOST_DATA_DIR、RLY0_MEMORY_DIR、CLAUDE_CONFIG_DIR、APPDATA/LOCALAPPDATA、XDG 目录和 npm prefix/cache/userconfig，`RLY0_SKIP_LEGACY_IMPORT=1`、`RLY0_CODEX_UPDATE_CONTROL=0`，结束后清理。被测 npm、系统命令、占用表、HTTP、账号和原生 CLI 全部注入；开发用 npm build/typecheck/lint 命令自身正常执行。Host 为进程内内存流夹具，service.handle 只在进程内调用，没有启动 hub-service listener。测试没有启动真实原生 CLI、shell/sleep 或需要杀掉的测试进程；无名称匹配杀进程行为。

## 未完成与真机边界

- 修复后独立审查、reviewed/accepted 未完成；输入复查报告不等于修复后已再次独立通过。本轮为主会话自检。
- 真实 Mac/Windows 原 prefix 安装、回退及 ready、registry/代理/网络故障、Windows ACL/EPERM 文件锁与真实连接报告/UI 联调未验收。未对真实全局 npm prefix install/uninstall。
- 原生会话 close 失败/超时后重试确认、输出排空、历史/身份保留及按需 resume，父会话真实后台/子任务/审批保护，子代理/预热视图和进程分支归属，仍需获准独立真机环境确认。无法证明 CLI 根进程归属时保守等待；旧 Host 没 hostPid 时不擅自释放。
- 同目标释放限频存在当前驱动实例内，Hub 重启会重建；系统时间回拨可能延长等待。外部进程不受 Hub 原子围栏控制，最后扫描后的启动竞争仍存在；本轮不扩张为进程拦截或终止。
- 既有原生工具精确回退入口缺口、第三方主动脱离进程组、首次/到期 OS owner 探针同步时长和 npm postinstall 在 prefix 外的副作用边界保留，不用 synthetic 测试宣称全部解决。
- 界面、版本号、打包和发布归 Claude。没有退出/重启用户 Codex/Hub，没有推送、发布或正式安装包。
