# 打通设置：MCP / 技能 / 记忆给所有助手

## 设置

RLY/0 Hub 左侧「打通」（打通设置）一处管理：概览、MCP、技能、记忆、线程。概览有三个开关，保存在
`<RLY/0 数据目录>/shared-resources.json`（`{ version: 3, mcp, skills, memory }`）：

| 开关 | 默认 | 说明 |
| --- | --- | --- |
| MCP | 开 | MCP 页合并 Codex 与支持的用户级外部配置；不带凭据的外部条目同步进 Codex（改动前自动备份），其余支持的条目按各助手自己的方式挂上。带 `enabled_tools` / `disabled_tools` / OAuth / scopes 的服务器不转接（无法保真翻译）。 |
| 技能 | 开 | 自动发现 Codex（含 `.system`）、Claude、通用 Agent 和已支持助手的用户技能目录，保留原安装位置，向 Codex、Claude、通用 Agent 分发受管副本；其他助手按能力接收原生文件或源文件索引。 |
| 记忆 | 开 | 共享记忆 rly0-memory（见下）。能接 MCP 的助手（含 Codex 自己）可读写，其余只读到摘要。 |

迁移：没有设置文件时用上表默认值（新安装和 0.11.12 从未改过开关的安装都全开）。0.11.12 写下的 `version: 2` 文件保留其中的选择，缺少 `memory` 键时按当时的默认“关”处理；0.11.12-preview.1 的单开关 `{ enabled }` 仍按它设置三项。Hub 之后写 `version: 3`。

生效：助手每次开会话或发消息都重新读取设置。记忆开关改变时 Hub 同步 Codex 配置里的 `[mcp_servers.rly0_memory]`，再由 codex-apply 原地换 Codex 后台（回复中则等回复完），不需要手动重启。已打开的会话里已挂上的 MCP 在重新打开后更新。只有本机 Host 提供共享。

## 各助手怎么接

由 Adapter 向 Host 声明请求（`SharedResourceRequest`：`mcp` / `skills` / `memory` / `memoryMcp` / `skillFiles`），Hub 表格（`RLY0_HUB_AGENTS[].sharing.modes`）与之由测试保持一致。原生 = 走助手自己的接口、只作用于该进程；提示注入 = 参考文字放在请求前。

| 助手 | MCP | 技能 | 记忆 | 方式 |
| --- | --- | --- | --- | --- |
| Codex | 本身 | 本身 | 原生 | Hub 写 `[mcp_servers.rly0_memory]`；全局常驻偏好同步到原生全局指令文件的托管块，不再向 developerInstructions 或 Codex MCP initialize 重复注入偏好；项目条目可用 recall 按需读取 |
| Claude Code | 原生 | 原生目录 + 提示索引 | 原生 | `~/.claude/skills`（尊重 `CLAUDE_CONFIG_DIR`）收到受管副本；SDK `mcpServers` + `systemPrompt.append` 含偏好原文；隔离模式不附带 Host 共享资源，但既有全局原生技能仍受 Claude 自己的发现规则控制 |
| Grok / Kiro / Kimi / Cursor / CodeBuddy / WorkBuddy | 原生 | 提示注入 | 原生 | ACP `session/new`/`load` 的 `mcpServers`；技能目录和记忆说明随每条消息附在请求前。Cursor 只给真实会话，不给检测和历史回放 |
| OpenCode | 原生 | 提示注入 | 原生 | 托管进程的 `OPENCODE_CONFIG_CONTENT`（OpenCode 与用户配置合并）：`mcp` 表 + `instructions` 临时文件，会话关闭时删除 |
| Pi | 原生 | 原生 | 原生 | 每个进程生成 `--extension`（`pi.registerMcpServer`，旧版无 MCP 时跳过）、每个技能一个 `--skill`、`--append-system-prompt` 记忆说明；文件在私有临时目录，进程退出即删 |
| Hermes | 全局（可选） | 原生 | 提示注入（摘要） | gateway 进程内 `PluginContext.register_skill` 注册技能；MCP 只能写全局 `~/.hermes/config.yaml` |
| Antigravity（agy） | 全局（可选） | 提示注入 | 提示注入（摘要） | agy 只读全局 `~/.gemini/config/mcp_config.json` |
| DeepSeek / ZCode / OMP / Qoder | 不支持 | 不支持 | 不支持 | 接入没有挂载入口，或参数未核实；表格写明原因 |

