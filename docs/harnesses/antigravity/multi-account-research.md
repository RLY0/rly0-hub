# Antigravity（Gemini 标签页）多账号调研

状态：**多账号未实现**（有意为之）。Hub 的「账号 → Google · Gemini」只显示 Antigravity 当前登录的额度（`agy /usage`），并标「测试版」。本文记录结论的依据，以及装好 agy 后需要实测确认的事项。调研时本机**未安装** agy，结论来自官方文档、官方 README 与仓库内 Adapter 代码；第三方资料只作线索。

## 结论

| 问题 | 结论 | 依据 |
| --- | --- | --- |
| agy 把登录存在哪 | 操作系统钥匙串：Windows 凭据管理器、macOS Keychain、Linux Secret Service。无钥匙串时才可能退回文件。 | 官方文档 [Authenticate](https://antigravity.google/docs/install/)：“agy attempts to access your operating system's native secure keyring … Windows Credential Manager”；官方 README：“authenticates via the system keyring”。 |
| 登录是否和其他产品共享 | 是。Antigravity App、CLI、IDE 插件、SDK 共用一套本机认证。 | 官方文档：“Signing in on one local surface shares your credentials across your local environment.” |
| 有没有能换位置的 home / config 环境变量 | 官方文档没有任何改变凭据位置或 home 目录的设置。已知变量只有 `AGY_ADC_AUTH`、`GEMINI_API_KEY`（需配 `modelProvider`）、`GOOGLE_CLOUD_*`、`GOOGLE_GEMINI_BASE_URL`。 | 官方文档 Authenticate 页；官方 README 未列环境变量。 |
| 有没有 login 子命令 | 没有。首次运行需要模型的命令时自动打开浏览器（SSH 下打印链接并让用户粘贴代码）；`/logout` 清除钥匙串里的登录。 | 官方 README、Authenticate 页。 |
| 每个账号的官方额度来源 | 只有 CLI 自己的 `/usage`（`agy --print=/usage --output-format stream-json`），而且只针对**当前登录**。 | 仓库 `packages/adapters/antigravity/src/quota.ts`。 |
| 换号的官方方式 | 只有 `/logout` 后重新登录。 | Authenticate 页（切换项目也是“log out … and log back in”）。 |

第三方资料（社区 issue / PR，非官方）称 Windows 下凭据是凭据管理器里的通用凭据 `gemini:antigravity`，值为 JSON（含 access/refresh token 与过期时间），刷新需要 Google 的 OAuth client secret。我们**没有**打开或读取这个凭据。

## 为什么不做多账号

1. **没有可隔离的临时登录目录**：钥匙串条目是全局的，不随目录变化。像 Grok（`GROK_HOME`）或 Claude（`CLAUDE_CONFIG_DIR`）那样“在临时目录里登录、再保存快照”做不到——在 Hub 里登录另一个账号就会顶掉当前登录。
2. **切换要改第三方的钥匙串条目**：而且这份登录同时被 Antigravity 桌面版和 IDE 插件使用，切换会连带改变它们，影响面超出 Codex。
3. **非当前账号拿不到额度**：官方只有对当前登录生效的 `/usage`；续期 token 需要 Google 的客户端密钥，这不是 Hub 应该持有的东西。本机上的第三方多账号工具走的是非官方接口，我们不采用。

## 现在 Hub 做什么

- `agents.antigravity.status`：只看 agy 是否装了，以及上一次读到的额度（不运行 agy）。
- `agents.antigravity.cached`：立即读取本地已保存的额度，不等待 PATH/安装检测、不运行 agy。成功查询的额度可跨 Hub 重启保留；被动返回始终标为上次查询，不能证明当前登录还是同一账号。
- `agents.antigravity.usage`：用户点刷新时运行一次官方 `agy --print=/usage --output-format stream-json`（20 秒超时），按模型组显示 5 小时 / 每周额度。失败时保留上次的数字并标明；判断为未登录时清掉旧数字。实现：`packages/host-runtime/src/rly0-agents/antigravity-usage.ts`。
- 不自动读取：未登录的 agy 可能会自己打开浏览器开始登录。
- 首屏保留原 fetchedAt 并标明“当前登录尚未核实”；用户主动刷新才启动 CLI，未登录时清除旧额度。本地仅保存规范额度与查询时间，不保存钥匙串内容或原始 CLI 输出。
- 「网页登录」仍是在终端里打开 agy，让用户自己登录（会替换当前登录）。

## 装好 agy 后需要实测确认

1. `agy --print=/usage --output-format stream-json` 在**已登录**时输出含 `command_result`（`name: "usage"`）的一行，字段与 Adapter 测试里的样例一致（`groups[].buckets[].window / remaining_fraction / reset_time`）。
2. **未登录**时同一命令的行为：是直接报错退出（报错文字里有 sign in / authenticate / login 之类，Hub 据此显示“未登录”），还是会打开浏览器、阻塞到 20 秒超时。若会打开浏览器，需要找无交互的方式判断登录状态。
3. 在临时目录（`os.tmpdir()`）作为工作目录运行 `/usage` 时不会弹“信任此文件夹”之类的交互。
4. 凭据确实只在凭据管理器（用 `cmdkey /list` 看目标名，**不要**读取内容），`~/.gemini/antigravity-cli/` 下没有 token 文件；以及是否存在任何能改变凭据位置的环境变量或设置（新版 agy 的 `--help` / 官方文档）。
5. 若第 4 条发现官方提供了可改位置的设置（例如一个 home 目录变量，且钥匙串条目名随之变化），才可以按 Grok 的方式实现“临时目录登录 + 快照切换”，并且必须确认切换不会影响 Antigravity 桌面版和 IDE 插件。
