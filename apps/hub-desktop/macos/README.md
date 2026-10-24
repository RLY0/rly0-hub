# RLY/0 Hub macOS 开发包

这是 macOS 12+ 的独立 Hub 壳开发入口，默认 Apple Silicon（M 系列），另提供 Intel x64 开发构建入口。两种架构都尚未经过 Mac 编译或真机验收，不是正式 Mac 安装包。复用当前 `www` 页面、品牌素材和真正的 Hub service，不重新实现业务或使用假服务。Intel 壳能否构建与运行不证明当前 Codex Desktop 在 Intel 上受支持。

## Windows 上准备

在 Hub 仓库执行：

```powershell
node scripts/release/macos/hub-dev-kit.mjs --prepare-only --output build/macos-hub-kit-001
node scripts/release/macos/hub-dev-kit.mjs --prepare-only --arch x64 --output build/macos-hub-intel-kit-001
```

输出目录必须是新的目录。此命令离线打包页面与后台，并复制原生源文件和构建脚本；不会下载 Node、编译 Swift、安装或启动 Hub。`kit-manifest.json` 记录文件 SHA-256 与未运行的验证项。生成目录失败时保留现场，改用新的目录重试。

## 在 Mac 上构建

需要与开发包架构相同的 macOS 主机、已安装的 Xcode Command Line Tools、同架构 Node.js 22 或 24。Node 必须是仅依赖系统动态库的独立发行版本，不能只复制依赖 Homebrew 外部库的可执行文件。脚本会核对主机、Node 与包的目标一致，拒绝架构不匹配；不会安装依赖。将开发包复制到 Mac 后执行：

```bash
bash build-on-mac.sh /absolute/path/to/node
```

也可在完整仓库运行 `node scripts/release/macos/hub-dev-kit.mjs --output build/macos-hub-kit-001`（Intel 添加 `--arch x64`）。产物是 `RLY0 Hub.app` 与相应架构的 `.app.zip`，仅 ad-hoc 签名；不含 Developer ID 签名、公证、正式更新清单或发行许可材料，不能作为正式发行包。`native-build-result.json` 只在编译、签名验证及压缩都成功后生成；这不表示已经启动或验收。

## 开发运行边界

- 原生 AppKit/WKWebView 壳仅负责本地资源、窗口缩放、后台进程和页面通信；后台仍通过 stdio 处理固定方法，不监听网络端口。关闭窗口后可从 Dock 或应用菜单重新打开；退出时关闭所启动后台的输入并停止该后台。崩溃后不自动重发请求。
- 页面只加载 `rly0-hub://local/` 中的白名单类型文件，拒绝路径越界、远程页面、弹窗和 HTTP(S) 资源。只有主框架的精确首页来源可提交请求；页面通信沿用 Windows 的请求编号、方法形状和大小限制。后台不是可供外部网页调用的服务。
- 此批次固定使用 `~/.rly0-hub-macos-dev/` 作为开发 HOME，另设 Codex、Claude、Hub 与 Core 数据位置，不导入日常历史或配置。构建脚本不会打开应用。仍需在 Mac 上验证整个进程树、所有管理操作及外部 CLI 是否遵守隔离目录，验证前不要登录或导入真实凭据。
- 不包含 `rly0-core`、原生 Codex 启动器或自动安装器。依赖这些组件的账号、额度、中转与启动操作不代表已可用；服务现有的不可用/不支持结果保持原样。Core 源码已补 Mac Keychain 加密预览，默认关闭且没有编入本源包，不能用明文替代。Claude 的 macOS Keychain 登录位置还未适配。服务已增加 Mac 应用包内 CLI 定位及捆绑 `bin/codexhost` 启动入口；开发包不包含启动器，因此仍报告不能打开 Codex。重启/强退尚未开放 Mac 支持。
- 待完成：Keychain 安全保存与审查、Core Mac 构建、Codex 启动/入口集成、菜单栏常驻与通知、截图、自启、更新及正式签名公证。Windows 的构建、安装和发布入口保持原有流程。

## Mac 真机验收

先核对开发目录隔离，再检查：Swift 编译、捆绑 Node 启动、本地首页显示、中文往返、缩放、关闭与重开、重复启动、后台断线错误、退出后所启动子进程清理、远程导航/弹窗/下载拒绝、路径穿越与指向目录外的符号链接拒绝。真机结果逐项记录，任何 Windows 单元测试都不能替代这些结果。

当前原生壳仅自检，尚未独立安全审查；账号和更新的真实测试、安装发布另行验收。

Core 安全保存的开发实现和原生测试说明位于 Core 仓库的 `docs/macos-secure-store.md`。不在 shell 中继承 `RLY0_MACOS_SECURE_STORE_PREVIEW`，因此真实账号功能不会因本开发包自动启用。

如需把Hub与Core源码一起交给Mac验证，使用[组合验证包](validation/README.md)入口。组合包包含私有源码，仅供本地交接，不上传；构建脚本运行合成检查后仍不启动应用或开放真实账号。
