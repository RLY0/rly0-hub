# HUB-AGENT-CLI-AUTOUPDATE 第二次复查修复证据

2026-11-10；分支 `feat/agent-cli-autoupdate`；输入 HEAD `62f2bdcc1e1fbf1eba0b2ed68f14742e5ee2628a`。状态为 **implemented / self_verified**；本轮修复后的独立复核、accepted 与真实助手验收尚未完成。最终本地提交号由交付回复提供，避免自引用；当前源码见 [source-sha256.json](source-sha256.json)。

cwd：`/Volumes/RLY0Dev/Dev/Projects/codex插件助手/.runtime/agent-cli-autoupdate`。用户指定的报告已先读，原样副本为 [REVIEW-2.md](REVIEW-2.md)，来源路径、SHA-256 和工具链为 [input.json](input.json)。本轮只改后台、测试、契约、功能说明与进度记录，保留 Claude 的界面提交。

## 必修项逐条处理

路径均相对本 worktree；每项列出实现及会在回归时失败的断言。所有 npm、账号和协议数据均为 **synthetic**，采用真实命令、状态和错误结构，不表示复现了真实账号/真实安装现场。

| 复查项 | 修法与实现文件:行号 | 测试与证据 |
| --- | --- | --- |
| 阻断 1：安装超时每分钟重装 | `packages/host-runtime/src/rly0-hub-service/agent-cli-updates.ts:62` 安装阶段的原生超时映射 INSTALL_TIMEOUT，查询/读回/连接超时仍为 CHECK_TIMEOUT。分钟重试不包含 INSTALL_TIMEOUT；不变版本只清日志并释放围栏，待每日或手动重试 | `packages/host-runtime/test/agent-cli-updates.test.ts:695` 覆盖真实 `Harness command timed out`、COMMAND_TIMEOUT、DOMException TimeoutError 三种形态；连续 3 次分钟 tick 安装仍仅 1 次、围栏可用、坏版本为空，24 小时才第 2 次安装。原代码的第一种场景在第 1 分钟已重装，见 baseline-regressions.json |
| 重要 1：Host 自持空闲进程使助手一直忙 | `agent-cli-updates.ts:408` 拿到围栏后调用释放；`packages/host-runtime/src/rly0-hub-service/agent-cli-update-driver.ts:407` 先请求所有 Host 释放该助手空闲会话，再扫描外部进程。`packages/host-runtime/src/app-server-host.ts:1989` 验证围栏，`:2009` 交给会话生命周期；`packages/host-runtime/src/external-thread-idle-release.ts:178` 保留全部运行/后台/审批/操作/持久化/身份检查，`:201` 在原队列内再次核验，close 和输出完成后才移除。只绕过空闲回收的开关/时间，不取消工作，线程/原生身份保留供下次按需 resume | `agent-cli-update-host.test.ts:55` 默认空闲回收关闭仍释放、缺围栏拒绝；`:93` 活动回合/后台工作不关闭、其他助手不受影响。`agent-cli-update-driver.test.ts:157` 先释放再扫外部进程，Host 忙则不扫描/安装；`external-thread-idle-release.test.ts:93` 释放后不主动重开、下次恢复同一身份；`:110` 运行、activeTurn、后台、持久化、进行中操作、close 失败均保留会话 |
| 重要 2：新旧版都不 ready 仍拉黑新版 | `agent-cli-updates.ts:511` 回退后必须重新取得旧版 ready，异常不默认成功；`:520` 旧版也非 ready/异常/超时则撤销该目标的 quarantine，其他坏版本保留。`:342` 已是原版的恢复路径也复核无效拉黑；不留下反复回装原版的日志 | `agent-cli-updates.test.ts:739` 旧版非 ready、HOST_UNAVAILABLE、COMMAND_TIMEOUT 都撤销拉黑，重启后环境恢复可以更新同一目标。`:767` 老日志没有 quarantine 时撤销无证据的目标拉黑并保留其他版本；原有新版失败/旧版 ready 的持久拉黑与回退失败保留日志用例继续通过。baseline-regressions.json 的 4 个对应场景在原代码失败 |
| 重要 3：时区导致误删活锁 | `packages/host-runtime/src/rly0-agents/cli-update-owner.ts:45` ps 固定 TZ=UTC、LC_ALL=C；本进程缓存和跨进程核验均用同一格式。新增可注入探针，未查到启动身份但进程仍存活时继续保守等待 | `packages/host-runtime/test/cli-update-owner.test.ts:30` 三个调用时区都明确向 OS 驱动传 UTC/C；`:89` 自己启动一个无害 sleep，以真实 ps 读它的启动身份，UTC/上海/纽约分别探测的 owner 锁均保持存活；结束后清理子进程 |
| 重要 4：POSIX 杀树漏掉重挂父进程的孙进程 | 命令生命周期迁到 `packages/harness-discovery/src/installation-command.ts:43`，使用 spawn(detached=true) 创建自有进程组（execFile 不转发 detached）；`:100` kill(-pgid) 终止整组，`:105` 组信号失败仍尝试直接子进程，非 ESRCH 仍报 COMMAND_TREE_STOP_FAILED 阻止并发回退；`:112` 等待 native close。`installation.ts` 保留公共 re-export | `packages/harness-discovery/test/installation-command-driver.test.ts:218` 只向自有负 pgid 发信号且不调用 ps；`:235` 组失败仍杀直接子进程并保留失败。`installation-process-group.test.ts:10` 分别在 timeout/abort 下启动固定无害 shell/sleep，使孙进程脱离父子链；确认后代终止/僵尸态、输出管道关闭，旁边独立 sibling 仍存活，最后全部清理。没有扫描或杀用户进程 |

