# HUB-AGENT-CLI-AUTOUPDATE 后台契约（v2 补充见末节）

当前行为以末节 v2 为准；下方 v1 内容保留作接口历史，冲突处由 v2 覆盖。

2026-11-10；交 Claude 接 AI 助手页。实现基于 `feat/agent-cli-autoupdate` / `9dfd747c`，状态为 implemented / self_verified，尚未 reviewed / accepted。本契约不改变“全自动、默认开启、连接失败回退并拉黑版本”的用户决定；不能可靠回退的安装方式明确报告能力缺口。

权威运行时 schema：`packages/shared-contracts/src/agent-cli-updates.ts`，已从包公共入口导出。管理通道沿用 Hub JSON RPC `{id, method, params}` → `{id, result}` / `{id, error:{code,message}}`。RPC 不接受命令、包名、prefix、URL、目标版本、回退路径或清空坏版本操作。

## 管理接口

| 方法 | 参数（严格校验） | 返回 |
| --- | --- | --- |
| `agents.cliUpdates.status` | `{}` | `AgentCliUpdateStatus`，纯状态读取，不触发检查或命令 |
| `agents.cliUpdates.setEnabled` | `{enabled:boolean}` | 持久化后的 `AgentCliUpdateStatus`；缺省 `true`。已启动调度器时，从关到开立即检查 |
| `agents.cliUpdates.check` | `{}` 或 `{agent:AgentCliUpdateId}` | 立即启动后台检查并返回 `AgentCliUpdateStatus`；不等待 npm/连接检查完成。并发触发合并到正在运行的检查，期间轮询 status |

关闭时手动检查也不安装、不查询版本。关闭前已经进入安装的事务会完成连接检查及必要回退；恢复遗留事务不受开关控制，以免将半安装状态留下。关闭前尚在查询/等空闲的事务不再进入安装。停服务会等待正在执行的事务结束，不杀死 npm 后直接退出。

```ts
type AgentCliUpdateStatus = {
  enabled: boolean;
  checking: boolean;
  intervalMs: number; // 86400000
  agents: AgentCliUpdateEntry[];
};
type AgentCliUpdateEntry = {
  agent: AgentCliUpdateId;
  currentVersion: string | null; // 最近可靠读取；未知为 null，不能用 latest 替代
  latestVersion: string | null;
  lastCheckedAt: number | null; // epoch 毫秒；含失败的检查尝试；关闭时不刷新
  lastUpdatedAt: number | null; // 只有新版通过版本与连接检查才刷新；回退不算更新成功
  phase: "idle" | "checking" | "updating" | "verifying" | "rolling-back";
  result: Result | null;
  errorCode: ErrorCode | null;
  causeCode: ErrorCode | null; // 更新触发回退的原因；回退失败时 errorCode 另报 ROLLBACK_FAILED
  badVersions: string[]; // 按助手持久化，不因重启、开关或手动检查清除
  installKind: "npm" | "script" | "unknown";
  canUpdate: boolean; // 安装方式的能力；是否开启仍看顶层 enabled
};
```

初始各版本/时间/结果/错误均为 null，phase 为 idle，installKind 为 unknown、canUpdate 为 false、badVersions 为空。checking 表示整轮仍在运行，phase 表示具体助手的阶段；phase 不是结果。界面不得仅因 currentVersion 等于 latestVersion 就覆盖 failed / rolled-back 提示。

## ID、安装方式与排除项

`AgentCliUpdateId`：`grok`、`opencode`、`pi`、`hermes`、`cursor-cli`、`kiro-cli`、`kimi-code`、`antigravity`、`deepseek-harness`、`omp`、`qoder`、`qoder-cn`、`codebuddy`、`copilot`、`devin`、`qwen-code`。

不包含 Codex、Claude Code、ZCode、WorkBuddy。`antigravity` 仅代表独立 `agy` CLI；只有桌面应用而没有 CLI 时返回未安装，不修改桌面应用。坏版本按 agent 保存，另一个 agent 的相同版本号不受影响。

npm 包名来自安装 recipe（剥离 recipe 内的旧版本 pin）及上游已存在的 npm 发行包。用真实 CLI 的 package.json、bin/shim 与全局目录结构识别原 prefix，不能用 `npm prefix -g` 推测目标。Mac/Windows 都以原 npm 可执行文件、`install --global --prefix <原位置> <包>@<精确版本>` 安装及回退；Windows `.cmd` 复用 Harness discovery 的 cmd 包装。无卸载、提权、修改 npm 全局配置或换 prefix 操作。

