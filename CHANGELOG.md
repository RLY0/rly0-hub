# Changelog

## Unreleased

### Fixes
- Claude in Codex kept answering 429 after the token's quota came back, until the background processes were ended by hand. The Hub's shared background service outlives Codex: 重启 Codex, quitting Codex, or restarting the Hub all left it and its Claude Code processes running. On Mac, 重启 Codex now also restarts the shared background service, so Codex comes back on fresh processes. Switching Claude Code's token or account in the Hub now also replaces the Claude Code sessions already running (idle ones at once, busy ones after their reply), without restarting Codex.
- A Claude token that Anthropic refuses (429) no longer shows "剩 100%": the token card says it is rate-limited, which limit (5-hour, weekly, weekly Opus…) and when it is expected to end, and 刷新 no longer clears that before it ends. The 429 message in the conversation says the same and that retrying or restarting Codex will not help until then. Auto-switch treats a refused token as used up.
- A quota window past its reset time now shows 已重置 (with "点刷新确认") instead of the old number, also on a page left open. Nothing is requested for this.
- 检测连接 on the AI 助手 page could answer "全部正常" and keep showing an old result (for example "Antigravity not signed in" after signing in): an empty report from a Codex-side process arrived before the real one. Only the process that runs the agents answers now.

### 修复
- 修复：Claude 令牌额度恢复后，Codex 里的 Claude 对话仍一直报 429，必须手动结束后台进程才好。原因是 Hub 的共享后台不随 Codex 退出，点「重启 Codex」、退出 Codex、重启 Hub 都不会重启它和其中的 Claude 进程。现在 Mac 上点「重启 Codex」会连共享后台一起重启；在 Hub 里换 Claude 令牌或账号后，已经在跑的 Claude 会话也会换成新的（空闲的立即换，正在回复的等这一轮结束），不用重启 Codex。
- 修复：被 Anthropic 限流（429）的 Claude 令牌不再显示「剩 100%」。卡片会写明正在被限流、卡在哪个限额（5 小时、每周、每周 Opus 等）和预计恢复时间，点刷新也不会提前清掉；对话里的 429 提示同样写明，并说明在此之前重试或重启 Codex 都没用。自动切换把被限流的令牌当作额度用完。
- 修复：额度过了重置时间后显示「已重置」（并提示点刷新确认），不再停在旧数字；页面一直开着也会自动切换，不发任何请求。
- 修复：AI 助手页点「检测连接」可能提示「全部正常」却仍显示旧结果（比如已经登录 Antigravity 还显示没登录）。原因是 Codex 窗口那边的进程先回了一份空结果；现在只由真正运行助手的后台回复。

## 0.11.56

### Fixes
- While the Hub was running, Codex's model menu stopped at GPT-6.1 and did not show the newest official models (such as GPT-6.2). Codex asks the Hub's local proxy for the official model list; the proxy answered every model-list request with the relays' list instead, which Codex could not read, so it fell back to the older list built into the app. Codex's own model-list request (with its official login) now goes to the official service unchanged; other model-list requests still get the relays' list. Only the Hub's core component changed (Windows and Mac).

### 修复
- 修复：开着 Hub 时 Codex 看不到最新官方模型（如 GPT-6.2），模型菜单最高只到 GPT-6.1。原因是 Hub 把 Codex 查询官方模型列表的请求也拦下来，回了中转站的列表，Codex 看不懂，就退回到程序里自带的旧列表。现在 Codex 自己查官方模型列表时原样交给官方，其他情况不变。只更新了 Hub 的核心组件（Windows 和 Mac 都有）。

## 0.11.55

