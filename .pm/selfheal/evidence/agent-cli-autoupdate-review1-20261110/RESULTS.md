# HUB-AGENT-CLI-AUTOUPDATE 独立复查 #1 修复证据

2026-11-10；分支 `feat/agent-cli-autoupdate`；固定输入 `976c0194c3fefc47d51f6cf00440256ec6fb1619`，保留 Claude 已提交的界面。状态 **implemented / self_verified**；修复后的 independent review、accepted 和真机验收均未完成。本地最终提交号由交付回复提供，业务源码以 [source-sha256.json](source-sha256.json) 标识，避免提交号自引用。

cwd：`/Volumes/RLY0Dev/Dev/Projects/codex插件助手/.runtime/agent-cli-autoupdate`。输入复查报告的原样副本见 [REVIEW-1.md](REVIEW-1.md)，原路径、SHA-256、Node 工具链见 [input.json](input.json)。本轮只改后台、测试、契约与项目记录，没有修改 `apps/hub-desktop/www`。

## 逐条处理和会失败的回归断言

下表路径均相对 worktree。省略目录的后台文件位于 `packages/host-runtime/src/rly0-hub-service/`；cli-update-admission、cli-update-owner、agent-installer 位于 `packages/host-runtime/src/rly0-agents/`；Host 测试位于 `packages/host-runtime/test/`。installation.ts 及 installation-command-driver.test.ts 分别位于 `packages/harness-discovery/src/` 和 `packages/harness-discovery/test/`。所有场景都是 synthetic；没有将 mock 成功当作真实安装/真实账号连接。

