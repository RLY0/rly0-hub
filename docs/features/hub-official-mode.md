# Hub 官方原样（恢复纯净）

设置 → 官方原样 让 Codex 回到没装 RLY/0 Hub 时的样子，而不只是还原连接设置。

## 开启时做什么

`hub.restorePure`：

- 先把共享资源（MCP / 技能 / 记忆）三个开关和 Codex 更新管理的当前值记入 `hub-desktop.json` 的 `beforePure`（已在官方原样时不覆盖）；
- 关闭共享资源、统一渠道、免登录用中转，停止本机代理，按首次备份还原 `config.toml`（另一工具的本机代理默认 provider 会被去掉），关闭 Codex 更新管理；
- 写入 `pure: true`、`channelConsented: false`。

之后：

- `codex.open` / `codex.restart` 改用官方方式打开 Codex（`codex-stock-launch.ts`）：macOS `open -b com.openai.codex`；Windows `explorer.exe shell:AppsFolder\<AUMID>`，AUMID 取自 `Get-StartApps`，取不到时用执行别名目录的包家族名加 `!App`。不经 CodexHost Launcher，所以没有调试端口、`CODEX_CLI_PATH` 替身和页面注入，侧栏也不会合并其他助手的对话（数据仍在 Hub 的映射库里）。
- 是否在运行改看进程表：macOS 按 App 包，Windows 按 `WindowsApps\OpenAI.Codex_*` 下的主程序（不含 `resources` 下的 CLI）。非官方原样下，Launcher 之外打开的 Codex 也算运行，所以“重启 Codex”能把它换成经 Hub 打开的。
- Hub 启动不再起本机代理、不再写回 rly0 默认 provider；Hub 更新安装不关闭官方 Codex；切换账号直接重启 Codex（没有可重载的 Hub 端）。
- Hub 窗口启动时不弹必选的“开启 Hub 转发”，只显示灰色提示条和“重新开启 Hub”。

## 回到 Hub

`hub.enableChannel`（“重新开启 Hub”，或首次运行对话框）：开启统一渠道、允许默认 provider，按 `beforePure` 恢复共享资源与更新管理，起本机代理并立即把 rly0 设为默认，然后清除 `pure` / `beforePure`。窗口随后重启正在运行的 Codex，经 Launcher 打开。

官方原样下不能单独开启免登录用中转、统一渠道或共享资源（返回 `HUB_PURE_MODE`，窗口提示先“重新开启 Hub”），避免在用户不知情时改动 Codex。

## 已知限制

- Windows 开始菜单的“Codex (RLY0 Hub)”快捷方式和安装器装完后的重开直接运行 `codexhost-start.exe`，还不读 `pure`，会经 Launcher 打开。
- 用 rly0 线路建的旧对话在官方原样下可能因线路不一致不能续聊；新对话不受影响。
