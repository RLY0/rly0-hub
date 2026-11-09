# HUB-CODEX-VERSION-GATE 复查 #1 修复结果

状态：**implemented / self_verified；修复后未再次独立审查、未 accepted、不是发布放行**。输入复查报告位于主工作区 `.pm/selfheal/CODEX-VERSION-GATE-REVIEW-1.md`。固定修复基线 `2d795e9c33d33992b911c4374924bb41ba840dcc`，包含 Claude 的 d4552531、2d795e9c；没有更改 `apps/hub-desktop/www`。

cwd：`/Volumes/RLY0Dev/Dev/Projects/codex插件助手/.runtime/codex-version-gate-20261109`；分支 `feat/codex-version-gate`。本轮仅本地源码、测试、契约及隔离进度写入，不推送、不打包、不发布、不安装、不改真实 guard、不写真实 Codex defaults、不退出/重启真实 Codex/Hub。Node v24.22.2 / npm 11.19.1。

## 逐项处理与回归

| 项 | 处理 | 可重复证据（测试名关键词） |
| --- | --- | --- |
| 1 必修 | 开开关前写 id/时间/pid 租约；独立 watchdog IPC ready 后才 true。Hub 死亡/过期/坏文件由 watchdog 关回 false，不依赖下次 Hub 启动。旧 guard 补丁只有“新鲜且存活”让路，其余写 false。 | `persists lease and starts its independent watchdog before enabling`、`watchdog cannot start`、watchdog 文件 7 项；guard injected Python 7 场景，真实脚本 SHA 与 dry-run/git apply 检查见 guard-patch-check.json。 |
| 2 必修 | 持续忙/未知心跳无限等待；只有真正后台下载计 30 分钟；签名成功缓存，负探测 30 秒节流，quit 前强制重验；已有暂存不重新触发；失败 6/12/24 小时退避并持久记录 retryAt。 | `waits indefinitely`、`ready staged update waits through prolonged work`、`caches successful staging signatures`、`download timeout backs off across checks and process restarts`。 |
| 3 必修 | Hub 关闭过的 Codex，安装超时/quit 回复丢失/关回开关失败仍恢复重开；自己的 updater 未退出则等，其他应用 updater 不挡；Codex 仍运行或已被 Sparkle 重开则清除关闭归属。 | `reopens a Codex closed by Hub after` 三场景、`does not reopen during its own installer`、`normal quit was cancelled`、`scopes installer recovery to Codex processes` 四场景。 |
| 4 必修 | 将比较器的同一 SEMVER_PATTERN 放到 shared-contracts，schema 与比较共用；比较异常保守不匹配，远程禁用比较异常保守收缩；check 整体兜底，坏缓存丢弃。 | `rejects comparison-invalid manifest version` 三坏 semver、`comparison exceptions cannot escape`、`invalid persisted manifests are discarded`；相邻 update-manager 测试。 |
| 5 必修 | currentVersion 偶发失败保留上次版本；null 不发布策略；Controller 首次不可读 core，运行中 I/O 错保留上次策略，损坏/真实版本不匹配仍 core。 | `transient version inspection failure preserves`、`retains running policy on transient I/O`、`filesystem reader exposes non-ENOENT`。 |
| 6 建议 | 从实际父 Launcher 的 startup record 取得 inspected Desktop 身份，优先于继承的环境变量；不使用历史连接成功认证，也不只取最近任意记录。 | `uses this Launcher's inspected Desktop identity when Hub did not open Codex`，含其他 PID/缺失 PID/尾零格式。Dock/npm/Launcher 真机仍 not_run。 |
| 7 建议 | 设置容忍新增字段，损坏可选字段不丢 enabled/原值；坏整段保守 disabled，不重新首次启用；主开关字段坏值不主动启用。 | `tolerates future/invalid optional state fields`、`damaged settings do not reacquire` 三形态。 |
| 9 建议 | native/steering 实际安装失败写 __codexhostFeatureFailuresV1，跳过/已安装不记失败；native 初始求值在同一次表达式内记录，CDP 上下文已毁时不追加求值。 | `records thrown optional native/steering failures`、native `unavailable native install`、steering `discovery failures`；保留原立即停止与求值次数断言。 |
| 10 建议 | 清理 native remote control、Host routing、DraftPrewarmPolicy、steering、binding，删除 NativeRpcDiscovery 状态，保留原脚本移除和 session.dispose 顺序。 | `disposes direct CDP owners and clears their discovery state on full-to-core transition`；原 session/controller 回归。 |
| 11 知情 | 保持退出后 open 重判，不恢复旧 launcher 内部平滑 restart；设置变更触发重启亦受影响，Windows 原强制退出可能中断工作。 | 本轮无此新增行为、无真实 restart；已在 CONTRACT v2 与真机清单列明。 |
| a 设计 | 移除菜单点击。持续空闲后，备份并设置后台检查开关/清除上次检查日期，正常 quit/reopen 触发 Sparkle 定时后台检查；其后等实际签名暂存、空闲安装。无菜单调用、伪造 Codex 参数或改包。 | `background driver uses only documented preferences`、`starts scheduled background checking only after idle`、`normal quit is cancelled if final idle check becomes unknown`。官方 Sparkle 文档依据列在 CONTRACT；真实 Codex 无弹窗/下载/安装路径待验证，不能声称静默升级已成功。 |
| b 设计 | 放行前保守要求 feed 所有较新候选已适配；以实际已签名且仍在 feed 的暂存版本为安装目标，允许 Sparkle 按系统/分批投放选低版本；低版本成功后保留 6 小时重试间隔。 | `all feed candidates must be verified`、`signed lower rollout choice`、`staged rollout choice disappears`。feed 在退出后改变仍有竞态，不能从外部锁定 Sparkle 目标。 |
| c 设计 | 暂存/安装/二次目标比较统一数值分段，尾部零等价；不把当前 inspect 字符串与 feed 硬比相等。 | `accepts numeric-equivalent installed version formatting`、staging `caches successful staging signatures` 使用三段与四段格式。真实两套版本格式仍需采样。 |

