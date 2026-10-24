# RLY/0 Hub 独立管理窗口

## macOS 开发壳（未验收）

`apps/hub-desktop/macos/` 提供 AppKit/WKWebView 的独立开发壳，复用现有页面和 stdio service；不是当前正式 Mac 产品。`scripts/release/macos/hub-dev-kit.mjs --prepare-only --output <新目录>` 可在 Windows 离线准备源文件、页面和实际后台 bundle，并记录 SHA-256 与 `not_run` 状态。默认 arm64，Intel 添加 `--arch x64`。开发包自带 `build-on-mac.sh`，使用与包和主机同架构的 Swift 和 Node 22/24 构建仅 ad-hoc 签名的 `.app`；不启动应用，不进入原有 release pipeline。

原生壳限制本地资源路径、来源主框架、请求形状和大小，屏蔽远程资源与导航，复用页面既有 bridge API；后台退出时返回不可用并且不重发请求。开发运行使用独立 HOME 与 Codex/Claude/Hub/Core 目录。未捆绑 Core；Core 源码中的 Mac Keychain 加密预览默认关闭，尚未原生验证或独立复核，不回退到明文。已有 Windows 更新器不因此获得 Mac 支持。

Mac `locateOfficialCodex` 只读查找指定 `.app` 或 `/Applications/Codex.app`、`~/Applications/Codex.app` 的新嵌套/旧平铺 CLI；要求解析后仍在包内、可执行位与 Mach-O 标头。指定无效路径时不自动选择别的安装；这不是签名/官方身份或架构兼容性的证明。Mac `Rly0CodexControl.open` 仅在安装根有 `bin/codexhost` 时调用原生启动器，源码包未包含该文件时报告不可用；Mac 的强退和重启仍未接通。Intel Hub 壳与当前 Codex Desktop 的 Intel 支持分别验证。

状态与 Mac 验收清单见 [macOS 开发包说明](../../apps/hub-desktop/macos/README.md)。Swift 编译、WKWebView 行为、目录隔离、子进程清理与真实账号均须在 Mac 上验证；仅有 Windows 合成测试不能放行。原生通信尚未独立安全审查。

`scripts/release/macos/validation-kit.mjs` 可离线生成仅供本机交接的组合验证包：复用Hub开发包，并按限定文件类型/路径复制私有Core源文件、清单、锁与验证说明，记录两仓提交及是否存在本地改动。包内验证器逐文件核对SHA-256、拒绝路径越界/重复路径/链接与目标架构不一致；主脚本在Mac检查工具链，分别验证Core与构建Hub，结束再次核对源码。只有全部通过才写汇总，窗口运行/持久Keychain/真实账号/独立审核仍not_run。此包不含依赖缓存、Core可执行文件或正式安装器，不自动上传或启动。

管理入口位于 `bin/rly0-hub.exe`：C#/WebView2 壳加载 `app/hub-ui/`，并以捆绑 Node 启动 `app/hub-service.mjs`，通过 stdio 请求固定方法。Codex 不运行时也可以管理 MCP、Skills、本机会话、诊断、Hub 缓存、网络代理和更新检查。

## 入口与回退

Codex Renderer 通过 `codexhost/rly0/hub/status` 查询安装目录下的 Hub 可执行文件是否存在。检测本身不启动进程。存在时，左键 RLY/0 rail 按钮打开独立 Hub；欢迎自动打开逻辑也只打开独立 Hub。打开失败或检测请求失败不会弹出旧设置页。

只有 Host 明确报告 Hub 不存在时才提供完整嵌入设置，供源码运行和没有 Hub 壳的平台使用；这些构建不自动弹出旧欢迎设置页。

存在 Hub 时，右键 RLY/0 按钮打开精简的 Codex 内工具；AI 助手选择器的管理入口仍可打开连接页。保留范围：

