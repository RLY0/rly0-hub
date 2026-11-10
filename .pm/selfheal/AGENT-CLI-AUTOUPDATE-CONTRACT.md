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

## v3：独立复查 #2 修复与 Claude 接线变更（2026-11-10）

本节覆盖 v1/v2 中的安装超时分钟重试、Host 空闲常驻进程一直阻止更新、旧版也不 ready 仍保留拉黑，以及恢复一律回装的语义。用户既定流程保持：Hub 自动更新助手 CLI，更新后做原生连接检查，非 ready 回退并跳过确定的坏版本，默认开启且可关闭。后台与测试归 Codex；本轮未改 `apps/hub-desktop/www`，界面及发布交 Claude。

### 新字段和错误码

管理 RPC 请求与 Result 枚举不变。每个 entry 新增以下字段；读取旧状态文件时有兼容默认值，状态文件 schemaVersion 仍为 1。

| 字段/错误码 | 后台语义 | Claude 显示建议 |
| --- | --- | --- |
| `previousVersion: string \| null`（默认 null） | 最近事务保存的原版本；回退/恢复完成后保留，用于判断 `currentVersion === previousVersion` | 结合 result、recoveryPending 和 errorCode 判断是否已恢复原版，不仅凭错误码 |
| `recoveryPending: boolean`（默认 false；存在遗留事务时由日志推导） | 还有待核验或待回退的事务，可能正在等待工作结束/进程退出 | 除 `ROLLBACK_FAILED`、`COMMAND_TREE_STOP_FAILED`、`STATE_WRITE_FAILED` 外，优先显示“更新恢复待处理，等待助手空闲”，不能写“有新版，等空闲更新” |
| `INSTALL_TIMEOUT` | 只用于安装命令超时；与查询/连接检查超时分开。可能完全未改版本，也可能已回退 | “本次安装超时，下次每日检查或手动检查再试”；已读回原版时显示已恢复/保留原版 |
| `INSTALL_FILE_BUSY` | Windows EPERM 单独分类；可能是文件被占用，W_OK 不能证明 Windows ACL 可写 | “安装文件可能被占用，请关闭外部助手进程后重试”；不能直接断言原目录没权限 |
| `PRE_UPDATE_VERSION_MISMATCH` | 安装前版本已变，完全未安装；和安装后的 VERSION_MISMATCH 分开 | “更新前版本已变化，本次已跳过”，不能写“装完版本对不上” |

`PERMISSION_DENIED` 保留给明确 EACCES 或 POSIX 权限错误；Windows W_OK 仅为预检，真实安装仍按脱敏错误判定。原始 stderr、命令输出和凭据不会写入状态。

`CHECK_TIMEOUT` 只代表读版本/连接等检查超时，可以分钟重试；`INSTALL_TIMEOUT`、`INSTALL_FAILED`、`INSTALL_FILE_BUSY` 不进入分钟安装重试，等每日或手动检查。若 `recoveryPending=false` 且 `currentVersion === previousVersion`，`failed / CHECK_TIMEOUT`、HOST_UNAVAILABLE、BASELINE_NOT_READY 都必须显示“旧版本已恢复，等待连接检查”；`rolled-back / CHECK_TIMEOUT` 表示原版已经重新 ready，可显示“旧版本已恢复，本次检查超时”。

### 空闲释放、连接围栏和按需重开

拿到该助手围栏后，驱动先向所有本机 Host 请求 `codexhost/harness/cli-update-release-idle`，参数 `{agent}`，返回 `{guarded:true,busy:boolean}`。Host 只释放该助手能安全关闭的空闲会话：没有运行回合/activeTurn、后台工作、子任务、待审批/问题、待执行命令、正在进行的操作或持久化异常，并且原生会话身份已保存。调用在该 thread 的现有队列内再次检查条件，确认 close、输出消费及持久化完成才移除会话；任一未释放会话使 busy=true。绝不取消、杀掉或重启正在工作的会话。

该释放不依赖用户“自动空闲释放”开关或超时，也不改变该偏好。Host 线程和已保存的原生身份保留；安装完成后没有预先重开会话，下次用户使用时走现有 resume 机制按需恢复。其他助手不受影响。释放后和每次安装/回退前仍扫描外部进程；外部终端/serve 不属于 Host 的空闲释放范围，只等待用户结束它们。