### Updates
- Windows: when Codex is on a version the Hub has not verified (so it opens in safe mode with the Hub's additions off) and the Microsoft Store offers a verified one, the Hub now brings Codex to it instead of waiting for the Store. Once Codex has no task running and the computer has been left alone for five minutes, the Hub closes Codex, asks the Store to update Codex only (winget as fallback), checks that the installed version really changed, and opens Codex again. The Store's "app updates" switch is not touched, so this also works when you keep Store updates off. If neither route works, 设置 → 更新 → Codex 更新 says so and offers "现在更新" and "去微软商店更新"; the same buttons appear when Hub management of Codex updates is off (then nothing happens on its own). Not yet tried on a real Windows PC.
- 系统诊断: the safe-mode line no longer calls an older Codex "新版本", and says when the Hub will update Codex or where to update it by hand.

### 更新
- Windows：Codex 停在 Hub 还没验证的版本（以安全模式打开、Hub 增强关闭），而微软商店已经有验证过的版本时，Hub 不再干等商店，会主动把 Codex 更新上去。等 Codex 没有任务、电脑也 5 分钟没人动时，Hub 关掉 Codex，让微软商店只更新 Codex 这一个应用（不行再用 winget），确认装上的版本真的变了，再重新打开 Codex。不动商店的“应用更新”总开关，所以你关着商店自动更新也照样能更新 Codex。两种办法都不行时，设置 → 更新 → Codex 更新 会说明情况，并给出“现在更新”和“去微软商店更新”两个按钮；关掉“由 Hub 管理 Codex 更新”时也显示这两个按钮（但不会自己更新）。尚未在真实 Windows 电脑上试过。
- 系统诊断：安全模式那句不再把旧版 Codex 叫“新版本”，并说明 Hub 什么时候会自动更新，或去哪里手动更新。

## 0.11.54

0.11.53 was not released; this version contains all of it.

### Fixes
- Tests: the Mac Node.js installer test now passes when the test suite runs on Windows (it compared a Mac-style path with a Windows one and split a drive letter on PATH's ":"). No change for users.

### 修复
- 0.11.53 未发布，本版包含其全部内容。
- 测试：Mac 自动安装 Node.js 的测试在 Windows 上跑全量时也能通过（之前把 Mac 格式路径和 Windows 路径直接比较，并把盘符里的冒号当成 PATH 分隔符）。对用户没有影响。

## 0.11.53

0.11.52 was not released; this version contains all of it.

### Fixes
- Mac: after updating to 0.11.51, saving an Anthropic key or token failed with "本机加密保存失败，请检查 Mac 钥匙串访问权限", and refreshing a saved Claude token failed too. Every update has a new ad-hoc signature, and macOS silently denied the new build access to the public half of the Hub's Keychain key, which Apple's encryption and decryption both read. Saving and reading now use only the private key, whose access macOS asks for again. After installing this version, choose "始终允许" when macOS asks once; keys saved earlier keep working and do not need to be saved again.
- Mac: two Hub processes writing the same credential file at the same moment could occasionally fail.
- Codex 26.1117: when the signed-in ChatGPT account ran out of Codex usage, Codex merged its two usage blocks into one "submit disabled" reason list, so the Hub could no longer find them: a Composer on an external Agent, or on an RLY/0 relay model, stayed blocked even though neither uses the official usage. The Hub now removes only those two usage reasons for that Composer (from upstream CodexHost v0.24.0, with the Hub's relay-model rule kept). Official Codex models keep the real limit, other submit blockers are untouched, and the usage banner stays visible on relay models as information.
- Codex 26.1117: with MCP servers configured, Codex passes extra MCP launch-folder arguments to the Hub's background helper, which rejected them, so the Hub could time out while starting (from upstream CodexHost v0.24.0).
- 账号 → Google: a month-old Antigravity quota is no longer shown as the last reading once all its windows have reset; past reset times read "已于 … 重置", and 更新于 shows the date when it is not today.
- AI 助手: when agy is installed but not signed in, the hint now says to sign in to Google under 账号 → Google (or pick a relay) instead of the generic message.
- 账号 → Claude: the page refresh button is no longer disabled as "无法查询额度" while a saved token's first read is running.

### Updates
- Mac: installing an agent that needs Node.js (OpenCode, Grok, Copilot and others) no longer stops at "缺少 Node.js". The Hub downloads the official Node.js LTS from nodejs.org (npmmirror as fallback), checks it against the published checksums and keeps it in its own folder, with no computer password and nothing else on the Mac changed. A Node.js you installed yourself is still used first.

### 修复
- 0.11.52 未发布，本版包含其全部内容。
- Mac：升级到 0.11.51 后，保存 Anthropic Key 或令牌会提示「本机加密保存失败，请检查 Mac 钥匙串访问权限」，已保存的 Claude 令牌也刷新失败。原因是每次更新签名都会变，macOS 会悄悄拒绝新版本读取钥匙串里那把密钥的公钥部分，而苹果的加密和解密都要读它。现在保存和读取只用私钥，macOS 会重新询问一次权限。装好本版后，macOS 弹窗时点「始终允许」即可；之前保存的 Key 照常能用，不用重新保存。
- Mac：两个 Hub 进程同时写同一个凭据文件时，偶尔会写入失败。
- Codex 26.1117：ChatGPT 账号的 Codex 额度用完后，Codex 把两道额度限制合并成了一串“不能发送”的原因，Hub 找不到它们，于是选了外部助手或 RLY/0 中转模型的输入框也一直发不出去，虽然它们根本不用官方额度。现在 Hub 只为这个输入框去掉这两条额度原因（取自上游 CodexHost v0.24.0，保留 Hub 的中转模型规则）。官方 Codex 模型照常受额度限制，其他发送限制不动，中转模型下额度提示条照常显示，仅供参考。
- Codex 26.1117：配置了 MCP 服务时，Codex 会给 Hub 的后台助手多传几个“MCP 启动目录”参数，原来会被拒绝，导致 Hub 启动超时（取自上游 CodexHost v0.24.0）。
- 账号 → Google：Antigravity 的额度窗口都已重置后，不再把一个月前查到的额度当作「上次查询」显示；已经过去的重置时间写成「已于 … 重置」，「更新于」不是今天时会带上日期。
- AI 助手：agy 已装好但没登录时，提示改为「到 账号 → Google 登录 Google 账号，或改选中转」，不再是笼统的提示。
- 账号 → Claude：已保存令牌第一次读取还没完成时，页面顶部的刷新按钮不再变灰显示「无法查询额度」。

### 更新
- Mac：安装需要 Node.js 的助手（OpenCode、Grok、Copilot 等）时，不再停在「缺少 Node.js」。Hub 会从 nodejs.org（备用 npmmirror）下载官方 Node.js LTS，核对官方校验值后放在 Hub 自己的文件夹里，不需要电脑密码，也不改动 Mac 上的其他东西。你自己装过 Node.js 的话仍优先用你的。

## 0.11.51

0.11.50 was not released; this version contains all of it.

### Fixes
- Release checks: a Renderer routing test re-created its sandbox and recompiled the injected script on every 25 ms poll while waiting through 60 s of fake time, so it spent about 3 s of real CPU and timed out on Mac when the full suite loaded the machine. The test now keeps one sandbox per fixture, as a real page does; the same assertions finish in under a second.

### 修复
- 0.11.50 未发布，本版包含其全部内容。
- 发布检查：一条界面路由测试在等待 60 秒假时间时，每 25 毫秒都重新建沙盒、重新编译注入脚本，真实耗时约 3 秒，Mac 全量测试时机器一忙就超时。现在每个测试只用一个沙盒（和真实页面一样），断言不变，不到一秒跑完。

## 0.11.50

### Updates
- Codex updates are now cleared by exact version, not by version family: a new build of an already supported Codex opens without the Hub's interface additions until it has been checked. Verified builds: macOS 26.1106.51428 and 26.1117.31558, Windows 26.1117.3838 and 26.1117.4957. The online list `codex-compat.json` carries the same exact versions (`verifiedVersions`). Codex builds that were only cleared as part of a family before (for example macOS 26.1111 or 26.1103 builds) now open in core mode: Codex and the relay keep working, the Hub's interface additions pause until that exact build is verified or Codex updates to a verified one.
- Windows: while the Microsoft Store offers a Codex build the Hub has not verified, the Hub pauses the Store's automatic app updates and turns them back on once the build is verified, when you switch update management off, when pure mode is restored, or when the Hub is uninstalled. Windows has one switch for all Store apps, so while paused no Store app updates on its own. If you turn Store updates back on yourself during a pause, the Hub leaves them on for that Codex build; if they were already off, the Hub never touches them. Settings → 更新 shows this in plain words. Going back to a Hub older than 0.11.50 while paused leaves the switch off; turn it back on in Store settings.
- Codex 26.1117.4957: new chats in ChatGPT mode → Work use ChatGPT's own composer, which the Hub cannot take over. That composer now shows an Agent picker; choosing an Agent switches Codex to its Codex mode and opens a new chat there with the Agent selected.

### 更新
- Codex 版本改为按具体版本放行，不再按大版本整族放行：已支持的 Codex 出了新构建，在核对前先不挂 Hub 的界面增强。已核对的版本：Mac 26.1106.51428、26.1117.31558，Windows 26.1117.3838、26.1117.4957。在线清单 `codex-compat.json` 也改为同样的具体版本（`verifiedVersions`）。以前只是“整族放行”的版本（比如 Mac 上的 26.1111、26.1103 构建）会进入核心模式：Codex 和中转照常能用，Hub 的界面增强先暂停，等这个具体版本核对通过、或 Codex 升到已核对的版本后自动恢复。
- Windows：微软商店出现 Hub 还没核对过的 Codex 版本时，Hub 会先暂停商店的应用自动更新；版本核对通过、你关掉更新管理、恢复纯净模式或卸载 Hub 时，再把它打开。Windows 的这个开关管商店里所有应用，暂停期间商店里的应用都不会自己更新。暂停期间你自己把商店自动更新打开，Hub 对这个 Codex 版本就不再关它；本来就关着的，Hub 不碰。设置 → 更新 页用白话显示这个状态。暂停期间如果退回 0.11.50 以前的 Hub，开关会一直关着，需要到商店设置里手动打开。
- Codex 26.1117.4957：ChatGPT 模式“工作”里的新聊天换成了 ChatGPT 自己的输入框，Hub 接管不了。现在这个输入框上会出现“选助手”入口，选好后自动切到 Codex 模式并新开对话，带上选中的助手。

## 0.11.49

0.11.48 was not released; this version contains all of it.

### Fixes
- Release checks: a chat-health test compared a 1.5 MB database byte by byte through the slow deep-equality matcher and timed out on Mac; it now uses an exact byte comparison, just as strict and done in a millisecond.

### 修复
- 0.11.48 未发布，本版包含其全部内容。
- 发布检查：聊天体检的一条测试用很慢的深比较逐字节对比 1.5MB 的数据库，在 Mac 上超时；改用同样严格的字节比较，一毫秒完成。

## 0.11.48

### Fixes
- Skills: when your home folder or Codex folder sits behind a link (an external disk, or macOS's own /var), Codex's own skills are no longer treated as links, so turning a skill off moves it to the backup again instead of only hiding it.
- Claude Code: the manual quota refresh reads live credits again.
- Attachments sent to other agents are titled with the file name on every computer.
- Windows: Codex update management keeps checking every two seconds after an update is let through, instead of stopping on a file-replace error.
- Windows: helper processes started by the Hub no longer print an SQLite warning.
- Release checks: the long-standing failing tests on Mac and Windows were fixed or brought up to date, and the Windows build now applies the repository's dependency patches.

### 修复
- 技能：主目录或 Codex 目录在链接后面（外接盘，或 Mac 系统自带的 /var）时，Codex 自己的技能不再被当成链接；停用技能会重新真正移进备份，而不是只隐藏。
- Claude Code：手动刷新额度重新能读到实时额度。
- 发给其他助手的附件在任何电脑上都以文件名作标题。
- Windows：放行 Codex 更新后，更新管理继续每两秒检查一次，不再因替换文件出错而停下。
- Windows：Hub 启动的辅助进程不再打出 SQLite 警告。
- 发布检查：Mac 和 Windows 上长期失败的测试已修好或按现状更新，Windows 打包也会打上仓库自带的依赖补丁。

## 0.11.47

### Updates
- Links from the Hub to rly0.com (home page, recharge, keys, sign-up and the relay card) now carry `from=hub`, so rly0.com's traffic report can count visits that came from the Hub. Only the source is added; nothing about you is sent.

### 更新
- Hub 里打开 rly0.com 的链接（首页、充值、Key、注册和中转站卡片）带上了 `from=hub` 标记，零号中转网站的流量统计能算出从 Hub 来的访问。只标明来源，不带任何个人信息。

## 0.11.46

0.11.44 and 0.11.45 were not published; this version includes everything in them (Codex Desktop 26.1117 support, 官方原样, chat repair on macOS, maintenance dot).
0.11.44、0.11.45 没有发布出去，这一版包含它们的全部内容（支持 Codex 桌面版 26.1117、官方原样、Mac 修复聊天记录、维护红点）。

### Fixes
- Windows: the Hub's small status files no longer fail to save when several parts of the Hub write them at the same moment.

### 修复
- Windows：Hub 的几个小状态文件在同一时刻被多处写入时，不会再保存失败。

## 0.11.45 (not published)

### Updates
- 官方原样 (formerly 恢复纯净) now puts Codex back to how the official app is: Codex opens the official way, without the agent picker, other agents' chats or the Hub's buttons, and updates itself. 重新开启 Hub brings everything back, including the shared-resource and Codex-update switches that were on before. Accounts, relays, keys and agent chats are kept.
- 修复聊天记录 works on macOS: it used to give up because a Hub background service kept Codex's chat database open after Codex closed. That service is now stopped properly during the repair and comes back with Codex.
- The 维护 entry in the sidebar shows a dot while some chats can be repaired.

### 更新
- “官方原样”（原“恢复纯净”）现在让 Codex 真正回到官方原装的样子：Codex 用官方方式打开，没有助手菜单、其他助手的对话和 Hub 加的按钮，由 Codex 自己更新。点“重新开启 Hub”全部恢复，原来开着的共享资源和 Codex 更新管理也会打开。账号、中转站、Key 和助手对话都保留。
- Mac 上“修复聊天记录”能修了：以前 Codex 关掉后 Hub 的一个后台服务还占着 Codex 的聊天记录库，修复会放弃。现在修复时会正规地停掉它，打开 Codex 时自动恢复。
- 有可以修复的聊天时，侧边栏“维护”会显示一个小红点。

## 0.11.44

### Updates
- Codex Desktop 26.1117 is supported. Codex 26.1117 starts its background service through a new helper process; the Hub now recognises it, so routing and the agent picker start normally instead of timing out. Choosing Claude Code or another agent in a new chat, and resuming paused messages after a steer, work with the new Codex as well. Once this Hub is installed, the Hub can update Codex to 26.1117 while no task is running.
- Sidebar agent icons sit in Codex's own icon slot again, and the settings page no longer shows a stray vertical line on Codex 26.1117.

### 更新
- 支持 Codex 桌面版 26.1117。新版 Codex 改用一个新的辅助进程启动后台服务，Hub 现在能认出它，线路切换和助手选择会正常启动，不会卡住超时。在新对话里选 Claude Code 等助手、引导后自动续发排队消息，在新版 Codex 上也能正常用。装好这一版 Hub 后，Hub 会在没有任务在跑时帮你把 Codex 更新到 26.1117。
- 在 Codex 26.1117 上，侧栏的助手图标回到原来的位置，设置页不再出现多余的竖线。

## 0.11.43

### Fixes
- macOS: importing an account from a file now opens the system file picker. Cancelling leaves the account unchanged.
- Account saving and importing explain local encryption and Keychain failures instead of showing a generic error.

### 修复
- Mac：“从文件导入”现在会打开系统文件选择框，取消选择不会更改账号。
- 保存或导入账号遇到本机加密、钥匙串问题时，会显示具体原因。

## 0.11.42

### Updates
- Every installed AI 助手 now updates itself through the Hub, Claude Code included. A tool is updated only while it is idle, checked right after the update, and put back to the previous version if it no longer works. While Claude Code downloads a new version you can still start chats. Tools installed through another package manager (such as Homebrew) are left to that manager.
- Each installed agent card shows its version under 已安装: "已是最新" or "有新版 vX".
- macOS: the Hub downloads and checks its own update package, then asks you to open it and drag RLY0 Hub over the old one.
- MCP servers are shared with the other agents only when they can run on this computer; the rest are listed in 打通 → MCP with the reason. On macOS a server's token can be kept in the Keychain and is handed to Claude Code only when it connects; each server's real connection state is shown.

### Fixes
- macOS: 重启 Codex at the top of the Hub lights up only while Codex is actually open.

### 更新
- 所有装好的 AI 助手都由 Hub 自动更新，包括 Claude Code：只在它空闲时更新，更新完马上检查还能不能用，不能用就退回旧版。Claude Code 下载新版期间照样能开新对话。用 Homebrew 等其他软件管理工具装的助手不碰，留给原来的方式更新。
- 每张已安装助手的卡片在“已安装”下面显示版本号：“已是最新”或“有新版 vX”。
- Mac：Hub 会自己把新版安装包下载好并核对，再提示你打开它、把 RLY0 Hub 拖过去替换。
- MCP 服务只在这台电脑能运行时才共享给其他助手，不能运行的在“打通 → MCP”里写明原因；Mac 上可以把 MCP 令牌放进钥匙串，只在 Claude Code 连接时交给它；每个 MCP 的真实连接状态直接显示。

### 修复
- Mac：Hub 顶上的“重启 Codex”只在 Codex 真的开着时才亮。

## 0.11.41

### Updates
- Codex Desktop 26.1111 is supported. Once this Hub is installed, the Hub can update Codex to 26.1111 while no task is running.
- Claude usage estimates now price Fable 5.2, Mythos 5.2, Mythos 5.1, Opus 5.5 and Sonnet 5.5.

### 更新
- 支持 Codex 桌面版 26.1111。装好这一版 Hub 后，Hub 会在没有任务在跑时帮你把 Codex 更新到 26.1111。
- Claude 用量估算补上了 Fable 5.2、Mythos 5.2、Mythos 5.1、Opus 5.5 和 Sonnet 5.5 的价格。

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