### 只能改全局配置的助手

Antigravity 和 Hermes 只从全局文件读取 MCP。概览底部每个一枚开关，**默认关**。开启时 Hub 先备份该文件（`.rly0-bak-<时间>`），只添加 `rly0-*` 条目：Antigravity 在 JSON `mcpServers` 里加键（文件含 `//` 注释时拒绝修改以免丢注释）；Hermes 在 `mcp_servers:` 下插入带标记的一段（缩进跟随文件，没有该键时补一个并标注），值用 JSON 流式映射。`env` / `headers` 带凭据的服务器**不写**进全局文件，页面列出被跳过的名称。关闭时只删除 Hub 写入的条目（记录在 `<数据目录>/bridge/global-blocks.json`）。MCP 列表或开关变化后已开启的块自动重写。

## 共享记忆 rly0-memory

- 实现：`packages/host-runtime/src/rly0-memory/`。无 SDK 的 MCP stdio 服务器（换行分隔 JSON-RPC），工具 `remember` / `recall` / `search` / `forget`。非 Codex 的 `initialize.instructions` 和 Host 会话上下文带已获 Hub 批准的全局及当前项目偏好；Codex 只用原生 AGENTS 托管块自动加载全局偏好，不改调用方 developerInstructions。发布包用 `node app/host-runtime.mjs --rly0-memory-mcp` 启动，源码构建用 `dist/rly0-memory/server-main.js`。启动环境含共享记忆、数据目录、Agent 和可选 cwd，均为路径/标识，不含凭据；不再写入无用途的绝对 CODEX_HOME。
- 存储：`<数据目录>/memory/records.jsonl`，每行 `{id, text, tags, agent, thread?, scope, project?, time, source?, preferenceApproved?}`；追加写，跨进程锁文件 `.lock`（独占创建、15 秒过期、Windows 上 EPERM 视为占用重试）；`forget` 在锁内重写文件，正文真正离开磁盘。`audit.jsonl` 记录每次增删（不含正文，1 MiB 轮换）。
- 范围：`project` 以仓库根（最近的 `.git`）归一化，`global` 对所有项目可见；`recall` 返回本项目 + 全局，`search` 可选 `all` 跨项目。
- 限制：单条 4000 字、8 个标签（字母数字 `_ . : -`，32 字）、5000 条、16 MiB。
- 脱敏：写入和读出都过 `redaction.ts`：常见令牌格式、私钥块、URL 中的密码（移植自 agentmemory，见 NOTICE.md）、凭据赋值、连接串密码。只是有界防护，不能证明文本没有其他隐私。
- 导入：首次使用时只读复制 Codex 记忆（`MEMORY.md` 各任务组的偏好 / 可复用知识 / 失败教训，有 `applies_to: cwd=` 的归该项目；`memory_summary.md` 的 User Profile / preferences / General Tips 归全局），标签 `codex-import`，标记文件 `codex-import.json` 防止重复。Codex 自己的文件不改。
- Hub：记忆页可搜索、按范围筛选、添加（来源 `hub`）、删除（二次确认）、导出到 `memory/exports/`、打开文件夹（`memory.*` 方法）。

## 常驻偏好与原生技能同步（HUB-50）

常驻偏好要求 `preference` 标签和 `preferenceApproved=true` 同时存在。只有 Hub 的 `memory.add(tags:["preference"])` / `memory.pin` 可以批准；MCP 和委派不能自行置顶，也不能经 forget 删除已批准偏好。旧的仅含标签记录默认不注入，需在 Hub 重新置顶。取消置顶保留 ID、原文、其他标签、Agent 和任务来源。最多附 20 条、正文块共 10000 字符，整条保留，超限数量可见；置顶不授予新操作权限。

