# Changelog

## 0.11.40

### Updates
- Built on upstream codexhost v0.18.0. Its new browser and phone access stays off and listens only on this computer unless you turn it on; chats, settings and usage stay in the Hub's own data folder, and chats from the stock CodexHost are still imported.
- Codex updates go through the Hub: Codex Desktop stays on the version the Hub has verified, and once a newer one is verified the Hub updates Codex while no task is running and the computer has been left alone for five minutes. 设置 → 更新 → Codex 更新 shows the state and has the switch (on by default); 恢复纯净 turns it off.
- The command-line tools in AI 助手 update themselves: checked daily, updated only while the tool is idle, checked right after the update and put back to the previous version if it no longer works. AI 助手 has the switch (on by default) and one line per tool.
- Codex Desktop 26.1106 is supported.

### Fixes
- Changing the Claude token or key in the Hub takes effect in Codex at once, for open and new Claude chats, without restarting anything.
- macOS: after the Hub is updated, Claude in Codex keeps working. Before, Codex's background helper kept the old Hub's key service, could no longer read saved tokens, and Claude answered "Not logged in" until the helper was restarted.
- Windows: opening Codex through the Hub no longer ends with Codex closing when the enhancements load.
- Windows: 立即检查 and other Codex actions find Codex again when Windows reused an old process number.
- 绕过权限 in Claude Code no longer stops on questions Claude Code still asks; 阿零 shows on the Windows home page again.

### 更新
- 基于上游 codexhost v0.18.0。新增的浏览器、手机访问默认关闭，不开就只在本机可用；对话、设置和用量仍放在 Hub 自己的数据文件夹里，原版 CodexHost 的对话照常导入。
- Codex 更新交给 Hub 管：Codex 停在 Hub 验证过的版本；新版本验证过后，Hub 会在没有任务在跑、电脑 5 分钟没人操作时帮你更新。“设置 → 更新 → Codex 更新”能看状态、有开关（默认开）；“恢复纯净”会关掉它。
- AI 助手里的命令行工具会自动更新：每天检查，只在工具空闲时更新，更新完马上检查还能不能用，不能用就退回旧版。AI 助手页有开关（默认开），每个工具一行状态。
- 支持 Codex 桌面版 26.1106。

### 修复
- 在 Hub 里换 Claude 令牌或 Key，Codex 里马上生效，已打开和新开的 Claude 对话都跟着换，不用重启任何东西。
- Mac：Hub 更新后，Codex 里的 Claude 照常可用。以前 Codex 的后台程序还拿着旧版 Hub 的密钥服务，读不出已存的令牌，Claude 会一直说“没登录”，要重启才好。
- Windows：经 Hub 打开 Codex 时，不会再在加载增强时把 Codex 一起关掉。
- Windows：系统复用了旧的进程号时，“立即检查”等 Codex 操作也能找到 Codex。
- Claude Code 的“绕过权限”不会再停在它仍会发出的提问上；Windows 首页的阿零又能显示了。

## 0.11.39

### Updates
- When Codex Desktop updates to a version the Hub has not verified yet, the Hub opens it in safe mode: Codex and delegating work to CC keep working, only the interface enhancements are off for now, and 维护 offers one click to restart Codex in full mode.

- The home banner shows RLY/0's current offer (read from rly0.com's own banner): each top-up tier with its bonus, the first-top-up one highlighted. In a narrow window the banner drops 阿零 and spreads out.
- macOS: the RLY/0 icon in Codex's sidebar opens the Hub window (on the matching page) instead of the old settings inside Codex.
- macOS: standard shortcuts in the Hub — ⌘W closes the window (the Hub keeps running), ⌘M, ⌘H, ⌥⌘H, ⌘, (settings), ⌘R (reload).

### Fixes
- One chat can switch from a relay model to an official one again. Relays name past messages `item_…`, which the official API refuses ("Expected an ID that begins with 'msg'"); the Hub now drops those ids before the request leaves (the messages themselves are unchanged), and retries once without reasoning another upstream encrypted if the official API cannot read it.