普通 `codexhost/harness/inspect`、adapter.inspect 以及版本检查在更新围栏内返回 AGENT_CLI_UPDATE_BUSY/-32072，不启动原生 CLI。更新器改用 `codexhost/harness/cli-update-inspect`，参数 `{agent}`，结果仍为原 `HarnessInspection`，底层是同一 adapter 的 `inspect({refresh:true})`。两个新增 Host 方法都要求该助手存在有效围栏，缺围栏拒绝；没有 Host、旧 Host 不支持或格式不符时 fail closed。新增 Host 方法供后台使用，界面继续使用原连接检查入口。

### 拉黑、恢复、锁和命令生命周期

更新前 ready、新版非 ready/版本不一致时仍回退并先暂存 quarantine。读回旧版后再做连接检查：旧版也非 ready、检查异常或超时即撤销该目标版的拉黑，保留其他坏版本；以后环境恢复可再试。只有新版失效、旧版恢复 ready 的有效对照才保留 quarantine；旧日志缺 quarantine 时不保留无证据的拉黑。回退安装尚未成功时保留日志和暂存 quarantine，不能宣称原版已恢复。

恢复时当前就是目标版、未判坏且刷新检查 ready，则保留目标版、清日志并返回 recovered，即使开关已关也不主动降级。`recovered` 因而也可表示“已保留检查正常的更新版本”；Claude 用 previousVersion/currentVersion 区分原版已恢复与目标版保留。非 ready 仍等空闲后回退；外部换装的第三版本仍保留。

POSIX 启动身份探针统一 `TZ=UTC, LC_ALL=C`；本进程启动身份缓存及 Host 的探针保持同一格式。已核实匹配的 owner 最多缓存 1 秒，每次仍检查进程存活，不延长缓存期限；新 owner/新启动身份重新查 OS，未知身份保守等待。这样减少更新期间每次准入的同步 ps/PowerShell 调用；首次/到期探针仍为同步，最多 3 秒，异步改造未在本轮承诺。

POSIX 安装命令通过 spawn(detached=true) 建立自有进程组，超时/取消对该组 kill(-pgid)，不靠父子树快照；组终止失败仍尝试直接子进程，并保留 COMMAND_TREE_STOP_FAILED 阻止并发回退。Windows 仍使用 taskkill /T /F 并等 close；taskkill 与正常退出竞争而 close 已确认时不误报树终止失败。没有放宽到杀同名或无关进程。

另一个 Hub 持有 coordinator 或本轮正在释放 coordinator 时，手动检查保留在队列，锁空出后执行；停服清队列并中止等待。Hub 选择“直连”时保留既有 ALL_PROXY/.npmrc/环境代理，这是继续沿用原 npm 环境的有意取舍；“直连”在此不保证绕过继承代理。

### 验收边界

本轮只做临时用户目录的 synthetic 协议、状态机与注入驱动测试；POSIX 进程组/时区探针仅使用自己启动的无害 sleep 子进程。真实 npm 前缀无 install/uninstall、日常 Codex/Hub 无退出重启、未另起 hub-service、未推送发布。Mac/Windows 的真实助手会话释放/按需 resume、真实安装/回退/连接、Windows ACL 与锁文件、原生后台工作和外部进程竞争仍需获准独立真机验收。新增界面字段/错误码由 Claude 实现并验收。


## v4：独立复查 #3 修复与后台接线（2026-11-10）

本节覆盖 v2/v3 的分钟重试、释放顺序与失败处理。用户既定方案保持：Hub 自动更新 AI 助手 CLI、更新后检查连接、非 ready 回退并按有效新旧版对照拉黑，默认开且可关。后台与测试由 Codex 完成；保留 `bc3fd9a1` 的 Claude 界面，未修改 `apps/hub-desktop/www`。界面和发布继续归 Claude。

### 字段和状态

- 内部 `cli-update-busy` / `cli-update-release-idle` 结果新增可选 `hostPid: number`（正整数）。新 Host 返回自身 PID。旧 Host 缺该字段时不推断归属，其 CLI 进程继续保守算占用。管理 RPC 请求、更新 entry 字段、Result 和 ErrorCode 枚举均未新增。
- AI 助手连接报告新增明确的 code 值 `AGENT_CLI_UPDATE_BUSY`，使用现有 `status: "unavailable"`、中文 message“该 AI 助手正在更新，请稍后重试（AGENT_CLI_UPDATE_BUSY）”，后台 hint 为“该 AI 助手正在更新，完成后请重新检测连接”。这是暂时等待状态，不是连接故障；不启动被围栏拦住的原生检查。围栏释放后用户再次检测按原流程执行，不自动重放用户请求。Claude 可按 code 映射等待显示。
- `INSTALL_FILE_BUSY` 的安装前可写性预检改为 `skipped-busy / INSTALL_FILE_BUSY`，每分钟可重试检查；预检期间不释放会话、不安装。实际安装过程中出现同码时仍按事务读回/恢复，不能用每分钟检查变成反复安装。
- v3 的 `recoveryPending` 显示规则已修为：**除 `ROLLBACK_FAILED`、`COMMAND_TREE_STOP_FAILED`、`STATE_WRITE_FAILED` 外**优先显示恢复待处理。上述三个故障必须优先保留具体失败，不能被等待文案覆盖（Claude 已在 `bc3fd9a1` 接好）。

