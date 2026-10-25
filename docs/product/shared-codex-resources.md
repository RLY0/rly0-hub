# 打通设置：MCP / 技能 / 记忆给所有助手

## 设置

RLY/0 Hub 左侧「打通」（打通设置）一处管理：概览、MCP、技能、记忆、线程。概览有三个开关，保存在
`<RLY/0 数据目录>/shared-resources.json`（`{ version: 3, mcp, skills, memory }`）：

| 开关 | 默认 | 说明 |
| --- | --- | --- |
| MCP | 开 | MCP 页的列表（即 `~/.codex/config.toml` 的 `mcp_servers`，改动前自动备份）按各助手自己的方式挂上。带 `enabled_tools` / `disabled_tools` / OAuth / scopes 的服务器不转接（无法保真翻译）。 |
| 技能 | 开 | Codex 技能（`~/.codex/skills`）。能原生注册的助手直接注册文件夹，其余拿到技能目录（名称、说明、SKILL.md 路径）自己去读。 |
| 记忆 | 开 | 共享记忆 rly0-memory（见下）。能接 MCP 的助手（含 Codex 自己）可读写，其余只读到摘要。 |

迁移：没有设置文件时用上表默认值（新安装和 0.11.12 从未改过开关的安装都全开）。0.11.12 写下的 `version: 2` 文件保留其中的选择，缺少 `memory` 键时按当时的默认“关”处理；0.11.12-preview.1 的单开关 `{ enabled }` 仍按它设置三项。Hub 之后写 `version: 3`。

生效：助手每次开会话或发消息都重新读取设置。记忆开关改变时 Hub 同步 Codex 配置里的 `[mcp_servers.rly0_memory]`，再由 codex-apply 原地换 Codex 后台（回复中则等回复完），不需要手动重启。已打开的会话里已挂上的 MCP 在重新打开后更新。只有本机 Host 提供共享。

## 各助手怎么接

由 Adapter 向 Host 声明请求（`SharedResourceRequest`：`mcp` / `skills` / `memory` / `memoryMcp` / `skillFiles`），Hub 表格（`RLY0_HUB_AGENTS[].sharing.modes`）与之由测试保持一致。原生 = 走助手自己的接口、只作用于该进程；提示注入 = 参考文字放在请求前。

| 助手 | MCP | 技能 | 记忆 | 方式 |
| --- | --- | --- | --- | --- |
| Codex | 本身 | 本身 | 原生 | Hub 写 `[mcp_servers.rly0_memory]`（备份 + 原子写 + 重新解析校验）；关闭记忆时只删这一张表 |
| Claude Code | 原生 | 提示注入 | 原生 | SDK `mcpServers` + `systemPrompt.append`；隔离模式开启时都不共享 |
| Grok / Kiro / Kimi / Cursor / CodeBuddy / WorkBuddy | 原生 | 提示注入 | 原生 | ACP `session/new`/`load` 的 `mcpServers`；技能目录和记忆说明随每条消息附在请求前。Cursor 只给真实会话，不给检测和历史回放 |
| OpenCode | 原生 | 提示注入 | 原生 | 托管进程的 `OPENCODE_CONFIG_CONTENT`（OpenCode 与用户配置合并）：`mcp` 表 + `instructions` 临时文件，会话关闭时删除 |
| Pi | 原生 | 原生 | 原生 | 每个进程生成 `--extension`（`pi.registerMcpServer`，旧版无 MCP 时跳过）、每个技能一个 `--skill`、`--append-system-prompt` 记忆说明；文件在私有临时目录，进程退出即删 |
| Hermes | 全局（可选） | 原生 | 提示注入（摘要） | gateway 进程内 `PluginContext.register_skill` 注册技能；MCP 只能写全局 `~/.hermes/config.yaml` |
| Antigravity（agy） | 全局（可选） | 提示注入 | 提示注入（摘要） | agy 只读全局 `~/.gemini/config/mcp_config.json` |
| DeepSeek / ZCode / OMP / Qoder | 不支持 | 不支持 | 不支持 | 接入没有挂载入口，或参数未核实；表格写明原因 |

### 只能改全局配置的助手

Antigravity 和 Hermes 只从全局文件读取 MCP。概览底部每个一枚开关，**默认关**。开启时 Hub 先备份该文件（`.rly0-bak-<时间>`），只添加 `rly0-*` 条目：Antigravity 在 JSON `mcpServers` 里加键（文件含 `//` 注释时拒绝修改以免丢注释）；Hermes 在 `mcp_servers:` 下插入带标记的一段（缩进跟随文件，没有该键时补一个并标注），值用 JSON 流式映射。`env` / `headers` 带凭据的服务器**不写**进全局文件，页面列出被跳过的名称。关闭时只删除 Hub 写入的条目（记录在 `<数据目录>/bridge/global-blocks.json`）。MCP 列表或开关变化后已开启的块自动重写。

## 共享记忆 rly0-memory

- 实现：`packages/host-runtime/src/rly0-memory/`。无 SDK 的 MCP stdio 服务器（换行分隔 JSON-RPC），工具 `remember` / `recall` / `search` / `forget`，`initialize` 的 `instructions` 带一句使用说明（“开始任务时 recall，持久事实用 remember，不记密钥”）。发布包用 `node app/host-runtime.mjs --rly0-memory-mcp` 启动，源码构建用 `dist/rly0-memory/server-main.js`。环境变量只有 `RLY0_MEMORY_DIR` / `RLY0_MEMORY_AGENT` / `RLY0_MEMORY_CWD`，不含凭据。
- 存储：`<数据目录>/memory/records.jsonl`，每行 `{id, text, tags, agent, thread?, scope, project?, time, source?}`；追加写，跨进程锁文件 `.lock`（独占创建、15 秒过期、Windows 上 EPERM 视为占用重试）；`forget` 在锁内重写文件，正文真正离开磁盘。`audit.jsonl` 记录每次增删（不含正文，1 MiB 轮换）。
- 范围：`project` 以仓库根（最近的 `.git`）归一化，`global` 对所有项目可见；`recall` 返回本项目 + 全局，`search` 可选 `all` 跨项目。
- 限制：单条 4000 字、8 个标签（字母数字 `_ . : -`，32 字）、5000 条、16 MiB。
- 脱敏：写入和读出都过 `redaction.ts`：常见令牌格式、私钥块、URL 中的密码（移植自 agentmemory，见 NOTICE.md）、凭据赋值、连接串密码。只是有界防护，不能证明文本没有其他隐私。
- 导入：首次使用时只读复制 Codex 记忆（`MEMORY.md` 各任务组的偏好 / 可复用知识 / 失败教训，有 `applies_to: cwd=` 的归该项目；`memory_summary.md` 的 User Profile / preferences / General Tips 归全局），标签 `codex-import`，标记文件 `codex-import.json` 防止重复。Codex 自己的文件不改。
- Hub：记忆页可搜索、按范围筛选、添加（来源 `hub`）、删除（二次确认）、导出到 `memory/exports/`、打开文件夹（`memory.*` 方法）。

## 安全

- MCP 的 `env`、`headers`、bearer token 只进入助手进程的配置（ACP 参数、进程环境变量、或私有临时文件且进程结束即删），从不进入模型可见上下文，也不写进全局文件；上下文只列服务器名。
- 技能元数据和记忆经过脱敏后才进入上下文；疑似含凭据的技能元数据整条跳过。

## Composer 显示

外部助手对话的 Agent 菜单顶部显示该助手在本项目最近一次实际拿到的内容（`codexhost/thread/shared-resources/inspect`），共享记忆显示为 `rly0-memory`。
