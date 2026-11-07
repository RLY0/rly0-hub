# Changelog

## 0.11.37

0.11.36 was tagged but not released; everything below ships in 0.11.37.

### Updates
- First standalone macOS package (Apple Silicon): `RLY0-Hub-0.11.37-macos-arm64.dmg` carries the Hub window, its service, Node, rly0-core and the codexhost payload that opens Codex. Not signed by Apple: run `xattr -dr com.apple.quarantine "/Applications/RLY0 Hub.app"` once before the first launch.
- Both Windows and Mac open the Hub at the standard 100% interface size.
- macOS Hub: live quota and balance updates reach the window; balance/quota notices and automatic account switching run on the Mac too (system notifications); the background service restarts itself up to three times; agent CLIs are found through the login shell's PATH.

### Fixes
- macOS: "立即更新" no longer closes Codex before saying the update has to be downloaded; the Mac prompt opens the download page instead.
- macOS: the Hub's compatibility check no longer starts Codex when it is closed.
- macOS: Codex web sign-in finds Codex Desktop installed as ChatGPT.app; Gemini and other agent sign-ins open Terminal.
- macOS: manual install commands, relay snippets, paths and notices use Mac wording (Terminal, `~/`, notifications) instead of Windows wording.
- 远程连接 and similar pages say Codex is not running instead of a generic error; failed settings switches flip back; 自定义指令 "去设置" opens 打通设置; a custom proxy needs an address; oversized login files are refused with a clear message.
- macOS: quitting or restarting Codex from the Hub also ends the codexhost helpers started from the Hub app itself; the window's background service restarts without telling you to reopen the Hub, and the Hub no longer hangs at startup when a shell profile leaves a background process running.

（0.11.36 只打了标签、没有发布，以下内容都随 0.11.37 发布。）

### 更新
- 首个 Mac 独立安装包（M 系列芯片）：`RLY0-Hub-0.11.37-macos-arm64.dmg`，内含 Hub 窗口、后台、Node、核心组件和用来打开 Codex 的 codexhost。没有苹果签名，首次打开前在“终端”运行一次 `xattr -dr com.apple.quarantine "/Applications/RLY0 Hub.app"`。
- Windows 和 Mac 默认都以标准 100% 界面大小打开。
- Mac 版：额度和余额实时更新能显示到窗口；余额/额度提醒和自动切换账号在 Mac 上也会运行（系统通知）；后台意外退出会自动重启（最多 3 次）；能通过登录 Shell 的 PATH 找到各 AI 助手命令行。

### 修复
- Mac：点“立即更新”不再先关掉 Codex 再说不支持；Mac 的更新提示直接打开下载页。
- Mac：Hub 的兼容检查不会在 Codex 关着时把它打开。
- Mac：Codex 网页登录能找到装成 ChatGPT.app 的 Codex；Gemini 等助手的登录能打开“终端”。
- Mac：手动安装命令、中转配置示例、路径和提醒文字改用 Mac 说法（终端、`~/`、通知）。
- 远程连接等页面在 Codex 没开时直接说明，不再只显示“操作没有成功”；设置开关保存失败会弹回；自定义指令的“去设置”打开打通设置；自定义代理必须填写地址；登录文件过大时给出明确提示。
- Mac：从 Hub 关闭或重启 Codex 时，也会结束 Hub 自带的 codexhost 辅助进程；后台自动重启期间不再误提示“请退出 Hub 再打开”；Shell 配置里有常驻后台程序时 Hub 不再卡在启动中。

## 0.11.35

### Fixes
- Delegation CLI tests now compute the expected `--cwd` with the platform's path rules, so they pass on Windows as well as macOS. No product behavior changes.

### 修复
- 委派命令行的两项测试改为按当前系统计算期望的工作目录，Windows 与 Mac 上都能通过；产品行为不变。

## 0.11.34

### Updates
- Merge CodexHost v0.17.4: native RPC routing for current Codex Desktop builds (26.1029–26.1103), restored project lists on startup, faster external Threads, Devin CLI and Qwen Code.
- macOS Hub: restart Codex from the Hub, Chinese Edit menu and context menu, Ctrl/⌘ paste and select-all in the Hub window.

### Fixes
- Hub can identify the Composer again on Codex Desktop 26.1103, so model and Agent menus work without background errors.
- No startup errors when Codex opens before the Hub route is ready.
- A Harness command and image attachments are sent separately; inline images keep working.

### 更新
- 合并 CodexHost v0.17.4：适配新版 Codex Desktop（26.1029–26.1103）的接入方式，启动时项目列表不再为空，外部助手对话更流畅，新增 Devin CLI 与 Qwen Code。
- Mac 版 Hub：可从 Hub 重启 Codex；编辑菜单与右键菜单为中文；Hub 窗口支持 Ctrl/⌘ 粘贴与全选。

### 修复
- 新版 Codex 26.1103 下 Hub 能重新识别输入框，选模型、选助手不再后台报错。
- Codex 启动早于 Hub 就绪时不再出现报错。
- 助手命令与图片附件需分开发送；内嵌图片照常可用。

### Known limits
- Very old Codex Desktop builds without scoped draft creation can no longer select an external Agent on a new chat (upstream rule).

## 0.11.33

### Fixes
- Restore Claude Code selection in new chats on Codex Desktop 26.1029.
- Recognize the updated native model chip so external Agent chats hide the transport model control.
- Ensure new RLY/0 Hub installations and launches configure the RLY/0 Codex provider automatically, preserving a configuration backup.

### 修复
- 修复 Codex Desktop 26.1029 新聊天无法切换 Claude Code 的问题。
- 识别新版原生模型按钮，避免外部 Agent 对话显示传输模型控件。
- 安装或启动 RLY/0 Hub 时自动配置 Codex 的 RLY/0 Provider，并保留配置备份。

### Verification
- The 15 known Windows TypeScript failures also reproduce on released main and the pre-change branch baseline; see the release notes for individual causes. None is a regression introduced by this update.


- Release builds now remap Cargo, rustup, repository and profile paths to neutral prefixes and strip debug information, preventing local build paths from appearing in shipped Rust executables.