上述“只有 Hub 可以批准”是受支持 API 的规则，信任边界止于**同一 Windows 用户**：该用户下的其他进程（包括 full-access Agent）可直接改写 `records.jsonl` 的 `preferenceApproved` 字段，或启动本地 Hub stdio 服务调用 `memory.add`；stdio 调用本身没有额外身份鉴权。目前批准字段**没有密码学签名**，不能据此证明记录由用户亲自在界面批准，也不能抵抗同用户进程篡改。模型上下文保留 `agent`/记录 ID/项目来源，Hub 列表保留 Agent/任务来源；来源是可追溯元数据，不是身份认证。未加入本地 HMAC：同用户进程亦能读取存放在该用户目录的私钥，单独签字段不能封闭 stdio 批准入口。需要更强隔离时须另行设计受保护的密钥与批准通道。

非原生 MCP 摘要可能进入 Pi/OpenCode 等助手的系统提示，因此排除带 `conclusion` 标签的委派输出；结论仍可显式 recall，或随委派作为有来源的参考数据传入。共享上下文达到 26000 字符预算时，按整块省略记忆并提示 recall，不截断半条常驻偏好或丢掉结束标记。

Codex 全局偏好写入 `${CODEX_HOME}/AGENTS.md`，有 `AGENTS.override.md` 则优先写后者。只改 HTML 注释托管块，原子替换，不产生全文备份，并清理旧的含完整托管块的已知备份文件。偏好中的托管标记转义。纯托管的新文件关闭后删除，原有空文件保留。**不把项目私有偏好写入全局文件，也不再经 developerInstructions / Codex MCP initialize 重复注入。** Codex 的项目偏好仍可 recall，但当前不会自动送进原生新会话，避免未经作用域授权写项目 AGENTS；此项范围限制须在真实验收中明确。

技能从 `${CODEX_HOME:-~/.codex}/skills`（含 `.system`）、`${CLAUDE_CONFIG_DIR:-~/.claude}/skills`、默认 `~/.claude/skills`、`~/.agents/skills`、`~/.grok/skills`、`~/.pi/agent/skills`、`${HERMES_HOME:-~/.hermes}/skills` 发现。分发使用受管副本，目标为 Codex、当前 Claude 配置和通用 Agent 的技能目录，清单在 `<数据目录>/bridge/native-skills.json`。Hub 启动、共享设置变化、技能变更、技能/MCP 页面刷新和显式 `bridge.syncNative` 均安排或等待同步；Agent 会话启动只在后台安排同步，按有界源目录元数据指纹合并并缓存，变化才读文件内容/哈希。首次后台复制未完成时，源目录及原生适配器技能路径仍可使用。技能变更主操作成功而原生同步失败时返回 `{ok:true,...,native:{error}}`，避免重复导入/移动。

复制跳过 `.env`/环境变体、credentials/secret/token/auth 样式文件或目录、`.ssh`/`.aws`/包管理凭据、私钥和证书文件。单技能上限 1024 条/16 MiB；入口链接/junction 经 realpath 解析、去重，只接受已知用户技能根范围内的目标；根本身不能指向 HOME 或盘根。技能内部链接只可指向本技能树，按祖先 realpath 防环；源技能中的 `.git` 目录、worktree 指针文件或链接均直接排除，不读取其内容；副本中用户新加的 Git 元数据仍视为用户改动，不由 Hub 自动删除。同名用户技能和用户修改的副本保留；清理只回收仍能按根路径与内容散列核对的受管副本。仍不宣称能识别任意命名的秘密，校验至删除之间的竞态与本机 manifest 篡改另列残余风险。

### 外部安装与来源字段（HUB-52）

