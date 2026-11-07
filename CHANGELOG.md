# Changelog

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

