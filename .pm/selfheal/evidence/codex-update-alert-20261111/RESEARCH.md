# Codex Sparkle 只读研究（2026-11-11）

输入 worktree：`feat/agent-cli-autoupdate`，`5d07cdaf`。未加载或执行原生 addon，未写入 App 包或用户 defaults。

## 已核实

- `/Applications/ChatGPT.app/Contents/Info.plist`：`com.openai.codex`，`26.1103.60933`，CFBundleVersion `25894`。
- `Contents/Frameworks/Sparkle.framework/Resources/Info.plist`：Sparkle `2.9.1`，build `2054`。
- `app.asar` 以 Python 只读解析 ASAR header，在临时目录提取 19,886 个 packed 文件；unpacked 原生模块直接按原路径只读分析，未执行。
- ASAR `.vite/build/early-bootstrap-339-cb7e73ca5a71df7c.js` 字符偏移 1020181 加载 `native/sparkle.node`；1022069 附近将 gate 转给 `setAutomaticBackgroundDownloadsEnabled`。旧 feed 还在 1022861 附近通过 JS setInterval 调用 `checkForUpdatesInBackground`；生产 feed 使用原生调度。因此仅关 `SUEnableAutomaticChecks` 不能覆盖全部已存在的检查入口。
- arm64 Sparkle CFString `0x57f60`（字符串 `0x42e50`）=`SUSkippedVersion`；`0x57f80`/`0x57fa0` 为 `SUSkippedMajorVersion` / `SUSkippedMajorSubreleaseVersion`。全局键指针分别在 `0x54ae0`、`0x54ae8`、`0x54af0`。
- Sparkle `0x178c4–0x179e8` 按 NSString 读取三个跳过键。`SPUSkippedUpdate skipUpdate:host:` 对应 `0x17a68`：`0x17aa4` 调用 `versionString`（objc stub `0x395a0`）；普通跳过在 `0x17b14–0x17b28` 将该值写入 `SUSkippedVersion`。大版本跳过分支另用 minimumAutoupdateVersion，Hub 不改那两个键。
- Sparkle 候选过滤 `0x144c0` 调用 `0x146e4`。`0x14844–0x14884` 取 minor skip 并比较 skip 与候选 `versionString`，skip >= candidate 则过滤；所以应写 feed 的 `sparkle:version`（build），不能写展示用 `sparkle:shortVersionString`。后台与手动检查的跳过策略不同，不能宣称这是强制禁止用户手动更新的安全边界。
- `sparkle.node` arm64 `ShouldShowScheduledUpdate` (`0x1308–0x13a4`) 读取 CFString `0x185d8`=`CodexSparkleSeenUpdateVersions`，对 appcast item `versionString` 做 containsObject。`standardUserDriverDidReceiveUserAttentionForUpdate:` (`0x1c48`，写入 `0x1d24`) 将用户已关注过的 build 加入数组；`showUpdateFoundWithAppcastItem:state:reply:` (`0xe88`，`0x110c` 仍调用 superclass) 使用它决定焦点/呈现行为。这是提醒关注记录，不是 Sparkle 候选过滤键，Hub 不改它。

## 方法与指纹

命令：Python `plistlib` / `hashlib` / `struct` 只读解析；`strings -t x`；`otool -arch arm64 -tvV`；`otool -arch arm64 -ov`；解析 Mach-O CFString、objc selector refs 和 objc stubs，关联已剥离符号的调用地址。`nm -arch arm64 -nm ... | rg ...` 未找到 SPUSkippedUpdate 方法符号（管道 exit 1），随后用 ObjC 元数据和反汇编验证，没有执行二进制。

| 输入 | SHA-256 |
| --- | --- |
| Contents/Resources/app.asar | a77588b2dcfa9b394d722dd8c2c8b13d3a09bacd49c839cc715245742dba6048 |
| Contents/Resources/native/sparkle.node | a5b4c0e80d6df17cf612fb6e6ec529f4c86577fba7bb78299c3d58ed8277dd33 |
| Contents/Frameworks/Sparkle.framework/Sparkle | 0b287ae0388e98a18088703d3aa3a5bc1819f31a33c1faafd2e9ef5e28735441 |

置信度：上述版本、键、写入值和过滤比较为本机静态证据。运行中的 NSUserDefaults 跨进程刷新时机、已显示窗口是否自行消失、真实定时检查无弹窗、关闭管理与适配后恢复更新仍需获准独立环境验收。临时提取目录清理结果见 RESULTS.md。

## B1 诊断补核

2026-11-12 只读提取指定 `~/.codexhost/diagnostics/codex-update-hold-v1.json` 的相关字段：`holdBeforePageScripts:false`，mainWindow 为 `waitingAtAttach:true, attachedUrl:empty, installed:true, lateInstall:false, source:fallback, observed:3, sent:3, error:null, installedAt:142, firstGateAt:2215`。

当前源码 `packages/desktop-control/src/early-update-hold.ts:332` 只有 `source === early && !lateInstall` 才报告 true；因此 source=fallback 会报告 false，即使安装早于本页首次观测到的 gate。142 < 2215 证明早于“首次观测”，不能证明此前没有漏掉消息，也不能证明浏览器级 early 安装成功。本工单不改诊断定义、不把它改标成功、不更改 renderer 代码。