### 更新
- Codex 更新到 Hub 还没验证的新版本时，Hub 会用安全模式打开它：Codex 和叫 CC 干活照常可用，界面增强先关闭，维护页可以一键以完整模式重启。
- 首页广告栏显示零号中转当前的福利（直接读零号中转网站顶部的横幅）：每一档充多少送多少，首充那档最醒目；窗口窄时不显示阿零，内容铺满。
- Mac：点 Codex 左边的 RLY/0 图标直接打开 Hub 窗口（并跳到对应页面），不再打开 Codex 里的旧设置页。
- Mac：Hub 支持常用快捷键——⌘W 关窗口（Hub 继续运行）、⌘M、⌘H、⌥⌘H、⌘,（设置）、⌘R（重新载入）。

### 修复
- 同一个对话里从中转模型切到官方模型不再报错。中转给历史消息编的号是 `item_…`，官方不认（“Expected an ID that begins with 'msg'”）；Hub 现在在发出前去掉这些编号，消息内容不变；官方读不懂别处加密的思考记录时，会去掉它再试一次。

## 0.11.38

### Updates
- macOS: opening the Hub the first time needs no Terminal command. Click "完成", then 系统设置 → 隐私与安全性 → 仍要打开 once per version; the note in the DMG and the release page show the steps.
- App icons are dark tiles (ink-950 with the RLY/0 mark) on macOS and Windows, instead of a transparent icon that macOS 26 puts on a light plate.

### Fixes
- macOS: the update page shows the Hub's own version instead of "0.0.0 / 暂时连不上发布页" when the app carries no payload metadata.
- Older Codex chats can be continued again. Codex Desktop 26.1029+ refuses to continue a chat started on another provider than the current one (for example `openai` while the Hub's channel is `rly0`), whatever the Hub asks. 维护 → 修复聊天记录 now finds these chats and moves them onto the current provider: Codex is closed, its chat database is backed up, only each chat's stored provider is changed, and Codex is opened again; nothing is written while another program (the Codex CLI, the VS Code extension) still has that database open. "撤销上次线路修改" puts them back exactly.

### 更新
- Mac：第一次打开 Hub 不用再输入命令。先点“完成”，再到“系统设置 → 隐私与安全性”点一次“仍要打开”（每个新版本一次）；DMG 里的说明和发布页都写了步骤。
- App 图标改成黑底方块（墨黑底 + RLY/0 标志），Mac 和 Windows 都是；不再用透明图标（macOS 26 会给它垫一块浅色底板）。

### 修复
- Mac：更新页不再误报“当前版本 0.0.0、暂时连不上发布页”，读不到安装包信息时直接读 App 自己的版本号。
- 旧对话又能接着聊了。新版 Codex（26.1029 起）会拒绝接着聊“当初用的线路和现在不同”的对话（比如当初是 openai、现在 Hub 用 rly0），Hub 怎么请求都不行。现在“维护 → 修复聊天记录”能找出这些对话并改到现在的线路：先关闭 Codex、完整备份它的聊天数据库，只改每条对话的线路记录，再重新打开 Codex；如果还有别的程序（命令行版 Codex、VS Code 插件）开着这个数据库，就什么都不改并提示你先关掉。“撤销上次线路修改”可以原样改回。

## 0.11.37

0.11.36 was tagged but not released; everything below ships in 0.11.37.

### Updates
- First standalone macOS package (Apple Silicon): `RLY0-Hub-0.11.37-macos-arm64.dmg` carries the Hub window, its service, Node, rly0-core and the codexhost payload that opens Codex. Not signed by Apple: the first time, allow it once in 系统设置 → 隐私与安全性 → 仍要打开; no Terminal command needed.
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
- 首个 Mac 独立安装包（M 系列芯片）：`RLY0-Hub-0.11.37-macos-arm64.dmg`，内含 Hub 窗口、后台、Node、核心组件和用来打开 Codex 的 codexhost。没有苹果签名，第一次打开要在“系统设置 → 隐私与安全性”点一次“仍要打开”，不用输入命令。
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