测试均为 synthetic。新的系统命令测试只注入 exec/startWatchdog/disarm 驱动；guard 测试在 Python 中 mock subprocess/os.kill/time。没有用临时 HOME 假装隔离系统 defaults。

## 检查与基线比较

每组使用 mktemp 临时目录，设置 HOME、USERPROFILE、CODEX_HOME、CODEXHOST_DATA_DIR、RLY0_MEMORY_DIR、RLY0_SKIP_LEGACY_IMPORT=1、RLY0_VERSION_GATE_OFFLINE=1。完整命令参数/退出码在 checks.json，基线实跑日志在 baseline-*.log / baseline.json。

| 检查 | 当前结果 | 基线 / 限制 |
| --- | --- | --- |
| npm run typecheck | pass / 0 | 基线有 1 个 TS2349（界面测试 onclick 未收窄类型）；仅修测试回调类型并新增函数断言，未改界面文件。 |
| vitest 14 文件（checks.json 列全参数） | **204 pass、1 既有 skip、0 fail** / 0 | 原 7 文件基线 105 pass；扩展了 watchdog/native/steering/更新器/界面契约相邻覆盖。未新增 skip 或削弱原断言。 |
| npm run lint | 1 fail / 1 | 与基线同一 `rly0-hub-promo.test.ts:11` forbidden non-null assertion；新增错误 0。 |
| node tools/check-boundaries.mjs | pass / 0 | lint 在 ESLint 处退出，故单独执行。 |
| npm run build:renderer | pass / 0 | 只编译 bundle，未打包 App。 |
| WebKit renderer-version-gate.spec.ts | 1 pass / 0 | 复用已有浏览器缓存，临时 HOME；synthetic DOM，不是真实 Codex。 |
| 改动文件 prettier / git diff --check | pass / 0 | 记录在 format.log、diff-check.log。 |
| guard patch | pass / 0 | 临时副本 dry-run 和 git apply --check；实际 guard 未修改。 |

没有重跑全量 TS 或 Rust：按 codexhost-pre-push-checks 选择本次 TS/Controller/系统驱动/相邻更新器受影响检查；无 Rust/发布脚本改动。上轮全量 9419 pass/18 fail 是历史结果，不作为本轮全量证明。中途新增 lint 未使用变量和 native 诊断多余求值问题均已修正，复验保留原断言。

## 契约与交接

CONTRACT v2 无新增/删除 RPC 字段、phase 枚举或错误码。内部新增 originalCheckPreferences、armed lease/attempt/session 日志和 watchdog worker。交 Claude：waiting-idle 包含后台检查前等待；installing 包含正常重开；downloading 不再是点菜单；CODEX_UPDATE_CHECK_FAILED 不再只指辅助功能权限；实际投放低于 feed 最大版本时 up-to-date 的文案应如实说明。界面文件本轮未改。

仍须：修复后独立复查、Claude 界面语义核对与发布接入、实际 guard 串行部署、watchdog 随包真实路径/权限验证、独立 macOS 真机链路和 Windows 验收。详细步骤见 LIVE-VALIDATION.md。未进行发布和真机试用，不请求据此直接发布。