脚本安装只用已核实的官方接口。当前标准位置的原生 OpenCode 可用 `upgrade <version> --method curl` 正向更新和退回旧版。Pi、Grok、Cursor、OMP、Qoder、Hermes、Kimi、agy 有版本检测入口，但未核实固定版本回退能力时，只检测并报告 `ROLLBACK_UNSUPPORTED`；Kiro/Devin 等没有已核实安全更新入口时报告 `NO_OFFICIAL_UPDATER`。不能把“官方有 update”展示为“回退保险已验证”。未知/项目内 npm 安装、不同包管理器或不匹配位置返回 `ORIGINAL_INSTALLER`。

## 结果和错误

| `Result` | 含义 |
| --- | --- |
| `updated` | 精确新版本读回一致，所有本机 Host 刷新检查均 ready |
| `rolled-back` | 新版失败，旧版本读回一致且所有本机 Host 重新检查 ready；界面提示已恢复并跳过坏版本 |
| `skipped-busy` | 同一助手有工作/安装或另一更新持有围栏；不安装 |
| `failed` | 查询、安装事务或回退失败；显示错误码，不声称已恢复 |
| `up-to-date` | 无更新或当前版本高于 registry latest；不会自动降级 |
| `skipped-disabled` | 开关关闭或服务正在停止，尚未开始安装 |
| `skipped-not-installed` | 没找到该 CLI；不会为此自动安装一个新的工具 |
| `skipped-unsupported` | 安装方式无法可靠原地更新和回退，展示 errorCode 原因 |
| `skipped-bad-version` | 最新版已列入该助手的 badVersions，不再安装 |

`ErrorCode` 完整枚举：`CHECK_FAILED`、`INSTALL_FAILED`、`VERSION_MISMATCH`、`CONNECTION_NOT_READY`、`ROLLBACK_FAILED`、`HOST_UNAVAILABLE`、`BUSY`、`BAD_VERSION`、`NOT_INSTALLED`、`ORIGINAL_INSTALLER`、`NO_OFFICIAL_UPDATER`、`ROLLBACK_UNSUPPORTED`、`STATE_INVALID`、`STATE_WRITE_FAILED`、`INTERRUPTED`、`DISABLED`、`PERMISSION_DENIED`。

非 ready、检查异常/超时和版本读回不一致均触发回退。安装命令非零也可能已部分改写，仍尝试回退。回退前先写 badVersions；回退失败保留原事务，`errorCode=ROLLBACK_FAILED`，`causeCode` 保留新版失败原因。恢复遗留事务时 causeCode 为 INTERRUPTED。权限错误不弹提权窗口，返回 PERMISSION_DENIED（回退也失败时最终报 ROLLBACK_FAILED）。任意 npm/CLI 原始 stderr、代理地址、凭据或 token 均不进入状态对象。

非法参数的 RPC 错误为 `-32602 / INVALID_PARAMS`；未知方法为 `-32601 / METHOD_NOT_FOUND`。状态文件损坏为 `-32000 / STATE_INVALID`，不悄悄恢复默认开启；写入失败为 `-32000 / STATE_WRITE_FAILED`。已进入事务的其他运行失败通过 entry 的 errorCode/result 读取。旧 Host 不支持新协议或忙碌返回格式非法时 fail closed（CHECK_FAILED），需要升级后端而不是强行安装。

## 调度、围栏与连接检查

Hub 启动检查一次，运行中每 24 小时完整检查一次；忙碌或没有 Host 每分钟延后重试。有有效 npm latest 缓存的忙碌重试沿用该版本，手动检查重新查询。默认开关与状态持久化在 Hub 自有数据目录 `agent-cli-updates.json`，无配置迁移、无旧历史数据库写入。

更新前先获取 `agent-cli-updates/<agent>.lock/` 中唯一 owner 文件，随后查询所有本机 Host 的 `codexhost/harness/cli-update-busy`，参数 `{agent}`，返回 `{busy:boolean, guarded:true}`。Host 包含该助手的活动回合、子任务、后台工作、待启动/打开/恢复/安装与命令；围栏存在时拒绝该助手的新会话、恢复、回合及命令，其他助手照常。跨进程竞争者观察到其他 owner 就退让；遗留 owner 只有确认进程已死才回收，损坏 owner 保守阻止。独立终端和其他数据目录里的进程不在 Host 掌握范围内。

