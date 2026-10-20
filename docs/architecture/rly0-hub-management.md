# RLY/0 Hub 独立管理窗口

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
| `maintenance.forceQuitCodex/restartCodex` | `Rly0CodexControl`；从运行描述符取得启动器 PID 和本次 nonce，提交启动器控制请求。只控制 RLY/0 启动器管理的 Codex，返回 `ok` 表示请求提交，不代表进程已完成退出/重启。 |
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

`.app` 的网格行限制在窗口内，`.stage` 和 `#page` 允许收缩，页面内容在 `#page` 内滚动；菜单自身也能滚动，支持壳的最小窗口。新管理页面位于 `www/pages/resources.js`、`system.js`，mock 数据位于 `mock.js`，由 `index.html` 的同源脚本加载，保持 CSP `script-src 'self'`。新增资源同时列入 Windows payload 清单。

后端测试使用隔离的临时 HOME、CODEX_HOME 和 Hub 数据目录；安装分支使用虚拟 runner。浏览器 mock 预览可验证页面交互和滚动，但不代表 C#/WebView2、真实安装、登录或启动器进程控制验收。