| 复查项 | 修法与实现文件:行号 | 对应测试文件:行号与关键断言 |
| --- | --- | --- |
| B1：原版不 ready 导致循环回退、误拉黑 | `packages/host-runtime/src/rly0-hub-service/agent-cli-updates.ts:388` 先做 ready 基线；`:453` 只对确定的非 ready/版本不一致 quarantine；`:485` 旧版读回后清事务，连接未恢复单独报告；`agent-cli-update-driver.ts:145` 把 Host 关闭、-32077、超时归为不可用；命令读回超时另报 CHECK_TIMEOUT | `packages/host-runtime/test/agent-cli-updates.test.ts:359` 覆盖安装前非 ready/检查异常；`:484` 旧版恢复但连接不可用不重复安装；`:618` 安装后版本读回超时回退、不拉黑且可再试；`agent-cli-update-driver.test.ts:338` 使用 -32077、-32090、TimeoutError 形态 |
| B2：安装失败但根本没改版本 | `agent-cli-updates.ts:446` 安装错误后先读版本，仍是原版清日志、不回装、不拉黑；`agent-cli-update-driver.ts:237` 使用同一 npm 的 view/prefix 查询；`service.ts:429` 与 `agent-cli-update-system.ts:112` 不注入空 npm_config_proxy，保留 npmrc 代理 | `agent-cli-updates.test.ts:410` 数字 error.code=1/243，断言仅调用一次 install、日志清空、坏版本为空、下次可成功；`agent-cli-update-driver.test.ts:140` 同一 npm/prefix 的 view/install；`agent-cli-update-system.test.ts:110` 保留用户代理 |
| 重要 1：残留锁永久封锁 | `packages/host-runtime/src/rly0-agents/cli-update-admission.ts:45` PID+OS 启动身份+唯一 ID，先完整写入再原子 link；`cli-update-owner.ts:49` Host 准入检查存活、识别 EPERM/PID 复用、自身孤儿与坏文件；`agent-cli-updates.ts:135` 启动统一清理，即使没有日志/关开关 | `agent-cli-update-host.test.ts:157` 空、损坏、null、旧格式、死进程、EPERM、PID 复用、自身残留；`:197` 真存活 owner 保留；`:210` 关开关且无事务仍清锁；`:97` 六个并发竞争最多一个 owner |
| 重要 2：恢复盲信日志降级用户手修 | `agent-cli-updates.ts:321` 先读当前版本；已是原版只清日志并返回 recovered；第三个版本放弃日志并保留版本；没有 quarantine 证据时撤销该遗留日志附带的误拉黑 | `agent-cli-updates.test.ts:432` 当前版本为 1.0.0/1.9.0 均不 install，清日志与误拉黑；`:456` 当前确是目标版时即使关闭开关仍可恢复 |
| 重要 3：更新的不是 Host 使用的 CLI | `agent-cli-update-driver.ts:103` 读取同一 HarnessLaunchSettingsStore；有保存文件时用 Host 原接口确认已经加载且无需重启。无法解析的保存目录报告 ORIGINAL_INSTALLER，绝不替换成 PATH 上另一份 | `agent-cli-update-driver.test.ts:278` 保存入口优先；`:294` 保存目录不回落 PATH；`:367` Host 尚未加载时拒绝；`:351` 用内存文件系统验证自定义 `/Volumes/RLY0Dev/Dev/Cache/node-v24` 原 prefix，命令仅注入记录 |
| 重要 4：npm 权限错误 code 为数字 | `agent-cli-update-system.ts:8` 安装前检查 prefix、bin、node_modules 和现有包目录 W_OK；`agent-cli-update-driver.ts:218`/`:380` 发现和安装前均检查；`packages/harness-discovery/src/installation.ts:127` 根据 EACCES/EPERM 错误形态返回脱敏码，不靠退出码是字符串 | `agent-cli-update-system.test.ts:43` Mac/Windows 原目录；`:58` EACCES/EPERM；`agent-cli-update-driver.test.ts:316` 没权限时不 view/install，并在安装前复查；`installation-command-driver.test.ts:67` numeric 243/1 + npm stderr EACCES |
| 重要 5：Windows 超时残留 npm、空闲进程占用 | `installation.ts:50` 超时/取消等待 taskkill /T /F 和进程 close，失败报 COMMAND_TREE_STOP_FAILED，绝不立即启动回退；`agent-cli-update-system.ts:36` 扫描可执行文件、规范路径、包目录和 native 短标题；`agent-cli-update-driver.ts:380` 安装/回退前重查占用 | `installation-command-driver.test.ts:10` 真实 Windows npm.cmd 引号形态；`:82` taskkill 完成前 promise 不结束；`:160` 树清理后仍等 close；`agent-cli-update-system.test.ts:70` idle serve/外部终端，`:99` 不误判同 prefix 的无关 Node，`:125` bare opencode serve；`agent-cli-update-driver.test.ts:386` 安装前再查占用 |
| 次要：手动“检查全部”被吞 | `agent-cli-updates.ts:265` 按助手排队，新的非缓存检查覆盖缓存重试 | `agent-cli-updates.test.ts:505` cached pi 忙碌重试中触发全部检查，断言 pi/grok/copilot 均重新查询 |
| 次要：recipe pin | `agent-cli-update-driver.ts:205` 保留 recipe pin 的约束，明确 VERSION_PINNED | `agent-cli-update-driver.test.ts:304` 真形态 @deepseek-ai/dsh@0.1.5-rc.1，既不 view latest 也不 install |
| 次要：入口围栏与可读状态 | `cli-update-admission.ts:141` 覆盖 webUi.open、inspectAccount(s)、refreshCredits；`:15` 可读中文与 -32072/retryable；`agent-installer.ts:709` Hub 终端登录；`grok-add-login.ts:139` 添加登录也检查围栏，启动过程计入 busy（service.ts:437） | `agent-cli-update-host.test.ts:232` 各入口被拒且底层方法没调用，释放后恢复准入；`:264` Hub/Grok 登录不启动命令；原有 turn/open/release 回归继续执行 |
| 次要：状态文件写入频率 | `agent-cli-updates.ts:181` 内容相同不写盘，事务日志仍即时持久化 | `agent-cli-updates.test.ts:517` cached busy 重试前后 inode/mtime 不变 |
| 次要：两个 Hub 覆盖状态 | `agent-cli-updates.ts:142` state 围栏内读-合并-原子写；`:272` coordinator 串行检查，开关操作不覆盖别的助手与 pending；并发开关保留最后请求 | `agent-cli-updates.test.ts:527` 陈旧实例关开关仍保留另一实例的 blacklist 和 journal；`:591` 并发开关最终值持久一致 |
| 次要：停服耗时 | `agent-cli-updates.ts:256` 停计时器/排队、调用驱动取消；`agent-cli-update-driver.ts:154` 取消 Host 和命令；不串行等待 300+60+300 秒，保留 journal 下次恢复 | `agent-cli-updates.test.ts:563` stop 取消进行中的安装，立即解除测试门闩，未启动回退；`:549` 树终止失败不并发回退；`installation-command-driver.test.ts:119` 等终止驱动完成才返回 |

四类点名回归都已加入并执行：更新前就不 ready、安装失败且版本没改、恢复前已被手动换成第三版、锁文件残留。原有测试没有删除/削弱：原来真正运行 Node 的 timeout/stderr 用例保留相同失败/脱敏断言，改为注入子进程驱动；旧“停服仍立即回退”的断言改为“取消、留日志、不并发回退”，并补充恢复用例。

## 执行命令与最终结果

按 `.agents/skills/codexhost-pre-push-checks/SKILL.md` 选择跨包构建、类型检查、聚焦测试、依赖边界、lint 与改动源文件格式。精确 cwd、参数数组、退出码、耗时及脱敏输出见 [checks.json](checks.json)。其中 lint-iteration 保存了本轮新增 5 处 lint 问题，现已修复；不是最终通过记录。