来源按 Codex → Codex `.system` → 自定义 Claude → 默认 Claude → agents → 其他受支持目录的顺序选择；同 realpath 只列一次，同名不同目录选择一个分发来源并在 `conflicts` 报出其他路径。来源文件和第三方入口链接均不删除或覆盖。`.system` 技能仅向其他助手分发，不回拷到 Codex 顶层；旧版误生成且仍能核对所有权的顶层副本会回收。同名用户安装和改过的副本原样保留；受管副本不会反过来成为安装来源。安装器更新原位置后，下次同步检查会跟随更新；不会持续重读未变化的源文件字节。当前不是全盘搜索，也没有新增定时扫描器；Hub 页面刷新、会话技能请求、启动和既有变更入口触发发现。

`skills.list.installed[]` 新增兼容性可选字段（本实现全部提供）：`source: codex|claude|agents|external`、`sourcePath`（入口路径）、`realPath`、`isLink`、`conflicts:string[]`、`distributionOnly:boolean`。`skills.openFolder({name})` 打开所选来源入口。刷新同步失败时 Hub `skills.list` 仍返回发现结果，另带 `native.error`，不能将列表可见视为分发成功。

外部来源、链接及系统技能的停用仅暂停该名字的 Hub 分发，并回收内容仍匹配的 Hub 副本；原安装仍然存在，助手可能照自己的规则继续发现它。停用信息存于 `bridge/paused-skills.json`，通过既有 `backups[]`/`backupId` 恢复；这类备份条目带 `sourcePath`、`distributionOnly:true`，不是一份搬走的目录。恢复后从原安装位置取最新版重新分发。普通 Codex 自有真实目录仍搬到备份区，同时暂停该名字的全部 Hub 分发，避免同名外部来源补位；恢复原目录后再解除暂停。对旧版已产生的补位，仅在能核对为未修改的 Hub 副本时回收后恢复，真正的用户冲突仍保留并报告。旧备份恢复失败时，只回滚本次临时建立的暂停记录，并恢复受影响的派生副本；原有合法暂停记录不撤销。

若用户手动删除了 Codex 备份目录，该名字的暂停记录不会在列表中消失：继续列入 `backups[]`，沿用原 `backupId/name/backedUpAt/sourcePath`，设置 `distributionOnly:true`。既有 `restore({backupId})` 对此条目只解除暂停、再从仍存在的来源分发；不声称能还原已经手动删除的原备份。列表读取不自动恢复共享，不新增字段或 RPC；只有明确 ENOENT 才判定为备份缺失，权限错误不能伪装成丢失。Claude 可在现有恢复按钮上接“解除暂停”说明。

MCP 原来同样只读 Codex。现在发现用户级 `~/.claude.json`、`${CLAUDE_CONFIG_DIR:-~/.claude}/.claude.json`、`~/.cursor/mcp.json`、`~/.gemini/settings.json`、`~/.gemini/config/mcp_config.json` 的顶层 `mcpServers`；不读 Claude 的项目私有 MCP，不读账号/OAuth 凭据库。外部列表项以及仍属于 Hub 的 Codex 导入副本均有 `source`、`sourcePath`、`external:true`，沿用停止/恢复共享入口。共享时按目标助手过滤来源，Codex 中的导入副本也保留来源：Claude、Cursor、Antigravity 不再收到自己已有配置的 `codex_*` 副本，Antigravity 全局桥也不会把原服务以 `rly0-*` 写回来源文件。JSON 中无法保真转换的策略、OAuth 和未知字段不转接；Hermes 任意 YAML、OpenCode 的独有配置结构及第三方自定义目录尚不导入，不能称所有安装器/格式均已支持。

