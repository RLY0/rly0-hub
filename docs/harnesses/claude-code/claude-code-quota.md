# Claude Code 额度（5 小时 / 7 天）与手动刷新

Claude Code Thread 的 Composer 有两处额度展示：

- **Usage 胶囊**（`CH 99.9% · $11.015`）：折叠态只显示缓存命中率和会话费用；Popover 中在有数据时额外显示「5 小时额度已用」「7 天额度已用」两行（含重置时间），以及「额度 · 更新于 … / 刷新」一行。
- **额度胶囊**（环形剩余百分比）：只在 `accountCredits` 存在时显示；没有数据时隐藏，不显示“未知”占位。

## 数据来源

| 来源 | 何时 | 代价 |
| --- | --- | --- |
| 原生 `rate_limit_event`（`rate_limit_info.unifiedWindows`） | 每次模型响应后由 Claude Code 推送 | 无额外请求 |
| 原生 `/usage` 读取（SDK `get_usage` 控制请求，`Query.usage_EXPERIMENTAL_…`） | 仅用户点击「刷新」 | 不发模型请求；CLI 读取 claude.ai usage 接口 |

Adapter 在账号级缓存最新窗口（`#latestPlanLimit`），推送到所有打开的 Session，并由 `credits()` 投影成额度胶囊。手动刷新由 [`plan-usage.ts`](../../../packages/adapters/claude-code/src/plan-usage.ts) 负责：同一时刻只读一次，两次显式读取至少间隔 10 秒；被动调用（每次 Usage 检查）不读取。

## 为什么有时没有额度

Claude Code 只有在它自己认为是 claude.ai 订阅登录时才解析 `anthropic-ratelimit-unified-*` 响应头并发出 `rate_limit_event`（CLI 中 `isClaudeAISubscriber` = 未设置 `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` 且 OAuth scope 含 `user:inference`）。`/usage` 读取还要求 scope 含 `user:profile`。

- **Hub 保存的 Anthropic 官方 Key / 订阅令牌**（relay 条目 baseUrl 为 `api.anthropic.com`）：Host 用 `claudeCodeRelayEnvironment` 启动 Claude Code，`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/r/<id>`、`ANTHROPIC_AUTH_TOKEN=rly0-local-proxy`，真实密钥只在 rly0-core 本地代理中注入。Claude Code 因此不是订阅登录，**既不会发出 `rate_limit_event`，也无法 `/usage`**。额度改由 Host 通过 rly0-core `claude/keyInfo {relayId}` 读取（见下节）。
- **第三方中转**：`reason: "relay"`，中转没有订阅窗口，见下方余额设计。
- **`/usage` 回答 `rate_limits_available: false`**（API Key、用户自己设置的 `CLAUDE_CODE_OAUTH_TOKEN` 订阅令牌、第三方 Provider）：`reason: "notSubscriber"`。订阅令牌通过 `CLAUDE_CODE_OAUTH_TOKEN` 使用时仍会在发送消息后收到 `rate_limit_event`，届时额度自动出现。

把订阅令牌改为 `CLAUDE_CODE_OAUTH_TOKEN` 直接交给 Claude Code 是 `claude setup-token` 的官方用法（CLI 输出 “Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>”），这样原生推送即可工作。但当前密钥由闭源 rly0-core 加密保存，Host 只拿到 `hasKey`/`keyMask`，且代理把它作为 `x-api-key` 发送；改走直连需要 rly0-core 提供“按需取出订阅令牌”或“透传 `anthropic-ratelimit-unified-*` 响应头”的接口，本仓库未实现。

## Hub 保存的官方 Key / 订阅令牌的额度