安装后请求每个本机 Host 的 `codexhost/harness/inspect`，参数 `{harnessId:agent, refresh:true}`，即 Codex 选择器、Hub 现有 agents 连接检查使用的 `adapter.inspect`。只有全部 ready 才保留新版；`--version` 成功或 npm 退出 0 不能替代 ready。无 Host 时不安装，不为检查而启动 Codex/Hub。

安装前原子写入原版本、目标版本和原位置的事务日志；异常退出后优先用该日志恢复旧版，不能将半安装状态当新的回退基线。围栏保持到版本核对、连接检查及回退结束。若 npm postinstall 修改 prefix 外的配置/依赖，重装旧包不保证逆转其任意外部副作用；不声称具备整个系统快照恢复能力。

## Claude 接线与验收边界

Claude 仅接状态和开关，不传入安装命令，不把 pending/updated 的代码级测试当真机验收。本工单未修改 `apps/hub-desktop/www`、未打包、未推送、未发布，也未对真实 npm prefix 执行安装/卸载。修复中涉及协议和工作准入，当前仅 Codex 自检，需独立复核；Mac 原生真实升级、Windows 权限/npm.cmd、网络代理和 UI 真实联调仍待独立环境验收。打包及发布归 Claude。


## v2：独立复查 #1 修复与 Claude 接线变更（2026-11-10）

本节覆盖 v1 中的异常一律拉黑、恢复时盲装、损坏锁永久阻挡、停服一直等待安装和并发触发丢失等语义。用户决定保持：默认开启、可以关闭、自动原地更新、更新后连接检查、确定新版连接不 ready 时回退并拉黑。后台与测试归 Codex；界面与发布归 Claude。本轮不改 `apps/hub-desktop/www`。

### RPC、枚举和显示建议

RPC 方法和请求参数不变；状态字段不变。Result 新增 `skipped-not-ready`、`recovered`；ErrorCode 新增 `BASELINE_NOT_READY`、`VERSION_PINNED`、`COMMAND_TREE_STOP_FAILED`、`CHECK_TIMEOUT`。运行时完整枚举以 shared-contracts 为准。

| 状态 | 后台含义 | Claude 显示建议 |
| --- | --- | --- |
| `skipped-not-ready / BASELINE_NOT_READY` | 原版本在安装前的连接检查已经非 ready，完全不安装 | 等待状态：“当前助手尚未连接，连接正常后自动更新” |
| `skipped-not-ready / HOST_UNAVAILABLE` | 无 Host、插件未加载、Host 消失、检查超时或不可解析；不能认定新版坏 | 等待状态：“等待 Codex 与助手连接检查恢复”；不要每张卡都用失败警告色 |
| `CHECK_TIMEOUT` | 命令或版本读回超时；恢复已变动的版本但不据此拉黑，每分钟重试 | 等待状态：“本次检查超时，稍后重试” |
| `skipped-unsupported / VERSION_PINNED` | recipe 明确 pin 了 npm 包；不会越过 pin | “已按适配版本锁定”；不能引导立即越锁升级 |
| `skipped-unsupported / PERMISSION_DENIED` | 原 prefix、bin 或包目录不可写，安装前已拒绝 | “原安装目录不可写，请用原安装方式处理”；不提权 |
| `recovered` | 遗留日志的版本已是旧版，仅清日志；没有执行安装，也未宣称已最新或已连接 | “已保留恢复的原版本”；若开关开启，下次完整检查可再检查 |
| `failed / VERSION_MISMATCH` 且 causeCode=INTERRUPTED | 恢复时读到的版本既非原版也非目标版，保留外部手动换装，放弃日志 | “检测到版本已在外部更改，已保留当前版本” |
| `failed / INSTALL_FAILED` | npm 失败但版本仍是原版时也会出现；此时日志已清，badVersions 未增加 | “本次未能安装，稍后可重试”；不能显示“回退也失败” |
| `failed / HOST_UNAVAILABLE` 或 `BASELINE_NOT_READY`，currentVersion 已回到旧版 | 旧版本已读回，但连接尚未恢复；日志已清，后续不重复安装旧版 | “旧版本已恢复，等待连接检查”；不能宣称 ready |
| `failed / COMMAND_TREE_STOP_FAILED` | 无法确认安装进程树已退出；保留日志，绝不立即并发启动回退 | “安装进程尚未确认退出，暂缓恢复”；待进程空闲再恢复 |
| `failed / INTERRUPTED` | 停服取消了更新命令或连接检查；未完成日志保留供下次恢复 | “更新已中断，下次启动先检查恢复” |

