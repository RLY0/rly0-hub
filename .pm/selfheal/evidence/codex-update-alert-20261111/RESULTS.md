# HUB-CODEX-UPDATE-ALERT：本地修复结果

状态：implemented / self_verified；未 reviewed / accepted，未发布。任务于 2026-11-11 开始，最终检查跨至 2026-11-12。目录日期按用户指定保留。

- cwd：`/Volumes/RLY0Dev/Dev/Projects/codex插件助手/.runtime/agent-cli-autoupdate`
- 分支：`feat/agent-cli-autoupdate`；输入 HEAD：`5d07cdaf`，初始工作树干净。
- 本文件与修复一起本地提交，提交号以 `git log -1` / 最终交付回复为准。输入完整 OID、命令退出码、工具版本和最终源码 SHA-256 见 [checks.json](checks.json)。未推送或发布。

## 研究结论与位置

本机 `/Applications/ChatGPT.app` 的 bundle id 为 `com.openai.codex`，Codex `26.1103.60933` / build `25894`；内置 `Sparkle.framework/Resources/Info.plist` 为 Sparkle `2.9.1` / build `2054`。

普通跳过键是 **`SUSkippedVersion`，NSString，内容为 appcast `sparkle:version` 的 build 号**。不能写展示用的 `sparkle:shortVersionString`。Sparkle arm64 `SPUSkippedUpdate skipUpdate:host:`（`0x17a68`）在 `0x17aa4` 取 `versionString`，`0x17b14–0x17b28` 写该键；候选过滤 `0x14844–0x14884` 比较 skip >= candidate build 时跳过，因此一个最大 build 阈值可覆盖该 build 及以下版本。

`SUSkippedMajorVersion` / `SUSkippedMajorSubreleaseVersion` 属于另一种跳过语义，Hub 不改；`sparkle.node` 的 `CodexSparkleSeenUpdateVersions` 是用户已关注提醒数组，不是候选跳过值，也不改。ASAR 研究确认旧 feed 存在 JS 定时后台检查入口，故不采用只关闭 `SUEnableAutomaticChecks`，也不改首条 `disableInAppUpdates` latch。

详见 [RESEARCH.md](RESEARCH.md)，包含 ASAR 文件和字符偏移、native/framework 方法地址、命令及三个输入文件的 SHA-256。19,886 个 packed 文件仅提取到临时目录研究，目录已删除；研究后这三个输入对象的哈希与研究前一致，见 [app-read-only.json](app-read-only.json)。未执行 addon，未改 App 包。

指定 B1 诊断只读结果仍是 `source=fallback, lateInstall=false, observed=3, sent=3, installedAt=142, firstGateAt=2215, holdBeforePageScripts=false`。当前判定源码 `packages/desktop-control/src/early-update-hold.ts:332` 要求 source=early，因此 false 符合现有定义；早于首次“观测到”的 gate 不证明此前未漏消息。本轮没有改诊断或 renderer。

## 实现位置

以下行号以本次提交源码为准；未改 UI、Rust Launcher、共享 RPC 或发布文件。

| 位置 | 实际变化 |
| --- | --- |
| `packages/host-runtime/src/rly0-hub-service/codex-sparkle.ts:23` | 保留 feed 展示版本/build 映射，兼容元素和 enclosure 属性形态；`:296` 选择未适配候选的最大 build，拒绝缺失 build，不猜展示版本。 |
| `packages/host-runtime/src/rly0-hub-service/codex-skipped-version.ts:83` | 新增独立小模块：原子保存原值和 Hub 写值、写前复读、成功读回、跨 feed 更新归属；相同/更高用户跳过值不认领、不降低。`:106` 仅比较恢复自己的写值，用户新值或删除保留。 |
| `packages/host-runtime/src/rly0-hub-service/codex-update-manager.ts:222` | arm 之前撤销自己的跳过值，失败不建租约、不释放 renderer hold、不允许下载或 quit。`:497` 关闭管理先停止续租和临时放行，再恢复 skip/检查偏好/原自动下载值；失败保留 enabled。`:561` / `:597` 长等空闲与退避仍刷新压窗。 |
| `packages/host-runtime/src/rly0-hub-service/codex-check-preferences.ts:6` | 驱动与 watchdog 共用注入命令封装；布尔写 `-bool`、检查日期写 `-date`、跳过 build 写 `-string`；恢复仍识别 macOS 27 缺键文本。`:48` 读取 skip 时核对字符串类型。 |
| `packages/host-runtime/src/rly0-hub-service/codex-update-watchdog.ts:19` | 同一真实恢复函数可注入系统命令；仅关回自动下载、恢复检查辅助键，不重放 skip 快照，不删新 owner 或用户的跳过值。 |
| `packages/host-runtime/test/codex-update-alert.test.ts:1` | 27 项新增回归，使用真实 manager + Mac driver + 状态文件、synthetic appcast、macOS defaults/进程命令响应；不以模拟 manager 替代接线。旧 version-gate fixture 也显式关闭原生控制。 |
| `.pm/selfheal/CODEX-VERSION-GATE-CONTRACT.md:273`；`docs/features/codex-version-gate.md:5` | 新增机制、归属/恢复、崩溃/watchdog、退避刷新与真实验收边界。 |

