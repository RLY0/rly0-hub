# Codex 跳过版本：第二轮复查修复证据

2026-11-12，状态 **self_verified**。重要 1、次要 2–4 已实现并补回归；次要 5 已文档化并核对现有恢复入口。最终 5 文件 **217 pass、0 fail、0 skip**。本轮仅自检，修复后的独立 reviewed / accepted、Claude 新字段接线和真机验收未完成。

## 输入与边界

- cwd：`/Volumes/RLY0Dev/Dev/Projects/codex插件助手/.runtime/agent-cli-autoupdate`
- 分支：`feat/agent-cli-autoupdate`；输入 HEAD：`5b4c6893526712133e42af7a5ed61d9fd7d4365b`，开始时工作树干净。本提交包含本证据，提交后可用 `git log -1 --format=%H -- .pm/selfheal/evidence/codex-update-alert-review2-20261112/RESULTS.md` 查询其提交号。
- 先读主工作区 `.pm/selfheal/CODEX-UPDATE-ALERT-REVIEW-2.md`，再读 REVIEW-1。输入报告、源码和文档 SHA256 见 [source-sha256.json](source-sha256.json)。
- Node `v24.22.2`、npm `11.19.1`，实际 Node 位于 `/Volumes/RLY0Dev/Dev/Cache/node-v24/bin/node`。只读核对当前 Hub/Codex 的进程路径，未发送退出/重启信号。
- 保留用户政策：Hub 压住直到适配，未实际放行时写 `SUSkippedVersion` 压窗，放行前撤销，关闭管理恢复自身写入前的原状，保留用户自己的值。
- `apps/hub-desktop/www` 相对输入的 diff 为空，保留 Claude 界面提交。没有更改版本、打包或发布文件。

## 逐条处理

| 报告项 | 改动位置与处理 | 回归证据 |
| --- | --- | --- |
| 重要 1：退出前复核失败造成 2 秒请求循环 | `codex-update-manager.ts:767` 清空连续空闲起点，并设置本地 5 分钟最短间隔；`:913` 在间隔内不进入退出准备；`:927` 对 feed / 压窗失败进入该延后。到期后重新收集空闲证据；不增加原更新失败数或六小时退避。 | `codex-update-alert.test.ts:898`：429、503、实际 defaults 写失败三个注入入口，各 30 tick / 60 秒模拟时间只请求 1 次 feed；仍保留跳过值、无 watchdog/quit、无新增退避记录，恢复后可放行。`:1088` 另跑实际 60 秒定时器。 |
| 次要 2：写成功但读回失败永不补确认 | `codex-skipped-version.ts:14`、`:168` 在正常写命令成功返回后持久化 `writeSucceeded:true`；`:109`、`:143`、`:184` 在压窗/判断用户跳过/关闭管理的后续匹配读回时补确认，保留最早 original。没有写成功回执的旧 pending 不凭同值认领。`codex-update-manager.ts:99` 增加来源未确认字段，避免把无法证明的同值说成用户选择。 | `codex-update-alert.test.ts:997`：普通再查、直接关闭、重启后关闭三条路径恢复原值并删除成功恢复的记录；`:729` 覆盖回执与读回同时丢失的来源未确认提示。已有“写失败后用户同 build 跳过”保护继续通过。 |
| 次要 3：每 2 秒读取两次、读取错误挡住下载超时 | `codex-update-manager.ts:601`、`:667` 仅普通检查传入跳过轮询；`:687` 的 tick 不传入。`:892` 先判下载超时，`:902` 只在指定检查读取；`:767` 连续三次偏好刷新/读取失败用现有 `CODEX_PREFERENCES_FAILED` 报告，`:743` 成功后清除；`:965`、`:1011` 保留退出前两处检查。失败不授权退出、不强制中断当前下载、不计更新失败。 | `codex-update-alert.test.ts:929`、`:946`、`:979`：忙碌/下载的 30 tick 不读偏好；连续失败报错、恢复清除，持续读取失败仍到达下载超时。原周期 feed 失败、放行后最后一次读取失败的回归仍通过。 |
| 次要 4：不排除本机装不了的 build / 未考虑大版本跳过 | `codex-sparkle.ts:325` 使用按系统版本筛选后的 build；`codex-update-manager.ts:757` 在暂存目标出现前判断最新可安装展示版本。`codex-sparkle.ts:338` 起按需只读 major/subrelease，结合 bundle `CFBundleVersion`、feed `minimumAutoupdateVersion` 和 `ignoreSkippedUpgradesBelowVersion`；普通跳过与大版本跳过覆盖所有可安装 build 才阻止退出。Hub 不改大版本键。 | `codex-update-alert.test.ts:1034`、`:1045`：同展示版本的不可安装高 build、最新展示版本本身不可安装；`:1067` 五组 major/subrelease/忽略阈值/已越过 major 的边界，核对没有写/删大版本键。 |
| 次要 5：直接卸载残留跳过值 | `docs/features/codex-version-gate.md:13` 明确卸载前先关闭管理或恢复纯净并确认成功；失败时保留数据和记录。现有 `service.ts:1130` 的恢复纯净入口已调用 `setEnabled(false)`，本轮没有改它。直接拖删 App 没有可靠回调，本轮没有新增卸载钩子。 | 关闭管理恢复原值/原键缺失/整数和本轮 pending 确认的隔离回归通过；恢复纯净调用路径是源码核对，未运行实际恢复纯净或卸载。 |

