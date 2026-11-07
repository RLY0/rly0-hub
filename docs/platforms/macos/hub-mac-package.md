# macOS 独立安装包与功能测试台

> 状态：当前实现说明（RLY/0 Hub 0.11.36 起）

## 安装包

`node scripts/release/macos/package-hub.mjs --core <rly0-core> [--core-sha256 <hex>] [--sign -|<SHA-1>] [--payload <dir>]`
在 Apple Silicon Mac 上生成 `build/release/<版本>/macos-arm64/hub/` 下的 `RLY0 Hub.app`、
`RLY0-Hub-<版本>-macos-arm64.dmg` 与 `manifest.json`（逐文件 SHA-256）。

`Contents/Resources` 与 Windows Hub 的安装目录同构：

- codexhost 载荷原样放入：`bin/codexhost` 是真正的 Launcher（不带参数即打开 Codex，`inspect --json`
  供 Hub 的兼容检查），`libexec/`、`app/*.mjs`、`runtime/node`、`licenses/`；
- Hub 自己的部分：`app/hub-service.mjs`、`app/hub-ui/`、`mac-bridge.js`、`runtime/rly0-core`；
- `Contents/MacOS/rly0-hub` 是 Swift 窗口外壳，`AppIcon.icns` 由 `crates/launcher/assets/codexhost.png` 生成。

rly0-core 闭源、在其仓库单独构建；脚本逐字节复制并保留它原有的签名（已获得的钥匙串授权因此不变），
打包前校验 SHA-256 和签名。公开发布用临时签名（`--sign -`）；本机可用自己的签名身份。打包会拒绝
任何含构建机路径（主目录、仓库、外接盘）的文件，DMG 生成后用 `hdiutil verify` 校验。

没有 Apple 开发者签名：DMG 内的「首次打开必读.txt」说明用 `xattr -dr com.apple.quarantine` 放行。
Mac 版不能就地自动更新：Hub 照常检查新版本，更新提示在 Mac 上直接打开下载页。

## 窗口外壳（Rly0Hub.swift）的 Mac 行为

- 每次启动界面大小 100%；转发服务推送的 `quota` / `balance` 事件，窗口隐藏/显示时发 `visibility`；
- 启动后 1 分钟、之后每 5 分钟调用 `alerts.check`（余额/额度提醒与自动切换账号都在这里运行），
  提醒用系统通知显示，点通知执行与 Windows 托盘气泡相同的动作；
- 服务进程意外退出时最多自动重启 3 次；超过 64 KiB 的页面请求立即回 `REQUEST_TOO_LARGE`；
- 服务的 PATH 取自用户登录 Shell（5 秒超时，失败用常见安装目录），内置 Node 放在最后。

## 功能测试台（tests/e2e/hub-bench）

`HUB_BENCH_APP=<RLY0 Hub.app> npx playwright test --config tests/e2e/hub-bench.config.js`（需要
`npx playwright install webkit`）。每个测试用该 App 的真实 hub-service、真实 rly0-core 和 WebKit
中的真实页面；页面通信规则与 Mac 外壳一致（请求编号/方法名/大小限制、只转发 ready/quota/balance）。

隔离：每个测试一个临时 HOME（含临时钥匙串，经 `RLY0_CORE_KEYCHAIN_PATH`），服务运行在
`sandbox-exec` 里——本机回环只允许测试台自己的端口（Core 代理、合成中转站），外网默认禁止；不能给
其他进程发信号或发 Apple 事件，不能运行 `osascript`、`open`、`kill`、`security`、`/Applications`
里的程序和 App 自带的 Launcher；不能写真实主目录、外接盘、`/Applications`、`/Library`，真实的
Codex / Claude / Hub 数据与钥匙串目录不可读。全局 setup 记录运行前的 Codex、codexhost、Hub、Core
进程，结束时有任何变化即判失败。合成中转站（`fake-relay.mjs`）只响应合成密钥。