- 连接、Host 诊断、自定义 Harness 启动命令：依赖运行中的 Host、插件注册表及发现/重启流程。
- 原生账号连接、凭据导入和浏览器添加账号：依赖 app-server 身份及登录生命周期。已保存的 RLY/0 账号列表、切换、重命名和移除由 Hub 管理；此处仅保留添加账号流程及原生 Host 账号能力。
- 会话导入：依赖已加载 Adapter、映射存储及导入后的 Codex Thread 导航。复用原有 Harness 会话导入链路，不新增解析器。
- Codex 界面偏好、已加载会话、额度提示参数：属于 Renderer 本地状态及运行中会话。Hub 自启和网络代理转到 Hub 设置。

聊天、多 Agent、`#` 委派、模型菜单和额度 pill 的现有入口不经过本次管理迁移。

## 独立管理方法

方法名遵守 C# 壳的 `^[a-z]+(\.[a-zA-Z]+){1,2}$` 限制。参数复用 shared-contracts 的 strict Zod schema。错误响应只含稳定代码；MCP 解析错误不把 TOML 片段带到页面。

| 方法 | 归属与约束 |
| --- | --- |
| `mcp.list/add/setEnabled/remove` | `Rly0McpManager`；仅修改目标 MCP 配置，沿用原子写入与备份。 |
| `skills.list/import/deactivate/restore` | `Rly0SkillsManager`；导入本地含 `SKILL.md` 的目录，停用移入备份，可恢复。 |
| `threads.list/listTrash/trash/restore` | `Rly0ThreadsManager`；最多展示最新 500 条，复用 rollout 头部解析与路径检查，回收站可恢复。操作前结束相关会话。 |
| `maintenance.diagnostics/exportDiagnostics/cacheInfo/clearCache` | `Rly0MaintenanceManager`；诊断只检查登录文件是否存在，不读取其内容；导出脱敏诊断到本地，只清理 Hub 固定的 `cache`、`tmp` 目录。 |
| `window.capture` + `maintenance.exportFeedback` | “反馈问题”：C# 壳用 WebView2 `CapturePreviewAsync` 把当前页面存为 `diagnostics/feedback-yyyyMMdd-HHmmss/screen.png`（与服务同一数据目录，`CODEXHOST_DATA_DIR` 优先），只回传文件夹名；服务只接受 `^feedback-\d{8}-\d{6}$` 的文件夹名和至多 50 条、每条至多 500 字的页面错误，脱敏后写 `diagnostics.json`、`errors.json`。截图失败时页面自己生成文件夹名，其余照常保存。`maintenance.openDiagnosticsFolder` 可带同样格式的 `folder` 打开该报告。 |
| `maintenance.chatRepairScan` / `maintenance.chatRepair` | `ChatRepair`（`rly0-maintenance/chat-repair.ts` + `chat-health.ts`）：“修复聊天记录”检查所有聊天并按原因分组返回 `groups`（`kind`/`count`/`archived`/`repairable`/最多 20 条 `items`）和 `checked` 数量。原因：旧版 CodexHost 未搬/较新/已删（`legacy-*`）、模型设置是上游格式（`format`，Codex 启动时由 Host 转换）、Hub 记录损坏且备份可用（`record-damaged`，修复时用 `mapping-store/backups` 恢复）或不可用（`record-lost`）、创建未完成（`stuck-creating`）、Claude Code 自己的对话文件已不在（`session-missing`，`~/.claude/projects`；隔离模式下不检查）、Codex 列表指向的 rollout 不在（`codex-rollout-missing`）、建聊天的服务商已不在配置（`codex-provider-missing`）、rollout 不在 Codex 列表（`codex-unlisted-rollout`）。Codex 的 `state_*.sqlite` 只复制到临时目录后读取；助手和 Codex 自己的文件从不写。修复只在有可修项时进行：关闭 Codex → 把 `mapping-store/threads`、`backups` 复制到 `<数据目录>/chat-repair-backups/<时间>/`（复制失败则不写任何东西）→ 恢复/合并 → 重新打开 Codex；不删除任何记录。 |
| `maintenance.forceQuitCodex/restartCodex` | `Rly0CodexControl`；从运行描述符取得启动器 PID 和本次 nonce，提交启动器控制请求。只控制 RLY/0 启动器管理的 Codex，返回 `ok` 表示请求提交，不代表进程已完成退出/重启。 |
| `codex.applySettings` / `codex.applyCancel` | `Rly0CodexApplier`（`rly0-hub-service/codex-apply.ts`）：Hub 写完 Codex 设置后让它自己生效，页面不再提示“重启 Codex 生效”。`scope: "backend"`（MCP、换模型、恢复备份）先请 Hub 打开的 Codex 原地换后台（回复中则回复完再换）；`scope: "window"`（不登录 OpenAI 模式、Claude 隔离）需要 Codex 重新打开：Codex 心跳的 `busy` 为假时立即经启动器重启，为真时等任务结束再重启（最多等 30 分钟，可取消）。Codex 未打开返回 `notRunning`（下次打开读取）；心跳不报 `busy`（旧版或非 Hub 打开）时不盲目重启，返回 `needsRestart`，页面给一次“立即应用”（`restartNow`）。 |
| `proxy.settingsGet/settingsSet` | 核心服务代理设置；同时用于 AI 助手下载和 Hub 自身更新。 |
| `updates.check` / `updates.status` | 读取安装包版本元数据，经 `Rly0HubReleaseSource` 查最新发布并比较版本；不需要 app-server 或启动器控制参数，不下载安装。 |
| `updates.install` / `updates.progress` | `Rly0HubUpdater`：下载安装包、校验 SHA-256、静默运行安装器（见下节）。 |