上表源码位置均在 `packages/host-runtime/src/rly0-hub-service/`；测试在 `packages/host-runtime/test/`。新逻辑沿既有驱动、归属记录和串行状态机修改，没有另起服务或平行更新器。

## 60 秒频率实测

真实墙钟 **60,053 ms**，调用产品 `manager.start()` 的实际 2 秒定时器；三个场景各 **30 次定时 tick**。为等待串行工作结束另调用一次 tick，不产生额外 feed / 偏好读取。

| 场景 | feed 请求数 | 跳过值 defaults read / read-type 总次数 | 结束状态 |
| --- | ---: | ---: | --- |
| 空闲放行前 appcast 429 | 1 | 0 | waiting-idle |
| 用户持续忙碌 | 0 | 0 | waiting-idle |
| 已放行下载、偏好读取不可用 | 0 | 0 | downloading |

开始计数前完成正常初始化。计数包含大版本跳过键；未启动其他五分钟/手动检查。另有注入时钟测试验证 429 / 503 / 跳过值写失败、最短重试间隔和恢复，不以墙钟采样代替这些边界断言。原始结构化计数见 [cadence.json](cadence.json)。

appcast 的 XML / HTTP 状态、bootstrap installationId、偏好类型和 macOS 27 错误文本均为 **synthetic** 或既有记录形态回放。生产解析器、Mac 驱动、归属持久化和 manager 使用真实实现；所有系统命令、quit、reopen、watchdog 都注入，无真实网络 feed 或操作系统 defaults 调用。这里的“实际 60 秒”仅指实际定时器时长，不表示真实 Codex 更新已经验收。

## 命令与结果

所有检查由 Python `subprocess.run` 包装，运行于上述 cwd。每次创建临时目录，将子进程的 `HOME`、`USERPROFILE` 指向临时根，`CODEX_HOME`、`CODEXHOST_DATA_DIR`、`RLY0_MEMORY_DIR` 指向其子目录，同时设置 `RLY0_SKIP_LEGACY_IMPORT=1`、`RLY0_CODEX_UPDATE_CONTROL=0`。各 fixture 还创建独立的这五类目录并注入系统命令；临时目录均在结束后清理。

主回归的实际 argv：

```sh
npx --no-install vitest run --config tests/vitest.config.js \
  packages/host-runtime/test/codex-update-alert.test.ts \
  packages/host-runtime/test/codex-version-gate.test.ts \
  packages/host-runtime/test/codex-update-watchdog.test.ts \
  packages/host-runtime/test/codex-input-idle.test.ts \
  packages/host-runtime/test/rly0-codex-updates-ui.test.ts
```

结果：exit **0**，5 文件 / **217 pass、0 fail、0 skip**，61.69 秒。最后一个文件只读取现有界面源码跑 synthetic DOM，不修改界面、不证明新字段已接线。

其他实际 argv 与结果：

| 命令 | 退出码 / 结果 |
| --- | --- |
| `npm run typecheck` | 0；包含 `tsc -b` 和测试类型检查，非打包/发布 |
| `./node_modules/.bin/eslint packages/host-runtime/src/rly0-hub-service/codex-skipped-version.ts packages/host-runtime/src/rly0-hub-service/codex-sparkle.ts packages/host-runtime/src/rly0-hub-service/codex-update-manager.ts packages/host-runtime/test/codex-update-alert.test.ts` | 0 |
| `node tools/check-boundaries.mjs` | 0 |
| `npm run lint`（改动前、改动后各一次） | 均 1；仅输入已有 `rly0-hub-promo.test.ts:11:20` 的 `@typescript-eslint/no-non-null-assertion`，新增错误 0。该文件前后 SHA256 均 `ffda9088fbf18a02d9990616cee66705446f66f1ea38f201f917062131893caa` |
| `./node_modules/.bin/prettier --check` 加下列文件 | 0；范围为三个改动源文件、一个改动测试、BOARD 及本目录三个 JSON |
| `git diff --check` | 0 |
| `git diff --exit-code 5b4c6893526712133e42af7a5ed61d9fd7d4365b -- apps/hub-desktop/www` | 0，diff 为空 |

