# 共享 Codex 的 MCP / 技能 / 记忆给其他助手

## 设置

RLY/0 Hub →「AI 助手」页底部有三个开关，保存在 `<RLY/0 数据目录>/shared-resources.json`（`{ version: 2, mcp, skills, memory }`）：

| 开关 | 默认 | 说明 |
| --- | --- | --- |
| MCP 服务器 | 开 | 把 `~/.codex/config.toml` 的 `mcp_servers` 作为原生 MCP 配置交给助手进程。带 `enabled_tools` / `disabled_tools` / OAuth / scopes 的服务器不转接（无法保真翻译）。 |
| 技能 | 开 | 技能索引（名称、描述、SKILL.md 路径）作为参考上下文，助手自己去读文件；元数据疑似含凭据的技能跳过。 |
| 记忆 | 关 | 当前项目的 `.rly0/shared-memory.md`、Codex 记忆里 `applies_to` 匹配本项目的分组（最多 2 组）和「User preferences」。过滤只去掉常见令牌格式和凭据赋值行，不能保证没有其他隐私，而且内容会发给其他厂商的模型，所以默认关闭，由用户决定开启。 |

0.11.12-preview.1 的单开关文件 `{ enabled }` 视为用户的明确选择，按它设置三项；没有文件时用上表默认值。

助手每次开启会话或发送消息时都会重新读取设置，所以不需要重启 Codex（也不走 codex-apply：这些设置由 Host 在调用各 Adapter 时读取，与官方 app-server 无关）。已经打开的 Claude / Grok 会话里已挂载的 MCP 不会立即撤销，重新打开会话后生效。只有本机 Host 提供共享；远程 Host 不会收到。

## 各助手能接收什么

由 Adapter 向 Host 声明请求（`SharedResourceRequest`），Hub 表格（`RLY0_HUB_AGENTS[].sharing`）与之由测试保持一致：

| 助手 | MCP | 技能 | 记忆 | 方式 |
| --- | --- | --- | --- | --- |
| Claude Code | ✓ | ✓ | ✓ | SDK `mcpServers` + `systemPrompt.append`；Claude 隔离模式开启时都不共享 |
| Grok | ✓ | ✓ | ✓ | ACP `session/new`/`load` 的 `mcpServers`；技能和记忆随每条消息附在请求前 |
| Antigravity | ✗ | ✓ | ✓ | 命令行接入无法挂载 MCP，只附参考上下文 |
| OpenCode / Pi / Hermes / Cursor / Kiro | ✗ | ✗ | ✗ | 接入暂不支持 |

## 安全

- MCP 的 `env`、`headers`、`bearer_token_env_var`、`env_http_headers` 只进入助手进程的 MCP 配置，与 Codex 自己启动 MCP 的方式相同；模型可见的上下文只列服务器名。
- 记忆和技能元数据经过 `secret-redaction.ts` 过滤后才进入上下文。

## Composer 显示

外部助手对话的 Agent 菜单顶部显示一行「这个助手在本项目收到的 Codex 资源：MCP n 个（名称）· 技能 n 个 · 记忆 n 段」，数据来自 Host 记录的该助手在该项目最近一次实际拿到的内容（`codexhost/thread/shared-resources/inspect`）；还没有记录时显示按设置将共享什么。