### N1：回退后的分钟重试边界

分钟重试只处理 `causeCode === null` 的检查/等待结果，或仍有实际恢复事务的 `recoveryPending=true` 条目。完成回退且日志已清、`causeCode` 非空的结果，包括旧版检查超时、Host 暂不在、以及原版恢复 ready 后携带 CHECK_TIMEOUT 的 rolled-back，均不再进入分钟级试装；等待每日或显式手动检查。启动时保留原有检查流程。未完成恢复仍可等待空闲继续恢复，绝不据此再试装新版。临时故障仍不永久拉黑；确定新版不 ready 而旧版 ready 时保留坏版本。

### N2/N3：先只读占用预检，再有限频率释放

1. 拿到助手围栏后，对**所有**本机 Host 调用只读 busy；Host 将活动回合、后台/子任务、审批、操作/关闭、持久化或身份不完整、真实预热草稿等不可安全释放会话都算 busy。只读子代理快照不占 CLI，Host 忙碌和最终“还有会话”判定均忽略它们；父会话实际子任务保护保留。
2. 全部 Host 都空闲后扫描外部进程。释放前仅排除这些 Host 下、以当前 CLI 命令/原可执行文件/包目录为根的进程分支；其他助手的工具分支即使由同一 Host 派生也继续算外部占用。未知归属、外部终端、其他 Host 未确认的进程只等待，不释放空闲会话。
3. 全部检查通过才请求 Host 释放安全空闲会话。按助手、原可执行文件、目标版本，在同一驱动实例内每 15 分钟最多一次释放尝试（成功、失败均计入；Hub 重启会重建该内存限频）。分钟重试在限频期返回 busy，不重关会话；不同目标单独计数。
4. 释放后重新扫描，**不再排除 Host 进程**；任何残留或新启动的进程都使更新等待。实际安装/回退前仍再次完整扫描。所有扫描只读，绝不杀外部进程；最后扫描后的外部启动竞争仍需真机验收。

### 更新释放失败和协调锁

更新触发的 close 复用现有 `ExternalThreadLifecycle.release`，保留当前会话所有权与未完成关闭，不再写永久 closeFailed。关闭失败/60 秒超时后标记 sessionUnavailable；下一次用户使用可重试确认旧会话关闭及输出排空，再按原身份恢复，无须仅因该失败强制重启 Desktop。关闭仍在进行时复用同一 close Promise，不并发关第二次，也不提前开新 writer；始终无法确认的关闭仍会返回可重试错误并阻止恢复。手动开启的普通“自动空闲释放”原有失败保护未改。

另一个 Hub 持有 coordinator 时保留请求队列，使用 250ms 起、指数增长至 10 秒的等待，加最多 20% 抖动；不再每 100ms 写锁。stop 中止该等待、清队列，并继续按既有规则等待自身事务停止。没有修改全局进程或关闭保护。

### 验收与交接

本轮 compiled dist + 假驱动覆盖 N1 四次分钟 tick 不再循环、N2 16 助手乘 6 轮持续外部占用零释放、N3 实际 ReadonlySnapshotSession 不阻塞而真实预热仍阻塞；另有关闭失败/超时恢复、跨 Host、限频、进程分支、INSTALL_FILE_BUSY、连接报告与协调锁回归。均为临时用户目录的 synthetic 数据，不是真实 CLI 或账号验收。

修复后的独立复核/accepted、真实 Mac/Windows CLI 升级回退及 ready、文件占用/ACL、原生会话历史与按需恢复、跨 Host 进程归属和 UI 联调仍待独立环境确认。证据和精确命令见 `evidence/agent-cli-autoupdate-review3-20261110/RESULTS.md`。未运行真实全局 install/uninstall、未退出重启用户 Codex/Hub、未另起 hub-service、未推送发布。
