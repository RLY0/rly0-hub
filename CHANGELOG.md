# Changelog

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