格式检查完整参数：

```sh
./node_modules/.bin/prettier --check \
  packages/host-runtime/src/rly0-hub-service/codex-skipped-version.ts \
  packages/host-runtime/src/rly0-hub-service/codex-sparkle.ts \
  packages/host-runtime/src/rly0-hub-service/codex-update-manager.ts \
  packages/host-runtime/test/codex-update-alert.test.ts \
  .pm/BOARD.json \
  .pm/selfheal/evidence/codex-update-alert-review2-20261112/checks.json \
  .pm/selfheal/evidence/codex-update-alert-review2-20261112/cadence.json \
  .pm/selfheal/evidence/codex-update-alert-review2-20261112/source-sha256.json
```

修复前先运行同一新测试文件的选中子集：`-t 'bounds a failed|does not fetch feed|reports consecutive|confirms a successful write after|uses only OS-installable|respects major skip'`，exit 1，14 个选中用例中 11 fail / 3 pass，其余 59 项因名称筛选未选中。具体断言复现 feed **30 次**、忙碌 defaults **60 次**，并复现 missing receipt、OS build 和 major skip 问题。修复后首轮 215 项通过，补齐实际定时器与最新可安装展示版本的最终检查为上述 217 项；未删断言或加 skip。

实际命令、cwd、耗时、退出码与脱敏摘要见 [checks.json](checks.json)。检查选择依据是 `.agents/skills/codexhost-pre-push-checks/SKILL.md`：本轮只改 host-runtime 源码和文档，没有跨包依赖、Rust、renderer 或发布变更，因此未跑全仓测试、Rust、原生启动、live Gate、打包或发布。`typecheck` 已编译 TypeScript 引用工程，没有必要另跑会复制发行插件的聚合构建。

## 契约与交 Claude

[CODEX-VERSION-GATE-CONTRACT.md 新节](../../CODEX-VERSION-GATE-CONTRACT.md#2026-11-12官方更新提醒复查-2交-claude) 从第 343 行开始，RPC、phase、错误码不增加。

1. 新可选字段 `skipOwnershipUnconfirmed?:true`：仅 `user-skipped` 的来源未确认情况出现。优先显示“来源尚未确认”，不能用既有“你已跳过”。字段缺失保留原用户选择文案。
2. 现有 `CODEX_PREFERENCES_FAILED` 可以伴随 `waiting-idle` / `downloading`；连续三次读取/刷新失败时应优先显示错误，成功后消失。后台不把下载强制停掉，也不因此增加更新失败计数。
3. 内部记录增加可选 `writeSucceeded:true`，schemaVersion 仍为 1。仅有 pending 的旧记录不追溯认领；普通跳过、大版本跳过、卸载前恢复和频率语义已同步功能文档。

本轮只完成契约文件交接，未启动 Claude 会话或对外发送消息，未修改 www；新提示的界面接入仍待 Claude。

## 仍未验证与限制

- 修复后的独立审查、用户/受委任者 accepted：未完成。本轮是同一执行会话的实现与自检，不声称独立复查通过。
- 真实 Mac：运行中 Sparkle 何时读取外部偏好、后续定时检查是否完全不弹窗口、已经出现的窗口、整数 skip 当前是否被识别、大版本/忽略阈值、critical 与“稍后提醒”、适配后实际后台下载和退出安装、关闭管理与真实 watchdog 权限：未运行。
- 新增 major 判断依据是固定 Sparkle 2.9.1 公开源码 `SUAppcastDriver.m:580–600` / `SPUSkippedUpdate.m:35–47`；没有重新反汇编 App 或宣称原生运行核验。只过滤已实现的 `minimumSystemVersion`；Sparkle 的 rollout / 其他资格仍由它选择，现有保守兼容门槛保留。
- 同时丢失写命令回执和读回时，不能证明值来自 Hub；保守保留，新增来源未确认状态说明该边界。已保存成功回执的情况能自动补确认和恢复。旧 schemaVersion 1 的历史归属仍不能追溯证明。
- `defaults` 不提供原子 compare-and-swap，最后比较与写入间仍有跨进程竞争；两次普通检查之间也有新 feed 观察间隔。
- 直接删除 App / 先删 Hub 数据目录没有恢复钩子；已文档化卸载前关闭管理/恢复纯净。未实际卸载。Windows 原生更新、安装/回退未运行，原 unsupported 语义不变。
- 全仓 lint 仍有一处基线错误；未混入无关修复。Obsidian 指定目录本轮不存在，未写笔记或全局记忆。

没有写真实 `com.openai.codex` defaults，没有退出/重启用户 Codex 或 Hub，没有另起 hub-service，没有推送、发布或替换安装。PROGRESS、PROGRESS_CODEX、BOARD 与老板看这里均已同步；本轮只做用户授权的本地提交。