外部网页只能通过 `links.open` 的固定目标枚举打开。Node.js 官网、项目发布页等地址由服务端 `RLY0_HUB_LINKS` 决定，页面不能提交 URL。

## Hub 自身更新

- **查询**：先取 `https://github.com/RLY0/rly0-hub/releases/latest/download/latest.json`（发布时随安装包上传，走下载 CDN，不占 GitHub API 每小时 60 次的匿名额度）；缺失或校验不过时再查 `api.github.com/.../releases/latest`，取安装包资产的 `digest`。`latest.json` 严格校验：只允许 `schemaVersion/version/name/size/sha256/publishedAt/notes`，`name` 必须是 `RLY0-Hub-<version>-setup.exe`，`sha256` 为 64 位小写十六进制；下载地址由版本号拼出，不取自清单。生成脚本：`scripts/release/hub-latest-manifest.mjs`。
- **复用**：检查和“立即更新”共用一份结果；一小时内点更新不再查询。强制检查（`force`）总是重新查询。
- **代理**：设置→网络代理选“直连”不走代理，“自定义”用填写的地址；“跟随系统”依次用 `HTTPS_PROXY`/`ALL_PROXY`/`HTTP_PROXY`（`NO_PROXY` 含 github.com 时直连）和 Windows 系统代理（HKCU Internet Settings 的 `ProxyEnable`/`ProxyServer`）。只支持 HTTP(S) 代理（CONNECT 隧道），仅用 Node 内置模块，不给服务包加依赖。
- **下载**：固定的 `RLY0-Hub-<version>-setup.exe.partial`，重试时用 `Range` 续传（服务器不支持则重下）；结束后必须 SHA-256 一致才改名并运行，不一致删除该文件并报 `UPDATE_VERIFY_FAILED`。
- **错误码**：`UPDATE_RATE_LIMITED`（API 403/429）、`UPDATE_NETWORK`（连不上，含代理失败）、`UPDATE_DOWNLOAD_FAILED`（下载中断，可续传）、`UPDATE_VERIFY_FAILED`、`UPDATE_CHECK_FAILED`（其他查询失败），页面各有中文提示。

## Windows 安装依赖

安装器在继承的 PATH 之外检查 Program Files 下的 Node.js/Git、APPDATA 下的 npm、用户 `.local/bin`、LOCALAPPDATA 下的 Node.js 和 WindowsApps、NVM 链接等常见路径。检测 CLI 的 `detectionCommand` 与交互登录的 `loginCommand` 独立；DeepSeek 使用 `dsh` 判断安装状态，不提供虚构的登录能力。

