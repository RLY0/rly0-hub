# HUB-AGENT-CLI-AUTOUPDATE 后台契约 v1

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