上表省略目录的状态机文件和测试分别在 `packages/host-runtime/src/rly0-hub-service/` 与 `packages/host-runtime/test/`。修改旧断言均对应用户本次确定的契约：安装前版本变动改报 PRE_UPDATE_VERSION_MISMATCH；旧版也不 ready 不再保留目标拉黑；未判坏且 ready 的中断目标版保留。原有保护断言和失败用例未删除、未加 skip。

## 次要项与界面交接

| 复查项 | 本轮处理、文件:行号与验证 |
| --- | --- |
| 另一个 Hub 检查时丢手动请求、结束窗口排队 | `agent-cli-updates.ts:280` 调用者等待 drain 后再次检查队列，`:282` coordinator 被占用时保留队列、短间隔等待，停服退出。`agent-cli-updates.test.ts:664` 第二个实例的手动请求等第一个完成后执行；原 `:507` cached 检查期间“检查全部”的回归继续通过 |
| 每次准入都同步 ps/PowerShell | `cli-update-owner.ts:98` 仅对已经核实匹配的 owner 缓存最多 1 秒；每次仍 signal(0)，缓存不因命中续期，新 owner/新启动身份必须重新查。`cli-update-owner.test.ts:50` 检查命中次数、到期重查、PID 复用的新 owner 和死亡立即失效。首次/到期仍是同步探针、上限 3 秒，此项是缓存缓解，未改为全异步 |
| 普通 inspect 在安装中拉起 CLI | `packages/host-runtime/src/rly0-agents/cli-update-admission.ts:132` 普通 inspect 与 installation(check) 纳入准入围栏；`app-server-host.ts:1993` 和 `agent-cli-update-driver.ts:428` 给更新器使用要求有效围栏的内部刷新检查，底层仍为原 adapter.inspect。`agent-cli-update-host.test.ts:55` 断言普通检查拒绝且未调用 adapter，而内部检查可返回真实结构的 ready；原版本/安装任务回归通过 |
| Windows W_OK / EPERM 混为权限错误 | `agent-cli-update-system.ts:31` 与 `installation-command.ts:9` 将 Windows EPERM 单独脱敏为 COMMAND_FILE_IN_USE，驱动 `:229` 映射 INSTALL_FILE_BUSY；明确 W_OK 不能证明 Windows ACL。`agent-cli-update-system.test.ts:43`、`agent-cli-update-driver.test.ts:144`、`installation-command-driver.test.ts:266` 覆盖 EPERM 预检/rename；EACCES numeric 243/1 仍报权限码。未声称实际 Windows 文件占用/ACL 已验证 |
| taskkill 遇到刚退出的进程 | `installation-command.ts:94` taskkill 失败后确认 native close，确认正常退出竞争时不误报 COMMAND_TREE_STOP_FAILED；不能确认则仍阻止并发回退。`installation-command-driver.test.ts:253` 模拟真实 process not found，原等待 taskkill/close 和终止失败用例继续通过 |
| 中断目标版未判坏却立即降级 | `agent-cli-updates.ts:356` 当前是目标、没有 quarantine/已知拉黑且刷新 ready 时保留该版、清日志、返回 recovered，即使自动更新开关已关。`agent-cli-updates.test.ts:634` 断言未 install、当前目标保留；`:456` 非 ready 仍回退的用例保留 |
| 旧日志无 quarantine 仍保留无证据拉黑 | `agent-cli-updates.ts:520` 无 quarantine 的旧日志在回退分支移除目标拉黑；`agent-cli-updates.test.ts:767` 保留其他坏版本，`:432` 原版/第三版恢复回归也通过 |
| ALL_PROXY 清空的有意取舍 | 不引入代理清空；契约 v3 写明 Hub 的“直连”仍继承既有 ALL_PROXY/.npmrc/环境代理。`agent-cli-update-system.test.ts:117` 新增 ALL_PROXY 保留断言；原 npm proxy 保留和显式代理用例继续通过 |