只将没有非空 `env`/`headers`、且未命中保守凭据检查的配置写入 Codex 的独立受管 MCP 表（空对象不视为凭据）。检查复用共享记忆的令牌形状脱敏规则，覆盖 GitHub 等令牌、凭据字段/命令标记、URL 查询/fragment、敏感或疑似不透明的路径片段；疑似条目只允许进程内传递，可选全局桥也执行相同检查。这是有界检测，不证明任意 argv/URL 均不含秘密；保守误判时不会持久导入。所有权清单 `bridge/external-mcp.json` 保存来源路径、SHA-256 和内部摘要版本。新版指纹稳定排序对象键、忽略空 env/headers，保留 argv 顺序；TOML 子表重排不视为用户处置。旧指纹仅在原始散列可通过已知空表位置变化核实时升级，不忽略任何实际值变化；已经 disposed 的记录仍需明确恢复共享，不自动重新取得所有权。命名冲突与用户改动优先保留；安装器更新可更新仍属于 Hub 的表。用户手改或删除导入的 MCP 表后，清单保留 `disposed` 状态，后续扫描和安装器更新不会自动重新添加；列表按停止共享显示，明确恢复共享才解除该状态。原配置一字不改。带凭据条目仅进入支持助手的进程选项，不持久复制到 Codex，不进入模型可见上下文；因此这类外部 MCP 在原生 Codex 上自动接通仍有限制。停用/移除外部条目写本地分发控制（`external-mcp-controls.json`），不编辑安装器文件，防止自动同步重新启用或加回。旧 `removed` 状态保留兼容，但不再隐藏外部条目，按停止共享显示，可用既有 `mcp.setEnabled` 恢复，不需要新的移除/恢复界面或 RPC；恢复纯净会回收仍未被用户改动的 MCP 副本。

Claude 已接入来源标记及停止/恢复共享；本轮新增的孤儿暂停条目复用现有字段，解除暂停说明由 Claude 接。修后独立复核、真机 Hub 更新与新会话工具可用性均须另验。未改认证、消息协议、路由、调度锁或原始数据库。既有同用户 manifest 篡改与校验后文件替换竞态边界继续适用；原子改名和前后内容检查不等于抵抗恶意同用户进程。

技能更新在第一次目录改名前把 stage/old 的路径、前后内容散列及来源写入现有所有权清单的恢复记录。下一次同步（包括 Hub 启动）先恢复中断的改名或回收可核验的旧树，再做发现；恢复过程沿用原生资源现有锁，不增加调度锁。目标根/父目录 realpath、非链接属性、目录名和内容散列全部通过才递归清理。被用户修改、替换成 junction 的目录保留并列入 skipped；没有恢复记录的历史 `.rly0-sync-*-old` 仅报告，不能只凭名字删除。有恢复记录但路径/内容校验失败时，仍保留记录和文件，其他安全条目继续同步；本次同步通过既有错误通道报告 `GLOBAL_CONFIG_SKILL_RECOVERY_BLOCKED`，`bridge.status.nativeError` 保持该状态，单独成功的记忆/指令操作不能将它清掉。证据修正后可通过现有 `bridge.syncNative` 重试，完整同步成功才清除错误。

原生写入通过本进程队列及 SQLite OS 事务锁串行化，另留 pid/时间/随机标识的 wx 元数据文件。所有原生写入者在持有 SQLite 事务时才创建和移除元数据；取得事务锁后残留 wx 文件直接回收，不再靠 PID 探测判断（避免 Windows PID 复用或 EPERM 永久卡住）。进程被杀时 OS 锁释放；活进程持有事务时不会按时长抢锁。恢复过程也在 OS 锁内，避免两个回收者误删新锁。仅使用 wx 文件、不遵守 SQLite 门的旧实现不能并发写入此目录。MCP 子进程不参与原生同步。损坏托管块仍报告错误；同步失败与已保存记忆分开报告。后台失败可从 `bridge.status.nativeError` 查询并用 `bridge.syncNative` 重试。