npm 安装需要同时找到 Node 和 npm，缺少时尝试固定的 `winget install --id OpenJS.NodeJS.LTS`。安装后重新检测，必要时只刷新注册表的用户/系统 PATH；winget 的成功退出码本身不代表依赖可用。winget 不可用、网络、权限、安装失败或安装后仍未检测到依赖时，Hub 显示中文原因及固定的“下载 Node.js”入口。安装或登录只在用户点击相应操作后发生。

## 页面与验证

“找回可查看历史”与原生聊天修复分开：`maintenance.chatRecoverReadable` 启动后台只读任务，`maintenance.chatRecoverStatus` 提供进度与结果，`maintenance.openRecoveredHistory` 只打开本次或上次完成任务的固定本地索引。它使用复制后的 Codex SQLite（`sqlite_home > CODEX_SQLITE_HOME > CODEX_HOME`）和本地 sessions/archived_sessions 的 plain/zstd 文件，将旧 provider、路径移动及未列入当前索引的文件中可读取的用户/助手文本生成私有 HTML 副本。保留原归档和来源，不写原始 SQLite/JSONL、配置或服务商，不关闭 Codex，不调用模型，不称原生列表或原对话续聊已恢复。不能把当前配置未列出 provider 当作正文损坏，也不能把当前 Claude 目录未找到当成永久丢失。

恢复结果存放数据根下 `chat-recovery/recovery-XXXXXX/`，沿用私有目录 ACL、独占临时文件和原子写入。SQLite/WAL 临时目录在复制前设私有 ACL，通过独占新文件流复制，避免继承来源 ACL；合计超过 256 MiB 或查询超过 20,000 行即报告未读，查询列长受限。HTML 对内容转义并禁止脚本、网络和表单；仅接受用户 input_text 以及 phase=final/commentary 的助手 output_text，不明旧格式明确跳过并标部分，隐藏推理、analysis 阶段及工具内容不导出，附件不承诺完整；会话标识不一致单独警告。

单文件可见文本 8 MiB、解码 256 MiB、单行 4 MiB，单任务可见文本 64 MiB、解码处理预算 2 GiB、逐块检查 120 秒工作预算、最多处理 500 文件。目录发现使用流式枚举，最多访问 20,000 项、收集 10,000 路径；截断明确显示 scanIncomplete。因限制未处理、文件/格式失败、原文件未定位到分别计数，不能将限制当作内容丢失。缺失原文件仍需原文件或备份。清缓存不删除这些私有恢复结果，也不会自动加入反馈包或发布包。

额度数字采用本地快照先显示、原查询时间不变、随后更新的方式。Claude/Grok 网页登录沿用 core 的 lastUsage；Claude 订阅令牌的规范额度另保存在 official-key-usage.json，只含 relay id、加密凭据文件版本和规范化额度，不保存令牌、邮箱或 profile。版本由 core 对同一份加密 blob 求 SHA-256，改名不变，替换/清除密钥后原快照不再匹配。保存联网结果前重查版本并排除同 id 的旧请求；同版本不允许旧 fetchedAt 覆盖新记录。缺少版本的旧 core 不附令牌缓存，未成功查询或无额度接口时保持未知/不支持。

Gemini 的上次 /usage 结果保存在 antigravity-usage.json。agents.antigravity.cached 不等待安装检测、不运行 CLI；首屏与 status 并行。磁盘或被动返回的额度标记 observationOnly，仅显示为“上次查询”，不作为当前登录身份或“使用中”的证据。后台不自动启动可能触发 OAuth 的 agy；用户刷新后才确认本次观测，明确未登录时清除旧额度。数值以外的缓存保存失败会明确提示，失败不伪造零额度。

这两类新快照只写入应用数据根下专用的 quota-cache 子目录。写前限制目录权限：Windows 使用受保护的 ACL，仅当前用户和 SYSTEM 可访问；其他系统使用 0700。临时文件独占创建并原子改名，不修改用户数据根的 ACL。权限或保存失败不影响本次真实查询结果，但明确提示缓存未保存。