[`claude-key-quota.ts`](../../../packages/host-runtime/src/rly0-relay/claude-key-quota.ts) 以 `claudeCode` relay 选择（官方 Anthropic 条目，按 relay id + keyMask 区分令牌）为键调用 rly0-core `claude/keyInfo`：完整登录令牌走 OAuth usage 接口；usage 接口拒绝（401/403）、限流（429）、出错或返回看不懂时，rly0-core 改为发一个 1 输出 token 的模型请求并读 `anthropic-ratelimit-unified-{5h,7d}-*` 响应头（探测结果与成功读到的额度在 core 内按令牌缓存 60 秒）；usage 接口的 HTTP 状态码记在 `usageStatus` 供诊断，usage 接口 429 且探测也失败时报 `USAGE_RATE_LIMITED`（界面：“官方暂时限制查询，稍后点刷新”，对话框额度行同样显示）。失败原因以 `usageError`（`USAGE_NETWORK` / `USAGE_BAD_RESPONSE` / `USAGE_TOKEN_EXPIRED` / `USAGE_RATE_LIMITED`）返回，`usageHidden` 仅为兼容旧 Hub。

- 结果投影为额度胶囊（`accountCredits`，5 小时为主、7 天为 `productUsage`）和 Popover 的「5 小时 / 7 天额度已用」两行（合并到 Thread Usage 的 `planFiveHour*`/`planSevenDay*`），`quota.observedAt` 取 core 的 `fetchedAt`。
- 自动读取（被动 Usage 检查、打开 Thread）每个令牌至多 5 分钟一次，且不阻塞检查：后台读完后对打开的 Claude Code Thread 推送 `codexhost/thread/usage/updated`。
- 手动刷新（`refresh: "quota"`）立即读取并等待结果，Host 侧至少间隔 10 秒（Renderer 也有 10 秒冷却）；进行中的读取会被复用。失败记为 `failed` 并保留旧数字；普通 API Key 记为 `unavailable / notSubscriber`。
- Hub「账号」页的令牌卡片同样显示 5 小时 / 每周额度并可刷新；没有额度时按 `usageError` 说明原因（网络 / 官方返回异常 / 令牌失效）。

## 手动刷新契约

`codexhost/thread/usage/inspect` 的 `refresh` 可取 `exact`（打开 Popover 时的精确 Usage）或 `quota`（用户点击刷新）。结果中的 `quota` 为 `{ status: live | cached | failed | unavailable, observedAt?, reason? }`：

- Codex 官方 Thread：复用 `account/rateLimits/read`，`AccountRateLimits` 的 15 秒新鲜期即冷却。
- External Thread：Host 等待 Adapter 的 `refreshCredits({ explicit: true })`；返回空值记为 `failed` 并保留旧额度与旧时间；Adapter 的 `creditsUnavailableReason()` 给出 `notSubscriber`。
- Renderer：刷新进行中禁用按钮，结束后 10 秒冷却；失败显示「刷新失败 · 更新于 …」且保留已显示的数字。

## 中转余额（设计，未实现）

目标：中转 Thread 的 Composer 显示中转余额（如 `¥12.30`），而不是 5 小时 / 7 天窗口。

1. **数据**：rly0-core 已有 `relay/balance`（`Rly0CoreBridge.relayBalance`，返回 `balance`、`unit`、`todayCost`、`status`），Hub 设置页已使用。它是对中转站的余额查询，不发模型请求。
2. **Host**：`#claudeCodeQuotaBlocked === "relay"`（或其他 Agent 绑定了中转）时，在 Usage 检查中附带 `relayBalance: { amount, unit, todayCost?, observedAt }`；被动检查只读缓存，`refresh: "quota"` 时才调用 `relayBalance`，并沿用 30 秒以上冷却，避免频繁打到中转站。
3. **契约**：`threadUsageInspectionSchema` 新增可选 `relayBalance`（独立于 `accountCredits`，不混用“剩余百分比”语义）。
4. **Renderer**：额度胶囊在 `relayBalance` 存在时显示金额（无环形），Popover 显示余额、今日消耗、更新时间和刷新；余额获取失败时保留旧值并标记刷新失败。
5. **测试**：Host 用假的 `relayBalance` 覆盖缓存/冷却/失败；Renderer 覆盖金额格式与单位。