给界面的增量契约 `HUB-50 bridge v1`（Hub 既有鉴权 RPC，Codex 已实现/自验，Claude 已接入，修复保持参数不变；真实 UI 验收及修复后独立复核 pending）：

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `memory.pin` | `{ id: string, pinned: boolean }` | `{ record: MemoryView \| null, native: { instructions?: string[], error?: string } }`；找不到时 `record=null` |
| `memory.list` | 原参数另支持 `pinned?: boolean` | 记录新增 `pinned:boolean`、`thread:string\|null`；`pinned:true` 只列常驻偏好 |
| `bridge.syncNative` | `{}` | `{ instructions, synced, skipped, removed }` 文件路径列表；冲突/不可用项在 skipped |
| `bridge.status` | `{}` | 原字段另有 `nativeError:string\|null`（本次 Host 最近同步错误） |

`memory.add`/`memory.pin` 返回原生指令同步结果；`memory.forget` 只在同步失败时另带 `native.error`。共享设置保存后若同步失败返回 `sharingError`，保存状态和同步状态分别报告。
参数不合法返回既有 RPC `-32602/INVALID_PARAMS`；操作失败返回 `-32000` 及脱敏错误码。置顶是本地锁内原子操作，无异步任务或取消句柄；只有真实回包后才更新界面状态，未知结果应先重新读取记录，不直接重复创建。fixture 均标记 synthetic，真实模型/新会话验收另列。

## 列表安装时间

`skills.list.installed[]`、`skills.list.backups[]` 和 `mcp.list.servers[]` 可选返回 `addedAt`（非负整数，Unix 毫秒）。技能按名称和来源目录区分，在 Hub 首次列出时以目录 birthtime 初始化，无有效 birthtime 则用 mtime；MCP 按名称和来源文件区分，以配置文件 mtime 初始化。已有 Codex MCP 升级后首次列出时共用 `config.toml` 的 mtime；外部 MCP（含 Hub 在 Codex 中的受管副本）使用外部来源文件。普通文件更新、重新打开页面或重启管理器不会改变已记录时间；仅当技能目录 birthtime 晚于记录时识别为同路径重装，原子更新为新的 birthtime。没有 birthtime 时不靠 mtime 推断重装。

时间独立保存在 Hub 数据目录 `resource-added-at/{skill,mcp}/`，不写入技能、来源配置或原始会话库。每项以名称和规范化绝对来源路径的散列定位，完整写入后才以硬链接原子发布；重装时用原子改名替换记录。元数据不可使用时省略可选字段，来源暂时不可读时沿用已有有效记录，列表继续可用；前端缺字段时保留原顺序。停用技能的 `addedAt` 使用现有 `backedUpAt`；恢复后安装时间沿用原记录。`threads.list` 已有 `mtimeMs`，本次不变。前端排序由界面实现，后台列表原顺序保持不变。

记录本轮不自动清理：现有格式只保存散列和时间，没有可回查的来源路径；不可读也不能当作已删除。每个历史身份只保留一份数字记录，长期来源频繁变化仍会累积，保留为低风险限制。

## 单个来源读取失败

技能根目录的 ENOENT 表示尚未安装，正常忽略；其他读取异常把该根加入发现与同步的 skipped 列表，并用 `skills.list.native.error=GLOBAL_CONFIG_SKILL_ROOT_UNAVAILABLE` 报告。正常根继续列出和同步；不可读根作为来源或目的地时保留现有副本及所有权，不因扫描失败删除，也不将同名替代来源覆盖上去。明确关闭共享或停用仍按原控制状态处理。

外部 MCP 配置按文件隔离读取/解析失败；正常文件继续发现和同步，受影响文件的旧副本和所有权保留，`mcp.list.native.error=GLOBAL_CONFIG_MCP_SOURCE_UNAVAILABLE` 上报。ENOENT 仍沿用已有的来源移除规则。源元数据指纹扫描失败不阻断其他来源。同步结果新增可选 `errors`（脱敏错误码数组），失败来源路径列在原有 `skipped`；`bridge.status.nativeError` 保持警告，后续刷新重试，完整成功后清除。Hub 自身损坏的控制/所有权文件、Codex 目标配置写入错误和未完成更新恢复仍沿用原有保护，不被当成正常空配置。