账号与中转的本地元数据由独立的只读 core 子进程读取，使用同一数据目录，不复制账号或凭据。只有 accounts/list、accounts/current、claude/list、grok/list、relay/list 走此通道，额度/验证及全部写操作保留在原进程。保存、切换、改名和删除后的列表读取等待原操作的实际响应；调用方超时不解除等待，进程退出或响应到达才解除。关闭和重启同时管理两个子进程。额度查询可以仍在进行，列表先显示已完成的本地快照及原查询时间；不把旧额度伪装成刚刷新。

Gemini 首屏直接读取 Antigravity 状态，不再等待所有助手的检测。令牌卡片先显示本地名称和脱敏信息，再补联网详情。网页登录账号沿用本地别名；订阅令牌和 API Key 通过 officialKeys.rename 保存所属凭据名称，校验 vendor/id，只更新名称，不切换身份或重写密钥。名称编辑支持中文输入，失败后可重试。

0.11.8：Anthropic 凭据按 core relay id 分卡存储。`officialKeys.set` 不带 id 新增、带 id 仅替换对应项；core 以完整密钥比较去重，不依赖末四位。新增和导入不改当前绑定；`officialKeys.select` 才改变 Claude Code 后续新会话使用的凭据。info/remove 校验 vendor 和 id，正在使用的令牌须先切换再删除。AI 助手的选择器也按 id 列出所有令牌。原有单凭据和 OAuth 记录不迁移。

Codex 模型目录保留官方原条目，每个已启用中转模型另用 `rly0/<relayId>/<model>` 作稳定选择标识，展示站点名和原模型名。core 每次校验目标中转仍启用、有密钥且声明该模型，然后仅在出站副本将 model 改回上游名；不可用时拒绝，不回退其他中转或官方。Host 路由判断失败必须回错误，不转发原始请求。不同 provider 的对话切换继续遵守原有新建对话边界，不静默重定向。

`.app` 的网格行限制在窗口内，`.stage` 和 `#page` 允许收缩，页面内容在 `#page` 内滚动；菜单自身也能滚动，支持壳的最小窗口。新管理页面位于 `www/pages/resources.js`、`system.js`，mock 数据位于 `mock.js`，由 `index.html` 的同源脚本加载，保持 CSP `script-src 'self'`。新增资源同时列入 Windows payload 清单。

后端测试使用隔离的临时 HOME、CODEX_HOME 和 Hub 数据目录；安装分支使用虚拟 runner。浏览器 mock 预览可验证页面交互和滚动，但不代表 C#/WebView2、真实安装、登录或启动器进程控制验收。

## 额度重置卡

重置权益属于账号所属平台，不属于助手程序。账号与令牌卡使用同一个额度组件，始终显示重置卡状态：Codex 显示接口返回的张数，未知不当作零；Claude 显示“官方查看”；Gemini/Grok 未核实到使用接口时显示“未接通”；普通 API Key 显示“不适用”。Pi、Hermes 等复用哪个平台账号，就受该账号权益范围约束，不能跨平台套用卡片。