持久记录为 `<dataDir>/codex-update-skipped-version.json`，独立于用户开关和 release lease。替换过程中同时记住先前 Hub 写值和待写值，处理成功响应丢失/进程中断；管理开启时停服保留它。放行成功前必须清理完成，lease 不带旧 skip 快照。关闭管理无需先成功拉取 feed；坏记录保留并报错，不猜测删除。

## 检查命令与结果

全部测试及工具命令前均加隔离环境（准确临时路径和完整命令见 checks.json）：

```text
env HOME=<temporary>/home USERPROFILE=<temporary>/home
    CODEX_HOME=<temporary>/codex CODEXHOST_DATA_DIR=<temporary>/hub
    RLY0_MEMORY_DIR=<temporary>/memory
    RLY0_SKIP_LEGACY_IMPORT=1 RLY0_CODEX_UPDATE_CONTROL=0 <command>
```

新测试每个 fixture 也独立建立上述目录和禁用变量，系统命令、quit/reopen、watchdog 启动均注入；没有调用真实 defaults、真实系统安装或另起 hub-service。

| 命令（上述 cwd，均带隔离环境） | exit | 结果 |
| --- | --- | --- |
| `./node_modules/.bin/vitest run --config tests/vitest.config.js packages/host-runtime/test/codex-update-alert.test.ts`（实现前） | 1 | 3 项预期失败，断言原代码没有写入 build 跳过值；保留本地 red.log。 |
| 下方聚焦测试命令（最终） | 0 | **5 文件，167 pass，0 fail，0 skip**。 |
| `npm run typecheck` | 0 | `tsc -b` 和 tests 类型检查通过，编译到当前本地 dist。 |
| `./node_modules/.bin/eslint packages/host-runtime/src/rly0-hub-service/codex-{update-manager,sparkle,skipped-version,check-preferences,update-watchdog}.ts packages/host-runtime/test/codex-{update-alert,version-gate}.test.ts` | 0 | 所有改动源码/测试 lint 通过。 |
| `node tools/check-boundaries.mjs` | 0 | 依赖边界通过。 |
| `./node_modules/.bin/prettier --check packages/host-runtime/src/rly0-hub-service/codex-{update-manager,sparkle,skipped-version,check-preferences,update-watchdog}.ts packages/host-runtime/test/codex-{update-alert,version-gate}.test.ts .pm/BOARD.json` | 0 | 改动代码、测试、看板格式通过（仓库默认忽略 Markdown）。 |
| `npm run lint` | 1 | 只有输入已有的 `packages/host-runtime/test/rly0-hub-promo.test.ts:11` 非空断言；该文件当前/输入 SHA-256 同为 `ffda9088fbf18a02d9990616cee66705446f66f1ea38f201f917062131893caa`，本轮新增 lint 错误 0。因 eslint 失败未到达聚合命令的边界检查，已单独补跑且通过。 |
| `git diff --check` | 0 | 无 diff 空白错误。 |

最终聚焦测试：

```sh
./node_modules/.bin/vitest run --config tests/vitest.config.js \
  packages/host-runtime/test/codex-update-alert.test.ts \
  packages/host-runtime/test/codex-version-gate.test.ts \
  packages/host-runtime/test/codex-update-watchdog.test.ts \
  packages/host-runtime/test/codex-input-idle.test.ts \
  packages/host-runtime/test/rly0-codex-updates-ui.test.ts
```

关键断言覆盖：build 而非展示版本、多个候选/build 数值排序、原值缺失/存在、用户新跳过/删除、已有更高用户阈值、同 feed/换 feed、退避/忙等待的新未适配 feed、写入成功但响应丢失、替换前/后的恢复、坏记录拒绝放行、恢复失败保持 hold、适配后真正 arm 前恢复、真实 watchdog runner 不触碰 skip/seen；原无任务且键鼠 5 分钟空闲规则及相关 RPC 回归一并通过。

遵循 `.agents/skills/codexhost-pre-push-checks/SKILL.md` 选择受影响包测试、类型、改动格式/lint 和边界；没有改 Rust、renderer 或发布脚本，不跑无关全量矩阵、不打包。原始检查日志留在本地 ignored `*.log`，不提交大段日志或 App 提取内容。

## 仍需真机与限制

1. 在获准独立环境确认运行中 Sparkle 读取外部 defaults 变化的时机，以及后续真实定时检查完全无官方提醒；已显示的窗口不保证自行消失。本轮无真实窗口/升级验收。
2. 真实适配放行后，在“无任务且键鼠 5 分钟未动”时的后台下载、退出安装与重新打开，以及用户关闭管理恢复原值。
3. Hub 崩溃/睡眠/系统权限失败时真实 watchdog 与下一次启动恢复。离线保留 skip 的逻辑只完成文件/注入命令测试。
4. Sparkle 显式手动检查可能忽略跳过值；本修复不声称封锁所有手动更新入口。feed 定期检查之间存在观察窗口；defaults 最后比较与写入间也没有跨进程原子 CAS。用户手动写入完全相同值时无法区分来源。
5. 修复后独立审查尚未进行；仅本会话自检，不将其标为 reviewed 或 accepted。Claude 继续负责界面、打包、发布及上线验收。

未改真实 `com.openai.codex` defaults；未退出/重启用户 Codex 或 Hub；未另起本机 hub-service；未修改用户 App 包、真实 guard 或全局配置；未推送发布。