`rolled-back` 只在旧版本读回且重新检查恢复 ready 时使用。它可能由 Host 临时不可用触发，不能一律写“已拉黑坏版本”：只有 `badVersions.includes(latestVersion)` 才显示“已跳过该版本”。非 ready 本身在新版且基线 ready 时仍回退和拉黑；Host 不可用、-32077、超时、安装联网失败与中断本身不作为永久拉黑依据。

### 事务与原安装位置

安装前持有围栏、确认 Host/外部进程空闲、做 ready 基线，再读回原版本，写入旧版/目标版/原位置/baselineReady/quarantine 日志。安装错误后先读版本：仍是原版则清日志、不回装、不拉黑；确已变动或无法读回才恢复。回退读回旧版后，无论后续登录/Host 是否恢复，都不会因连接检查失败留下反复回装旧版的日志。新日志只对确定的非 ready 或版本不一致记录 quarantine；旧日志缺失新增字段时按未证明坏版处理。

恢复时先读当前版本：原版 → 仅清日志；第三个版本 → 放弃日志、保留现版本；目标版或读回失败 → 等空闲后恢复。旧版已经恢复后不再受开关关闭影响反复安装；只有未完成的实际版本恢复可以越过开关。

读取 Host 共用的 `harness-launch-settings/<id>.json`。保存的是文件时还通过 Host 现有 launch-settings/get 确认其已加载且无需重启；目录需要 Adapter 专属入口解析，当前保守报告 ORIGINAL_INSTALLER，不改 PATH 上另一份。环境变量按已存在的 Adapter 名称使用。识别出的 npm 包保留原 prefix（包括自定义 node-v24）；查询用同一 npm 的 `view --prefix <原位置> <包>@latest version --json`，与安装共用 registry/.npmrc/代理环境；Hub 无显式代理时不注入空 npm_config_proxy。DeepSeek 等 recipe 已 pin 的包不自动越锁。

### 围栏、并发、重试与停服

owner 使用唯一 ID、PID 与 OS 启动身份，完整文件写好后原子链接为 .json。Hub 载入时统一清理死进程、PID 复用、EPERM、旧格式与损坏/空文件，Host 每次准入也检查；匹配的存活 owner 不回收。未知 OS 启动时间但已知进程仍存活时保守等待。另设目录级 coordinator 串行化两个 Hub 的检查，state 围栏串行化状态写入；开关写入合并磁盘上的其他助手、坏版本和日志，避免后写覆盖。

新增覆盖 webUi.open、inspectAccount、inspectAccounts、refreshCredits、Hub 终端登录及 Grok 添加账号；进行中的 Hub 登录也算忙碌。拒绝返回可读中文、AGENT_CLI_UPDATE_BUSY 标识、-32072 或 adapter unavailable/retryable 状态。围栏释放后下一次操作可正常进入；不静默重放用户动作。

外部终端/常驻 opencode serve 通过注入式 OS 进程扫描检测原可执行文件、规范路径与包目录；安装和回退前再次检查占用。独立终端不受 Hub 的原子围栏控制，扫描后极短时间内外部新启动的竞争仍需真实平台验收。

手动请求在其他检查/忙碌重试过程中按助手排队，不丢失“检查全部”，新查询优先于缓存重试。busy、基线不 ready、Host 不可用仍每分钟重试。相同状态不重写状态文件；检查/恢复事务日志仍即时持久化。

停服先取消计时器和排队工作，再取消当前安装/连接检查。Windows 等待 taskkill /T /F 完成并确认进程关闭；POSIX 结束所拥有命令的进程树并确认关闭，再返回。终止失败报 COMMAND_TREE_STOP_FAILED，不启动并发回退。中断后留日志供下次先读版本恢复。仍可能等待系统终止/关闭超时（各最多 5 秒）或原生 HTTP 检查的 15 秒网络限时；没有“瞬间退出”的真机结论。

### 交接与验收边界

本轮仅 isolated synthetic 测试和本地构建/类型/静态检查；没有真实 npm/CLI 安装、真机账号连接、Hub 服务启动或日常程序重启。Claude 需补新增状态映射、等待色和回退失败的实际可用操作；修复后独立复核、Mac/Windows 的权限、占用、超时进程树、代理与 UI 联调仍未验收。原生 updater 的固定版本回退缺口仍保留。