## 委派与模型默认值

`tools/collab/rly0_delegate.mjs` 先检查实际 CLI 的 `delegate start --help` 是否列出 `--memory`，再读取 `<数据目录>/shared-resources.json` 的真实开关（兼容 v2 默认关闭及旧 enabled 格式）。支持且开启时使用 `delegate start --memory true --cwd ...`；旧 CLI 或探测失败时省略此参数，照常委派，在输出 `context.sharedMemory` / 编排步骤 `sharedMemory` 报 `enabled:false` 和 `reason:CLI_MEMORY_UNSUPPORTED`。关闭记忆、损坏配置及 Host 不发 token 分别报对应原因，不声称共享已启用。服务端在这次委派范围内组装偏好/项目参考，不再提供任意 cwd 的预读取。`--no-context` 不请求共享；关闭记忆时不带记忆或启动写回监听。Codex 不在任务正文重复加入全局偏好，非 Codex 可以收到已批准偏好。

服务端给实际创建的 child 发放运行时内有效的 `memoryToken`，绑定其 cwd、harnessId 和 threadId。包装器通过子进程环境 `CODEXHOST_DELEGATION_MEMORY_TOKEN` 交给监听器及 CLI，`delegate context [--cwd ...] [--query ...]` 只读此绑定目录；`delegate remember [--cwd ...]` 不接受自报 agent/thread/text，由服务端读取这个 child 的 completed 结果并取最后一处完整的 `【可复用结论】...【可复用结论结束】`（不超过 3500 字），避免取到前面复述的标记说明；最后一个块为空时不回收更早块。兼容显式 `--memory-token`，但包装器不使用此参数。失败、取消、空或超长结论不保存；保存脱敏、标签 conclusion、source=delegation，重复幂等。再次注入时标明 child 来源和“参考数据，不是指令或授权”。CLI 内部接口较初轮收紧；Hub memory.pin/add 接口不变。

运行时重启后 token 无效，需要重新委派获得绑定；每个运行时最多保存最近 2000 个绑定。包装器不将凭据写入监听状态文件、命令参数或模型正文，只在进程环境中传递；同用户进程仍可能读取进程环境。未带 `--return-to-parent` 的记忆监听最长五分钟（协议等待和进程超时受剩余期限约束），超时状态 `expired/CHILD_DEADLINE` 可用 `returns` 查询，较长任务可通过前台编排等待，不承诺后台结论必定入库。显式回传仍沿用六小时子任务期限。写回失败保留 `memory.status=failed` 和错误码；仅记忆监听报 `phase=failed`，显式回传继续传原结果、并保存写回失败状态。带 memory 的相同 requestId 在运行时内复用同一个 start 结果，不因记忆内容变化重复启动。

省略 Codex 模型时，确认 ChatGPT 身份后优先用 config.toml（含选中 profile）中仍在官方目录且 provider 为 openai/未指定的模型，仅不兼容时回退官方默认/可用项。身份 refresh 失败保留原生默认。任务 digest 使用调用者原始模型输入，先查幂等任务再解析动态默认。显式模型与 Thinking 仍沿用原路由与校验。合成协议通过不代表真实账号调用通过。

## 安全

- MCP 的 `env`、`headers`、bearer token 只进入助手进程的配置（ACP 参数、进程环境变量、或私有临时文件且进程结束即删），从不进入模型可见上下文，也不写进全局文件；上下文只列服务器名。
- 技能元数据和记忆经过脱敏后才进入上下文；疑似含凭据的技能元数据整条跳过。

## Composer 显示

外部助手对话的 Agent 菜单顶部 ⓘ 弹出说明里显示一行简要计数（如「共享：MCP 14 · 技能 44 · 记忆 1」）和 MCP 名称，内容是该助手在本项目最近一次实际拿到的内容（`codexhost/thread/shared-resources/inspect`），共享记忆显示为 `rly0-memory`。