Codex 已保存账号的 `accounts.resetPrepare` 读取官方卡库存，用户确认后 `accounts.resetConsume` 提交明确的卡 ID 和 UUID 请求；不切账号、不刷新令牌、不改写额度为 100%。仅调用固定 ChatGPT 官方地址，不接受页面或环境覆盖消费目标，不跟随重定向、不自动重试 POST。契约依据 [官方 App Server 文档](https://learn.chatgpt.com/docs/app-server#8-earned-rate-limit-resets-chatgpt) 和 openai/codex `a6839a48` 的 backend-client 实现。只有 `reset/alreadyRedeemed/nothingToReset/noCredit` 为已知结果，未知响应保留待核实。

core 在账号存储目录用 DPAPI 加密保存使用账本，POST 前必须落盘；跨进程 OS 文件锁防止同时提交。未知结果保留原账号、卡 ID、请求 ID 与凭据版本；页面重开或缓存清空后从后台找回，拒绝新请求越过未确认记录。官方成功但 RPC 丢失时，终态记录也保留，直到页面接收结果并用 `accounts.resetAcknowledge` 确认收据。终态重试从账本返回，无额外 POST。凭据版本变化、账本不可读/不可写时停止，不消耗另一张卡。此状态可能需要在官方页面核实，不能自动清除未确认记录。

卡片上的“使用”只在张数大于 0 时可点；0 张时按钮禁用并写明原因，张数未知时显示“核实”。点“使用”只打开确认框（不消耗），框内写明账号、消耗 1 张（现有/用后张数）、要重置的额度窗口及当前剩余，焦点默认在“取消”；确认后显示进度和结果，成功后刷新额度。首页当前账号已保存时同样提供这个入口。

使用后查询真实额度；刷新失败保留提示，不能以消费接口成功替代额度到账证明。Claude 的 Code OAuth/Setup Token 不等于浏览器登录，Hub 仅通过固定 `https://claude.ai/settings/usage` 打开官方重置入口，提示核对网页账号；这不称为 Hub 内直接消费，也不显示未经验证的张数。[Claude 官方说明](https://support.claude.com/en/articles/17007452-what-is-a-limit-reset) 当前将重置使用限定在网页/Claude Desktop。Gemini/Grok 全部可在 Hub 直接重置仍未完成。

## 额度快用完时自动切换账号

账号页每个服务商标签都有同一张“额度快用完时自动切换账号”卡片（`pages/account-cards.js` 的 `autoSwitchCard`），全部默认关闭，阈值与“到阈值时（先提醒我 / 直接切换）”控件相同。托盘每 5 分钟的 `alerts.check` 顺带检查，提醒复用托盘气泡。

- Codex：`accounts.autoSwitchGet/Set`（`auto-switch.ts`），见上文账号切换；切换后原地换后台或重启。
- Claude / Grok：`agents.autoSwitch.get/set/apply`（`agent-auto-switch.ts` 判定与执行，`agent-auto-switch-sources.ts` 取候选与切换，`agent-auto-switch-routes.ts` 路由与按智能体保存在 `hub-desktop.json` 的 `agentAutoSwitch`）。第一次打开要在确认框里确认“自动轮换订阅账号可能违反 Anthropic / xAI 使用条款、有被限制或封禁的风险”（`acceptRisk`，记为 `riskAccepted`，之后再开不再询问）；未确认时服务拒绝开启（`AUTO_SWITCH_RISK_NOT_ACCEPTED`），文件里的 `enabled` 没有确认也视为关闭。
  - Claude 候选：已保存的 Claude 账号 + 已保存的订阅令牌（`officialKeys`，API Key 没有额度不参与）。正在用的凭据由 AI 助手的中转绑定决定：未绑定时是当前登录的账号，绑定到某个订阅令牌时是该令牌，绑定到其他中转时不检查。切换走页面同一路径：账号用 `agents.claudeAccounts.switch`（并清除绑定），令牌用 `agents.officialKeys.select`。窗口：5 小时（`primary`）与每周（`secondary`）。
  - Grok（测试版）：已保存的 Grok 账号，当前登录即正在用的；一个额度窗口（`weekly` / `monthly` / `credits`）按“每周 / 每月额度”阈值判断，切换用 `agents.grokAccounts.switch`。
  - Gemini（Antigravity）：登录只有系统钥匙串里与桌面版共用的一份，卡片保持关闭并写明原因。
- 规则：平时只读正在用的凭据的额度；低于阈值时再刷新全部候选，只在本次读到额度的候选中挑选，读不到或失败的从不切换过去。目标在每个窗口都要比阈值多 10 个百分点（防止两个账号来回切），同一账号/窗口/重置时间只提醒或切换一次，自动切换后 30 分钟内只提醒不再自动切。切换不重启任何程序，只影响之后的请求；Codex 心跳 `busy` 为真（有回复、工具调用或智能体任务在跑）时等它结束再切（最多 30 分钟），切换前重新读取额度。点托盘提醒（`action: "switch"` 且带 `agent`）由 C# 壳调用 `agents.autoSwitch.apply`。