[契约 v3](../../AGENT-CLI-AUTOUPDATE-CONTRACT.md) 新增状态字段 **previousVersion、recoveryPending**（读取旧文件默认 null/false）；错误码 **INSTALL_TIMEOUT、INSTALL_FILE_BUSY、PRE_UPDATE_VERSION_MISMATCH**；内部 Host 方法 **cli-update-release-idle、cli-update-inspect**，均要求有效围栏。管理 RPC 请求和 Result 枚举不变。

Claude 需按 v3 区分安装超时与检查超时、恢复待执行与有新版、安装前版本变动与安装后不一致；currentVersion 已等于 previousVersion 且没有 recoveryPending 时，回退后 CHECK_TIMEOUT 也显示原版已恢复并等待检查。recovered 还可表示保留 ready 的目标版，不能统一写“旧版已恢复”。本轮没有修改 `apps/hub-desktop/www`，没有代做或验收新文案。

## 执行命令与结果

按 `.agents/skills/codexhost-pre-push-checks/SKILL.md` 选择跨包构建、受影响聚焦测试、类型、依赖边界、lint 和改动源文件格式；未运行无关全量/Rust/Renderer/打包/发布检查。以下命令都在上述 cwd 经 [run-check.mjs](run-check.mjs) 包裹，实际参数数组、退出码、耗时和脱敏输出分别保存在同名 JSON。

| 检查 | 命令 | 最终结果 |
| --- | --- | --- |
| 跨包编译 | `npm run build:typescript` | final-build.json，exit 0；仅 TypeScript/插件构建，无正式打包 |
| 聚焦回归 | 下方完整命令 | final-tests.json，exit 0；**16 文件、233 pass、0 fail、0 skip** |
| 类型含测试 | `npm run typecheck` | final-typecheck.json，exit 0 |
| 依赖边界 | `node tools/check-boundaries.mjs` | final-boundaries.json，exit 0 |
| 全仓 lint | `npm run lint` | final-lint.json，exit 1；仅输入 HEAD 原有 `packages/host-runtime/test/rly0-hub-promo.test.ts:11:20` 的 no-non-null-assertion，与 baseline-lint.json 相同，本轮新增错误 0。全仓 lint 不标 pass |
| 改动源文件格式 | `node node_modules/prettier/bin/prettier.cjs --check <22 文件中全部 TypeScript>` | final-format.json，exit 0 |
| diff/UI/源码指纹 | `git diff --check`、`git diff --exit-code 62f2bdcc -- apps/hub-desktop/www`、SHA-256 逐文件比对 | final-integrity.json；退出码和比对结果以该记录为准 |