| 检查 | 实际命令 | 结果 |
| --- | --- | --- |
| 跨包编译 | `npm run build:typescript` | exit 0；本地 TypeScript/插件编译产物，未运行正式打包 |
| 类型/测试类型 | `npm run typecheck` | exit 0；包含后续变更的最终编译 |
| 聚焦测试 | 下方完整命令 | exit 0，13 文件，174 pass、0 fail、0 skip |
| 依赖边界 | `node tools/check-boundaries.mjs` | exit 0 |
| 全仓 lint | `npm run lint` | exit 1；仅 `packages/host-runtime/test/rly0-hub-promo.test.ts:11:20` 既有 `no-non-null-assertion`，与编辑前在 976c0194 运行的 baseline-lint 相同；新增 0，不将全仓 lint 标为 pass |
| 改动源文件格式 | `node node_modules/prettier/bin/prettier.cjs --check <改动 TypeScript 文件>` | exit 0（checks.json 的 final-format） |
| diff 与 UI 边界 | `git diff --check`；`git diff --exit-code 976c0194 -- apps/hub-desktop/www` | exit 0（final-integrity.json） |

```sh
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
  packages/host-runtime/test/rly0-agent-cli-updates-ui.test.ts
```

上述命令均经 [run-isolated.py](run-isolated.py) 包裹：临时 HOME、USERPROFILE、CODEX_HOME、CODEXHOST_DATA_DIR、RLY0_MEMORY_DIR、CLAUDE_CONFIG_DIR、APPDATA、LOCALAPPDATA、npm cache，设置 `RLY0_SKIP_LEGACY_IMPORT=1`、`RLY0_CODEX_UPDATE_CONTROL=0`。实际执行脚本位于 `/tmp/agent-cli-review1-check.py`；此处保留同内容便于复跑，调用方式为 `python3 run-isolated.py <记录名> <命令及参数>`。script 的 cwd 固定为本 worktree，输出在 `/tmp/agent-cli-review1-checks/`。

被测更新/安装的 npm 与系统命令、占用/owner 探针、网络、Host 驱动均注入；npm run 的构建/验证命令本身真实执行。Windows 样本为 npm.cmd/cmd.exe/taskkill 的真实参数结构，EACCES 样本使用 numeric error.code=243。自定义真实形态 prefix 的元数据在内存里，真正 HOME/状态/设置文件在临时目录里；不会向该真实 prefix 写文件。Host fixture 使用内存流和 fake 官方进程，未另起 hub-service。未运行真实 npm install/uninstall、登录/付费探测、日常 Codex/Hub 退出或重启、推送或发布。

## 契约变化与 Claude 交接

[契约 v2 新节](../../AGENT-CLI-AUTOUPDATE-CONTRACT.md) 覆盖 v1 冲突语义；RPC 参数和状态字段不变。Result 新增 `skipped-not-ready`、`recovered`；ErrorCode 新增 `BASELINE_NOT_READY`、`VERSION_PINNED`、`COMMAND_TREE_STOP_FAILED`、`CHECK_TIMEOUT`。UI 需要显示等待、版本锁定、保留外部更改、已恢复但连接未恢复、可重试安装失败与超时；`rolled-back` 不等于一定拉黑，应根据 badVersions 实际包含判断。没有改 apps/hub-desktop/www，未替 Claude 实现或验收这些映射。

项目功能文档同步到 `docs/operations/codexhost-console.md:11`；工单、PROGRESS、PROGRESS_CODEX、BOARD 与根目录老板看这里同步为 self_verified / pending independent review，未自批 accepted。

## 未完成与真实验收边界

- 修复后的独立审查未执行；这轮仅主会话自检，不将输入报告或合成测试充当修复后的 reviewed。
- 没有真实 Mac/Windows npm/原生 updater 安装、真实账号 ready、代理/registry 故障、Windows ACL/文件占用/进程树终止或原生停服耗时结论。需在获准独立环境验收，Claude 负责界面和发布。
- 安装目录型 launch setting 若需要 Adapter 专属入口解析，当前明确 ORIGINAL_INSTALLER，不猜测另一份 CLI。缺少可核实固定版本回退入口的原生工具仍 detection-only；只支持已核实的标准原生 OpenCode 升降级。
- OS 扫描可发现独立终端与闲置 serve，但无法原子阻止外部终端在最后一次扫描后新启动；检查不到/无法确认的状态 fail closed。未知 OS 启动身份但仍存活的已知 owner 保守等待。硬链接/ACL、进程树和多 Hub 真跨进程竞争还需二级平台验收。
- 状态切换和停服取消已测试，但停服仍可能等进程树终止/close 的各 5 秒或原生 HTTP 的 15 秒限时；不能宣称真机瞬间退出。
- npm postinstall 可能改 prefix 外部配置，重装旧包不是系统快照回滚。未跑全量/Rust/Renderer/发布检查，改动不涉及这些实现；现有 UI synthetic 回归通过只表示原有行为回归，不代表新文案已接好。