```sh
node .pm/selfheal/evidence/agent-cli-autoupdate-review2-20261110/run-check.mjs final-tests \
  node node_modules/vitest/vitest.mjs run --config tests/vitest.config.js \
  packages/host-runtime/test/agent-cli-updates.test.ts \
  packages/host-runtime/test/agent-cli-update-driver.test.ts \
  packages/host-runtime/test/agent-cli-update-system.test.ts \
  packages/host-runtime/test/agent-cli-update-host.test.ts \
  packages/host-runtime/test/agent-cli-update-rpc.test.ts \
  packages/harness-discovery/test/installation-command-driver.test.ts \
  packages/harness-discovery/test/installation.test.ts \
  packages/harness-discovery/test/npm-installation.test.ts \
  packages/host-runtime/test/grok-add-login.test.ts \
  packages/host-runtime/test/rly0-agent-installer.test.ts \
  packages/host-runtime/test/app-server-host.installation.test.ts \
  packages/host-runtime/test/harness-installation-tasks.test.ts \
  packages/host-runtime/test/rly0-agent-cli-updates-ui.test.ts \
  packages/host-runtime/test/external-thread-idle-release.test.ts \
  packages/host-runtime/test/cli-update-owner.test.ts \
  packages/harness-discovery/test/installation-process-group.test.ts
```

隔离项：临时 HOME、USERPROFILE、CODEX_HOME、CODEXHOST_DATA_DIR、RLY0_MEMORY_DIR、CLAUDE_CONFIG_DIR、APPDATA、LOCALAPPDATA、XDG 目录、npm prefix/cache/userconfig；RLY0_SKIP_LEGACY_IMPORT=1、RLY0_CODEX_UPDATE_CONTROL=0。包装器退出后移除临时目录。npm run 构建/验证命令本身真实执行；被测 npm、CLI、网络、Host、Windows 系统命令全部注入。POSIX OS 测试只通过受限驱动启动并清理自己的固定 shell/sleep，读取它们的 ps 身份/状态。Host fixture 使用内存流及 synthetic 适配器，管理 RPC 只在进程内调用 service.handle，没有另起 hub-service 或监听生产端口。

修复前新增 5 个场景全部按预期失败（baseline-regressions.json，另外 38 个用例被 `-t` 筛出未运行，不能算通过）；确认分钟重装与 4 个误拉黑分支。迭代记录包含已纠正的 fixture 参数/类型及 lint 问题；仅上表 final-* 是最终结果，没有将中间失败标成 pass。

## 仍需独立真机确认

- 本轮为主会话自检，没有修复后的第二审查会话，不声称 reviewed/accepted。输入独立报告不等于修复后已经再次独立通过。
- 真实 Mac/Windows 的 opencode serve/ACP 等空闲会话 close、保留历史/身份后按需重开，以及运行回合、后台任务、工具审批绝不被释放，需获准隔离真机验证。synthetic 适配器不能代替原生助手生命周期证明。
- 真实原 prefix npm/官方 updater 升级、回退、登录和连接 ready、网络/registry/代理故障、Windows ACL、EPERM 文件锁、taskkill 时序、硬链接/锁竞争及停服时长均未验收。本轮未对任何真实全局 npm prefix install/uninstall，没有退出/重启日常 Codex/Hub。
- POSIX 自有进程组可覆盖保持在组内的重挂父进程后代；不能声称覆盖主动 setsid/脱离组的任意第三方守护程序。外部终端不受 Host 准入锁控制，最后一次扫描后新启动的竞争仍需平台验收；无法确认终止时继续保留失败日志并拒绝并发回退。
- owner 缓存缓解同步探针阻塞，首次/到期仍可能等待 OS 最多 3 秒；Host 空闲 close 仍受原有 60 秒关闭上限保护，不能宣传瞬时完成。
- 原生工具缺少可靠精确版本回退入口时仍只检测；安装目录型 launch setting 不能统一解析时仍拒绝改另一份 CLI。npm postinstall 的 prefix 外部副作用不等于可由重装旧包完整撤销。
- 界面/文案接线及体验验收、版本号、打包、发布仍归 Claude；本轮无推送、发布或正式安装包。
