# HUB-CODEX-VERSION-GATE contract v3 (second review fixes)

状态：Codex 技术定义，待 Claude 核对；未发布。本轮基线：c796e85c；工单：HUB-CODEX-VERSION-GATE。

## 兼容资产

独立资产 `codex-compat.json`，URL 为现有 GitHub releases/latest/download/codex-compat.json；不修改严格的 latest.json。

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-11-09T00:00:00Z",
  "verified": [{ "family": "26.1200", "minHub": "0.11.40" }],
  "disabled": [{ "feature": "settings", "codexFamilies": ["26.1103"], "hubBelow": "0.11.41", "reason": "待修复" }]
}
```

上例为 synthetic，不是当前版本适配声明。family 是 Desktop major.minor；minHub/hubBelow 为 semver，含 prerelease 正确排序。已验证集合 = 内置表 ∪ 满足 minHub 的远程表。未知字段、未来 feature id 忽略；已知字段类型错误拒绝整份文件。远程缺失/损坏保留上次有效缓存，再退内置表；没有时间到期后自动放行的逻辑。最多 256 KiB，数组最多 1000 项。updatedAt 是信息字段，不是签名。

feature：usage、composer、sidebar-icons、settings、schedules、delegation、questions、reasoning-wrap、draft-prewarm、native-rpc、rpc-steering。没有 codexFamilies 表示全部版本，没有 hubBelow 表示全部 Hub。匹配禁用只做收缩，不允许远程指定脚本/命令/URL。composer/draft-prewarm 任一关闭，依赖它的组合降到 core；此时 usage 也关闭则 safe。

## Hub management RPC

复用现有 Hub 本地 RPC 通道和访问控制，无新增端口或未认证 HTTP 服务。

| 方法 | 参数 | 行为 |
| --- | --- | --- |
| codex.updates.status | {} | 只读内存状态，不触发检查/默认写入 |
| codex.updates.check | {} | 刷新兼容清单、检测当前与最新版本、推进状态机 |
| codex.updates.setEnabled | {enabled:boolean} | 串行保存选择；关闭成功前先恢复原 SUAutomaticallyUpdate（包括原先缺失时删除键）；开启后立即检查 |
| codex.updates.acknowledgeNotice | {} | 确认首次默认开启说明，持久化一次性说明已读，不更改开关 |

所有方法返回同一对象：

```json
{
  "enabled": true, "defaulted": true, "noticePending": true, "supported": true,
  "phase": "waiting-compatibility",
  "currentVersion": "26.1103.1.0", "latestVersion": "26.1200.1.0",
  "error": null, "checkedAt": "2026-11-09T00:00:00.000Z",
  "compatibility": {"source":"cache","updatedAt":"2026-11-09T00:00:00Z","error":"COMPAT_UNAVAILABLE","hubVersion":"0.11.40"},
  "renderer": {"schemaVersion":1,"mode":"full","disabled":[]}
}
```

示例为 synthetic。currentVersion/latestVersion/checkedAt 可 null；启动初始化前 defaulted=false、phase=checking。supported 仅表示当前平台及环境允许挂载控制适配器，不能代表已经取得系统权限或已通过真机验收。开发/测试模式、非登录用户 HOME、非默认数据目录，以及显式 `RLY0_CODEX_UPDATE_CONTROL=0` 的环境 driver=null、supported=false，不接触原生偏好/应用控制；真实 HOME 按系统登录用户信息判定，不能用临时 HOME 冒充。macOS shell 开发模式明确注入该禁用变量，正式模式透传它。Windows supported=false，保留用户选择并检测安装版本/兼容状态，不改商店全局更新策略；latestVersion=null（无可靠的单应用商店最新版本接口）。关闭管理后不再默认开启，仍刷新兼容策略供 C 保底。

| phase | 含义 |
| --- | --- |
| checking | 初始化或用户重新开启 |
| disabled | 用户关闭管理，原设置已恢复 |
| unsupported | 当前平台无法控制自动安装（Windows 等） |
| up-to-date | 当前已达适配最新版，或 Sparkle 实际投放目标安装后体检通过；latestVersion 仍显示 feed 最大版本，可能高于当前系统/投放可安装版本 |
| waiting-compatibility | 最新版尚未适配，无期限等待 |
| downloading | 已在空闲时正常重开，等待 Sparkle 后台下载的签名暂存证据 |
| waiting-idle | 后台检查重开前，或已有签名暂存时，等连续 15 秒 fresh busy=false 心跳；不计下载超时 |
| installing | 已正常 quit，等 Desktop/本应用 updater 退出；随后为后台检查重开当前版本，或核对实际安装目标 |
| health-check | 已关回自动安装并经 Hub 重开，等真实界面体检 |
| failed | 失败；error 指明原因，不声称更新成功 |

业务错误走返回字段，不抛原始系统输出：CODEX_PREFERENCES_FAILED、CODEX_APPCAST_FAILED、CODEX_VERSION_UNAVAILABLE、CODEX_UPDATE_CHECK_FAILED、CODEX_DOWNLOAD_TIMEOUT、CODEX_INSTALL_TIMEOUT、CODEX_UPDATE_TARGET_CHANGED、CODEX_REOPEN_FAILED、CODEX_HEALTH_FAILED、CODEX_STATE_FAILED。compatibility.error 独立为 COMPAT_UNAVAILABLE、COMPAT_INVALID、COMPAT_CACHE_WRITE_FAILED 或 null；离线不掩盖已有缓存。RPC 参数错误 -32602 INVALID_PARAMS；未挂载 manager/意外路由异常 -32000 CODEX_UPDATES_UNAVAILABLE。

## 注入与 Claude 交接

renderer.mode 为 full/core/safe；旧 maintenance.compatibility 的 state 新增 core-mode。连接成功、用户旧“完整模式”选择均不能认证未知 Desktop family。open/restart 都重新判定；restart 走退出后 open，不沿用 Launcher 内部旧模式。

Hub 写入版本绑定的 codex-renderer-policy.json；Controller 每 2 秒查看，变更时先释放旧 session/新文档注入脚本，再重新建对应模式，不退出 Desktop。Controller 从 `<CODEXHOST_DATA_DIR 或 ~/.codexhost>/diagnostics/launcher-startup-v1.json` 中当前父 Launcher 的记录读取实际 Desktop 身份，不依赖是否由 Hub open。启动版本与策略不匹配、损坏或首次不可读时使用 core；运行中临时 I/O/版本读取失败沿用上次策略，版本为 null 时 Hub 不发布覆盖文件。core 只提供被动数据桥，不加载原增强 bundle、不发现 React、不改 native RPC/输入框；桥失败保留握手并退无注入，待重开再试。safe 使用既有 no-renderer。

Claude 实现额度/余额视图时可读取 `globalThis.__codexhostCoreUsageV1`，并监听 `codexhost:core-usage` 事件。形状：`{available:boolean, checkedAt:number|null, quota:{usedPercent:number,resetsAt?:number}|null, balance:{amount:number,unit:"USD"|"CNY"}|null}`。Hub alerts 周期写快照，Controller 发布；超过 10 分钟、未来时间、坏类型显示 unavailable，不造数。此工单仅提供数据桥，新增显示和提示条属于 Claude；未声称核心模式视觉已完成。

可观察 `globalThis.__codexhostFeatureFailuresV1`（失败 feature id 数组）。安装时每个可选功能独立捕获失败，禁用功能不调用 installer。使用原有界面样式，不新增视觉规范。

## macOS 更新驱动的真实边界

用本机 production-appcast-bootstrap.json 中 installationId、当前版本、实际 arch 请求官方 appcast。**不再点击“检查更新”菜单**，不需要菜单 Accessibility 权限，不伪造 Codex 启动参数、不改 App 包。

没有有效暂存时，先等持续 15 秒空闲；将 `SUEnableAutomaticChecks` 和 `SULastCheckTime` 原值（含缺失）存入 `codexUpdates.originalCheckPreferences`，再开启后台自动检查并清除上次检查日期。随后正常 quit，等退出后通过 Hub open 重开，使 Sparkle 走自己的定时后台检查。结束、失败、关闭管理或下次 Hub 初始化时，仅在辅助键仍是 Hub 写入状态（automaticChecks=1、lastCheckTime 缺失）时恢复原值；Sparkle 已写入的新检查日期保留。watchdog 在有效租约中携带辅助原值，父进程失联时也尝试恢复。SUAutomaticallyUpdate 的原值仍保留到用户关闭管理时恢复。设置未知字段容忍；originalCheckPreferences 损坏时只丢弃该辅助字段，保留 enabled、originalAutoUpdate 等已知有效字段；损坏字段不重新获取 Hub 自己写入的 false 作为原值，损坏整段保守禁用。

原生驱动先获取数据目录下 `codex-update-owner.json` 的排他控制权；同一目录内的第二个活 Hub 不得写原生设置，已退出 owner 的接管也串行化。损坏 owner 或遗留 reclaim 文件拒绝接管，需另行核验后处理，不猜测删除。

开启 SUAutomaticallyUpdate 之前，先原子写 `codex-update-armed.json`（id、at 毫秒、Hub pid、target、可选辅助偏好原值），启动独立 Node watchdog 并等 IPC ready；不可用则不开开关、不 quit。打包现在有主服务和 watchdog 两个独立入口；构建、原生开发包预检与正式包审计均要求 watchdog 存在。watchdog 每 2 秒检查父进程，父进程消失或租约损坏时关回开关；有效租约显式删除或 id 变化则退出，不动新 owner。活父进程租约过期阈值为 5 分钟；超龄或时钟跳变持续 15 次观察才关回，给睡眠唤醒后的续租留出时间。恢复写失败会每轮重读租约、重新确认归属后重试。

Hub 用独立 2 秒定时器续租，不受 appcast、codesign 或 RPC 串行队列阻塞；临时文件名唯一，关闭前等待正在进行的续租完成。驱动保留子进程退出监听；意外退出会清除 armed，下载阶段下次 tick 重新握手后再放行。操作系统持续拒绝 defaults 写入仍可能阻止恢复，需真机权限验证。本轮已实际构建隔离、ad-hoc 签名的开发 `.app`，用包内 Node 启动包内 watchdog 的同一 runner，并注入所有系统副作用；未启动 Hub 窗口，未运行真实 defaults。该结果不代表正式 DMG 或真实升级验收。

下载就绪要求 Sparkle Installation 缓存 .app 的 bundle id、候选版本与 codesign --verify --deep --strict 有效。成功签名结果按路径/身份缓存，失败探测每版本最少间隔 30 秒；quit 前重验，之后复查空闲；同一暂存身份的强制验签在 15 秒短窗口内复用，超时或身份指纹变化立即重验，计时使用单调时钟。codesign 原生超时 120 秒。下载超时仅计实际后台下载 30 分钟，持续忙/缺心跳无限等待；失败后 6/12/24 小时退避，持久记录 retryAt、失败计数、错误与终态；关闭再开启仍明确报告退避状态，不永久停在 checking。相同 feed 连续下载超时三次后暂停，直到 feed 内容变化；计数跨 Hub 重启保留，成功或 feed 变化重置，不每 5 分钟重新触发重开。已有有效暂存不再触发检查。

feed 最大版本只作展示和 feed 变化复查；读取 minimumSystemVersion，当前系统没有较新可安装条目时保持 up-to-date 而不重开；未带有效 shortVersionString 的 enclosure 拒绝整份 feed，报 CODEX_APPCAST_FAILED，不静默漏掉 Sparkle 的 build-only 候选；由于系统版本/分批投放由 Sparkle 决定，Hub 保守要求 feed 中所有较新候选均已适配，再接受其中实际签名暂存的目标（可以低于 feed 最大版本）。不在 feed、未适配或签名无效的暂存不用于安装。退出前刷新 feed，再核对最大版本未变化且所有较新候选适配；feed 此后变化的竞态仍无法在外部锁定，C 保底必须保留。低于 feed 最大版本的实际投放成功后保留 6 小时重试间隔，避免每 5 分钟重开。

应用是否运行按 `com.openai.codex` bundle id 查询；updater 按系统解析出的实际 `.app` 目录及该 bundle 的 Sparkle 缓存识别，覆盖 ChatGPT.app、Codex.app 与改名安装。无法可靠解析时拒绝认为已退出。

安装版本与暂存目标使用数值分段比较，尾部零等价（如 26.1200.1 与 26.1200.1.0）。安装等待 5 分钟、体检 60 秒。Hub 记录自己发出 quit 的日志；安装超时/驱动异常/关回开关失败也尝试重开当前已安装版本，自己的 updater 尚在运行则延后；其他软件的 updater 不阻碍恢复。quit 返回 30 秒后 Codex 仍运行时清除关闭归属：若版本已达到签名目标则进入体检，否则关回开关并失败退避，防止随后把用户自行退出误当作需要恢复。重启 Hub 仅恢复 5 分钟内且没有晚于记录的 Codex 心跳的关闭记录；旧记录直接丢弃。

官方依据：Sparkle [Customization](https://sparkle-project.org/documentation/customization/)、[SPUUpdater](https://sparkle-project.org/documentation/api-reference/Classes/SPUUpdater.html)、[Documentation](https://sparkle-project.org/documentation/)（2026-11-09 读取）。这是后台调度方案的依据，**不代表当前 Codex 已验证无弹窗、成功下载或退出即安装**。需要按 LIVE-VALIDATION.md 在获授权的独立真机环境验证偏好读取、下载目录、签名耗时、静默程度、安装/自动重开与 watchdog 权限。

## 旧 guard / 发布归属

旧用户本机 guard 位于本仓库工作树以外，不能在本任务直接改写。提供 codex-guard-handoff.patch：检测 hub-desktop.json codexUpdates.enabled=true 时仅在租约新鲜且 Hub pid 存活时让位；否则写 false 后退出，不由旧名单独立放行。需集成人员串行应用到实际脚本；本分支不修改正在运行的 guard，不激活更新管理，不上传资产。

根目录 codex-compat.json 是初始空模板，不额外认证任何版本。Claude 负责核对接口、界面、资产生成上传、版本号和发布。真机验收、独立复查、契约冻结、guard 实际部署、Windows 验收均不由本次离线测试替代。

## 交 Claude 的 v2 差异

RPC 字段、phase 枚举及错误码不新增/删除。waiting-idle 包含“后台检查前等待”，installing 包含“后台检查所需的正常重开”，downloading 不再代表点击菜单；CODEX_UPDATE_CHECK_FAILED 也覆盖 watchdog/后台准备失败，旧“辅助功能权限”专属文案需更新。低版本成功投放时 up-to-date 不表示 feed 最大版本可在当前系统安装。内部持久状态新增 originalCheckPreferences、armed/attempt/session 记录及独立 watchdog 文件；无新增外部接口、端口或远程执行能力。

第 11 条保持：restart 仍退出后 open 重新判定，设置触发的重启不会再走 Launcher 内部平滑 restart；Windows 路径原有强制退出行为可能中断未完成工作。本轮没有恢复旧路径，也没有进行真实 restart。


## 交 Claude 的 v3 差异与未决项

RPC 字段、phase 枚举、错误码不变。supported=false 也包括开发/隔离/明确禁用控制的环境，显示层需避免一律解释成 Windows 不支持。退避重新开启会返回 failed 和保留的错误；连续三次下载超时会等 feed 变化，不自动按时间重开。原有 CODEX_INSTALL_TIMEOUT 也涵盖 30 秒后退出被取消。以上文案交 Claude，本轮未改 apps/hub-desktop/www。

N5 未决：默认仍为连续 15 秒 fresh busy=false，不把它认定为最终“空闲”产品规则。所有退出前判断统一经过可注入的 CodexIdleDriver（options.idle），默认适配 options.busy；用户定稿后替换一个驱动即可。

本轮仅 self_verified，安全敏感更新控制尚无修复后独立审查。真实 Sparkle 静默下载/升级、系统权限、Windows、guard 实际部署及与睡眠唤醒互操作均待独立授权环境验收；不构成发布放行。

## v3.1（Claude，2026-11-09 20:30）：N5 用户定稿已接入
“没在用 Codex”= 心跳 busy=false **且** 系统键盘鼠标空闲 ≥5 分钟（`ioreg -c IOHIDSystem` 的 HIDIdleTime）；任一读不到按“在用”。实现：`codex-input-idle.ts` 的 `codexIdleFromBusyAndInput`，由 service.ts 作为 `options.idle` 注入；manager 原有连续 15 秒复核仍叠加其上，退出前复查经同一驱动。界面：waiting-idle 显示“等你离开电脑 5 分钟后开始更新”；Mac 上 supported=false 显示“测试版 Hub 不管理 Codex 更新”，不再误称 Windows。

## v3.2（Claude，2026-11-09）：第三轮复查修复

基线 a937545e。复查报告 CODEX-VERSION-GATE-REVIEW-3.md 第 1、2、3、5、6 条已修，第 4 条只做后台原因字段。仅 self_verified（隔离离线测试），未经独立复查与真机验收。

- **安装目录解析（#1）**：任何阶段不再使用会启动应用的查询（`path to application`、无保护的 `tell application`）。退出前 Codex 仍在运行时执行 `/usr/bin/lsappinfo info -only bundlepath -app com.openai.codex`，同时解析 `"LSBundlePath"="…"` 与 `bundle path="…"`（本机 2026-11-09 只读实测为后者）；取不到时后备 `<CODEXHOST_DATA_DIR 或 ~/.codexhost>/diagnostics/launcher-startup-v1.json` 中最新一条 `desktop.installRoot`（`.app` 绝对路径）。两者都没有则不退出，报 CODEX_UPDATE_CHECK_FAILED。Hub 重启后的恢复只能用 Launcher 记录。quit 改为 `if application id "com.openai.codex" is running then tell … to quit`，Codex 已退出时不会被拉起。
- **watchdog 打包（#2）**：`buildHubServiceBundle` / `auditHubServiceBundle` 增加平台参数（darwin|win32，命令行 `--platform` 必填）；只在 darwin 产出 `app/codex-update-watchdog.js`，win32 构建删除同目录残留并在审计时拒绝它。Windows `build.ps1` 显式传 `--platform win32`；Mac 开发包与正式包传 darwin。Mac 验证包 `verify-kit.mjs` 必备清单加入 watchdog。Windows 载荷白名单未改。
- **停服务与控制锁（#3）**：服务入口处理 SIGTERM/SIGINT，与 stdin 关闭共用同一次 `dispose`（停 manager、释放 `codex-update-owner.json`）后退出 0；释放卡住 10 秒退出 1。owner 记录新增可选 `startedAt`（`ps -o lstart=` 原文，经驱动注入的 exec 读取）。判定已失效：kill(pid,0) 得 ESRCH 或 EPERM；记录的 startedAt 与该 pid 当前启动时间不同；pid 等于本进程但 id 不是本进程持有的锁。读不到启动时间时按仍存活处理；其他探测错误照常抛出。
- **watchdog 退出回调（#5）**：回调绑定启动它的租约 id，只有该 id 仍是当前租约时才清除 armed。
- **渲染策略记录（#6）**：按父 pid 找 Launcher 记录时取数组中第一条（Launcher 新记录插在最前），pid 复用时得到最新记录。
- **不支持原因（#4 后台部分）**：status 在 supported=false 且原因已知时带可选 `unsupportedReason`：`platform`（非 macOS）、`control-disabled`（开发/测试模式或显式 `RLY0_CODEX_UPDATE_CONTROL=0`；macOS 开发壳注入此变量，因此与用户手动关闭无法区分）、`environment`（正式 Hub 但 HOME 或数据目录不是登录用户默认位置，如数据目录改到外接盘）。supported=true 时不出现该字段。RPC 方法、phase、错误码不变。“环境由允许变不允许后之前写入的 false 不恢复”未处理，界面文案交 Claude 界面工作另做（本轮未改 apps/hub-desktop/www）。

仍需真机：lsappinfo 在 Codex 退出过程中的输出、Launcher 记录在真实安装上是否为 `.app` 路径、正式包 SIGTERM 后锁文件确实删除、Windows 实际 `build.ps1` 打包、第 7 条各项（appcast 是否有缺 shortVersionString 条目、锁屏/睡眠下 HIDIdleTime、Deskflow、Sparkle 2 安装进程命令行形态）。

## v4（Claude，2026-11-09）：真机实测修复

基线 2903656c。依据 `.runtime/live-validation-20261109/observe.jsonl`。仅 self_verified（隔离离线测试），未经独立复查与真机验收。RPC 方法、phase、错误码不变。

### 研究结论（Codex Desktop 26.1103.41825，app.asar sha256 前缀 766faa8a3da8f6d6，只读解包后已删除）

- **发送位置**：webview 异步块 `366057.*.js` 中一个 `useEffect` 调用 `dispatchMessage("electron-sparkle-gates-changed", {preferMxc, disableInAppUpdates, disableSparkleAutodownload, useBackendAppcast, useInternalUpdateCdn:false, useWindowsCoreRuntimeFrameworks, useWindowsPrimaryRuntimeFrameworks})`。`disableInAppUpdates` 在账户/功能列表未就绪时为 `null`，就绪后为布尔。依赖项是各服务器开关值：挂载时发一次，此后只在开关值变化时再发，没有可以请求重发的消息。
- **通道**：`dispatchMessage` → `SITX.F.postMessage({...payload, type})`。每次调用都读取 `window.electronBridge.sendMessageFromView`（preload 通过 `contextBridge.exposeInMainWorld("electronBridge")` 暴露，内部是 `ipcRenderer.invoke("codex_desktop:message-from-view")`），随后用同一对象派发 window 事件 `codex-message-from-view`（detail）。Codex 没有开启 Electron 的 `ContextBridgeMutability`，暴露的桥对象按 Electron 默认被深冻结、只读且不可重定义，页面脚本无法包装或替换发送函数。
- **主进程**：`early-bootstrap-854` 中的 `ipcMain.handle("codex_desktop:message-from-view")` 收到该消息后依次执行：`disableInAppUpdates!=null` 时调用 `latchInAppUpdatesEnabledForLaunch(!disableInAppUpdates)`；`setAutomaticBackgroundDownloadsEnabled(!disableSparkleAutodownload)`；`setBackendAppcastEnabled(useBackendAppcast)`（写 production-appcast-bootstrap.json）；把 useInternalUpdateCdn、preferMxc、Windows 运行时开关写入 `.codex-global-state.json`。
- **latch 语义**（`early-bootstrap-339` 中的 updater 类）：每次启动的策略初始为 `pending`，并设有 5 分钟定时器，到时自动放行。第一次非空 latch 决定本次启动：true → `allowed` 并初始化 Sparkle（`initializeMacSparkle` 以当前 `automaticBackgroundDownloadsEnabled` 设置 sparkle.node，然后立即做一次后台检查）；false → `denied`，本次启动不再初始化 updater。之后的 latch 只记录 `latestInAppUpdatesEnabled`；它与已定策略相反时，`hasInAppUpdatesPolicyChanges()` 为真，在账户更新或配置刷新时**弹出“需要重启以应用策略”的对话框并重启 Codex**。`setAutomaticBackgroundDownloadsEnabled` 只在值变化时转发给 sparkle.node；值为 true 时**仅在旧 feed（useBackendAppcast 为假）下**立即触发一次后台检查（代码为 `e&&!a&&d()`，a 即生产 appcast），生产 appcast 路径不立即检查（v5 更正）。
- **注入时机**：生产 Launcher 只开放渲染进程 CDP，不开放主进程 inspector（`main-process-title-policy` 不在生产路径中），因此不能在主进程拦截。full 模式虽然登记了 new-document 脚本，但会对已加载的页面直接 evaluate，不重载页面；core 模式只做 evaluate。所以本次启动的第一条 gate 消息通常早于注入。

### 拦截（desktop-control `codex-update-hold.ts`）

- 一段自包含函数（通过 toString 注入，不依赖 React/DOM/Codex 模块）。full 模式把它放在增强 bundle 之前（同时进入 new-document 脚本）；core 模式放在被动数据桥之前，各自用独立的 try 包住。safe 模式和 `--no-renderer` 不注入，**无法拦截**。
- 监听 `codex-message-from-view`。看到 gate 消息且 hold=true、`disableSparkleAutodownload!==true` 时，立即通过同一个桥发送纠正副本：`{...原消息, disableSparkleAutodownload:true, disableInAppUpdates:null}`。`null` 使主进程跳过 latch，不改变本次启动的策略，从而避免上述“重启以应用策略”的对话框。其他字段原样复制，避免改写 Codex 持久化的 appcast/CDN 设置。hold=false 时原样放行，不发送任何消息。
- 失败安全：识别不了的 gate 形态（`disableSparkleAutodownload` 不是布尔值，或某个字段不是基本类型）、桥不存在、发送被拒、页面没有 addEventListener，这些情况都不发送消息，在 `__codexhostFeatureFailuresV1` 中记录 `update-hold`，并在 `globalThis.__codexhostUpdateHoldV1.error` 中写明原因（`unknown-shape` / `bridge-unavailable` / `send-failed` / `listener-unavailable` / `listener-failed`）。状态对象还提供 `hold/observed/sent/replayed` 供诊断。
- **错过首条消息的补救（v5 已删除，见下）**：每看到一条真实 gate 消息，就把它存到页面自己的 localStorage（键 `codexhost.sparkle-gates.v1`）。处于 hold 状态的页面安装脚本时，如果有存档，立即按上述方式发送一份纠正副本（`replayed=true`）。存档字段来自上一次看到的消息，若这些服务器开关在两次启动之间变了，可能把 useBackendAppcast 等暂时写回旧值，直到下一条真实消息出现；只在 hold 期间发生。hold 从 false 变为 true 时（例如放行失败后重新压住），会重发最后一条真实消息的纠正副本。从来没见过 gate 消息的全新环境没有补救手段。
- **剩余竞态**：首条真实消息、Sparkle 初始化和启动时的那次检查，可能在注入之前就已经开始下载。拦截只能把后续的下载决定改成“不自动下载”，已经在进行的下载可能继续，退出时可能被安装。若要彻底消除，需要在页面脚本运行前注入（例如 controller 在浏览器级 CDP 使用 `Target.setAutoAttach` + `waitForDebuggerOnStart`，或改由 Launcher 开放主进程），这涉及 Launcher/controller 启动时序，本轮未做，需要另立工单。
- **Hub 下发**：`codex-renderer-policy.json` 顶层新增 `holdUpdates:boolean`，与 `policy` 并列。旧 controller 严格解析 `policy`，但会忽略顶层未知键，因此放在顶层是兼容的。启动环境变量 `CODEXHOST_RENDERER_POLICY` 不带这个字段。新 controller 读取后合入 `CodexRendererPolicy.holdUpdates`（schema 新增可选布尔）；版本不匹配回落 core，或文件缺少 policy 时，仍保留该值（hold 与 Desktop 版本无关）。文件不存在时不带该字段，等同放行。只有 hold 变化时，controller 不重建会话，由监控循环把 `setHold` 推送到当前页面，失败则下一轮重试。
- **取值**：`holdUpdates = driver 存在（macOS 原生控制可用）&& 用户开启管理 && 没有处于放行租约中（#armed）`。`#arm` 先发布 false，再打开 SUAutomaticallyUpdate 并 quit，让重开的 Codex 能够下载；`#disarm` 发布 true。用户关闭管理、Windows 或开发/隔离环境下为 false，即放行。发布失败时回滚内存值，下次请求再写。

### reopen 确认（manager `#recoverClosed`）

- 实测：开发版 Hub 的 `bin/codexhost` 包装脚本发现仍有 `/bin/codexhost launch` 进程时，直接 exit 0，什么也不做；旧 Launcher 尚未退出时，Hub 却把这当成已重开，结果 Codex 被关了 38 分钟。
- 现行为：确认 Codex 与 updater 已经退出后，最多等待 30 秒，直到驱动的 `launcherRunning()` 为假（`ps -axo args=` 中没有 `…/bin/codexhost` 或 `…/bin/codexhost launch …`；`inspect` 等子命令不算）。随后最多发起 4 次启动，每次后用 `isRunning()` 每 3 秒确认，最长 15 秒。确认运行后才释放关闭归属。4 次都失败则报 `CODEX_REOPEN_FAILED`，但保留归属，60 秒后由周期 tick 再试，直到 Codex 运行或用户自己打开。正式安装包的真 Launcher 走同一流程。Hub 停服时（`stop()`，10 秒预算）只发一次启动，不做等待确认。

### 退避时恢复检查日期

- 实测：22:31 后台检查重开时 Hub 删除了 SULastCheckTime；23:01 下载超时后开关被关回，但 SULastCheckTime 一直为空，`originalCheckPreferences` 留在设置里，尝试记录也停在 22:31。
- 根因：macOS 27.2（26B123）的 `defaults read/delete` 对缺失的键输出 `Error: Could not find key 'K' in domain 'D'.`，对缺失的域输出 `Error: Domain 'D' not found.`，旧代码只认 `does not exist`。于是 `restoreCheckPreferences` 读到被删的 SULastCheckTime 时抛错，`#disarm` 把它当成 `CODEX_PREFERENCES_FAILED`，既没写回日期，也没保存尝试记录。watchdog 的恢复路径有同样问题。另外，原值缺失时 `readAutoUpdate` 也会抛错。
- 修复：`defaultsValueMissing` 同时识别新旧文本，驱动和 watchdog 共用。`#disarm` 在偏好恢复失败时仍保存退避记录。

仍需真机：纠正消息在主进程的处理顺序与 sparkle.node 的实际效果（SUAutomaticallyUpdate 是否保持 0、不下载、不弹窗）；首条消息早于注入的频率；localStorage 存档在真实页面中能否写入；开发版包装脚本与正式 Launcher 的 `ps` 形态；正式 Launcher 在 Codex 退出后多久退出；macOS 27 上 watchdog 实际写回检查日期。

## v5（Claude，2026-11-10）：提前注入（B1）与第五轮复查修复

基线 2e5d245d。依据 CODEX-VERSION-GATE-REVIEW-5.md。仅 self_verified（隔离离线测试），未经独立复查与真机验收。RPC 方法、phase、错误码不变；status 新增一个可选字段（见“交 Claude”）。Launcher（Rust）未改。

### v4 更正

v4“研究结论”中“值为 true 时立即触发后台检查”只适用旧 feed；生产 appcast 路径（useBackendAppcast 为真）不立即检查，原文已就地更正。

### 浏览器级自动附着（desktop-control `early-update-hold.ts`）

- controller 读到首份策略后（非 safe、非 `--no-renderer`）立即启动：轮询 `/json/version`（前 200 次每 50 ms，之后每 1 s）→ 连接浏览器 websocket → 先挂 `Target.attachedToTarget` / `detachedFromTarget` 监听，再发 `Target.setAutoAttach {autoAttach:true, waitForDebuggerOnStart:true, flatten:true}`，随后 `Target.getTargets` 补附着 setAutoAttach 没报到的 Codex 页面。
- `attachedToTarget`：`targetInfo.type==="page"` 且 URL 为空、`about:blank` 或 `app://` 开头的页面：在该 session 依次 `Page.enable` → `Page.addScriptToEvaluateOnNewDocument`（只放 hold 小脚本，当前值）；`waitingForDebugger:false`（已存在的页面）再立即 `Runtime.evaluate` 同一脚本（hold 是第一步）。其他类型与非 Codex 页面不登记脚本，立即放行并 `Target.detachFromTarget`。放行（`Runtime.runIfWaitingForDebugger`）在 `finally` 中执行，准备步骤最长 2 秒（超时或报错照样放行，只记 trace）。
- 连接常驻：新文档脚本随 session 存在，断线即清空本地页面表，1 秒后重连并按当前值重新附着/登记。controller 退出、或策略转为 safe 时中止。
- hold 变化：controller 每 2 秒读策略，值变化时调用 `setHold`：对每个页面串行执行“移除旧新文档脚本 → 按新值重新登记 → `Runtime.evaluate` 推送”；断线期间的变化由下次连接按新值登记。
- 不可用时（端点连不上、附着失败）：页面注入里捆绑的 hold 脚本照常工作（事件纠正），只是可能错过本次启动的首条 gate 消息；**不再补发任何旧存档**。

### hold 脚本（`codex-update-hold.ts`）

- 删除 localStorage 存档与补发（M2）：不读写 `codexhost.sparkle-gates.v1`，状态对象去掉 `replayed`。hold 从 false 变 true 时仍重发**本页本次**看到的最后一条真实消息的纠正副本。
- 新增第三个参数 `override`：浏览器级会话登记的副本为权威（已安装时调用 `setHold`）；full/core 注入捆绑的副本是后备，页面已有 hold 时不改其值（`codexUpdateHoldFallbackScript`）。
- M1：controller 不再记 `pushedHold`，监控循环每轮（500 ms）推送幂等表达式（值不同才 `setHold`），页面重载/会话重装后带旧值的后备脚本也会在下一轮被纠正；有浏览器级会话时，重载页面先运行按新值重登记的权威脚本，后备脚本不覆盖。

### 策略文件（L6）

- Hub 进程内 hold 初值为“未知”，第一次发布一定落盘。Desktop 版本未知时只改现有文件的 `holdUpdates`，保留 `desktopVersion/policy`；文件不存在且 hold=false 时不创建文件。
- controller：只有 `holdUpdates`、没有 `desktopVersion` 与 `policy` 的文件视为“尚未发布策略”，沿用启动环境 `CODEXHOST_RENDERER_POLICY`（与文件不存在相同）并带上 hold；只缺其中一个仍按损坏回落 core。

### 重开（`codex-reopen.ts`，manager 调用）

- 每轮：Codex 已运行即成功；updater 未退出则下轮再看；等旧 Launcher 退出最多 30 秒后发起启动；每次启动后确认 30 秒（≥ Launcher 自身 30 秒启动超时）；未确认时再等该 Launcher 退出最多 30 秒，**仍在运行就结束本轮、不再发第二次启动**（L3）；每轮最多 2 次启动。`launcherRunning()` 报错按“正在运行”处理。
- 失败后 60 秒重试；从第一次失败起满 30 分钟放弃：释放关闭归属、删除会话记录、保留 `failed / CODEX_REOPEN_FAILED`（L4）。
- 停服（`stop()`）：忽略重试暂停（L1）；Launcher 仍在运行或无法确认时不发启动；发了启动也不删会话记录，由下次 Hub 启动按 5 分钟规则恢复，Codex 已运行时才删（L2）。

### 其他

- L5：`setEnabled` 发布 hold 失败时返回 `failed / CODEX_STATE_FAILED`（不进退避）；每次 `check()` 在发布策略后重算并发布 hold。未初始化即关闭的路径也发布 hold。
- L7：关闭管理发布 hold=false（已核对）。`hub.restorePure` 新增步骤 `steps.codexUpdates`：调用 `setEnabled(false)`，恢复原 SUAutomaticallyUpdate 并发布 hold=false；成功条件为无错误且已关闭。停服不改 hold：与停服后 SUAutomaticallyUpdate 保持 0 的语义一致。**这是产品决定，需用户确认**：恢复纯净会把“由 Hub 管理 Codex 更新”一并关掉，之后不会自动重新开启。
- L8：见下。

### 交 Claude（界面，本轮未改 apps/hub-desktop/www）

- status 新增可选 `reopening: true`：仅当 Hub 正在重开它关掉的 Codex 时出现（一轮最长约 2.5 分钟，期间其他请求排队）。建议文案“正在重新打开 Codex…”，与 phase 并列显示；字段缺失即未在重开。phase 枚举不变。
- `hub.restorePure` 的 `steps` 多一项 `codexUpdates`；恢复纯净的说明文案需提到会关闭 Codex 更新管理（待用户确认上条产品决定）。
- `CODEX_REOPEN_FAILED` 现在可能是“已放弃重试”：文案需提示用户自己打开 Codex。

### 仍需真机

- Codex 渲染端口是否早于首个窗口开放（打点：controller 附着时间 vs 首条 gate 消息）；首个页面在 `waitingForDebugger` 时的 `targetInfo.url` 实际值。
- controller 崩溃 / websocket 断开时被暂停的页面是否由 Chromium 自动放行（不白屏）。
- 浏览器级 session 存在时 `/json/list` 仍给出页面 `webSocketDebuggerUrl`，现有按页连接与 renderer-host owner 清理不受影响。
- 新文档脚本在 Codex 真实页面中先于 webview 异步块运行，首条 gate 消息被纠正；SUAutomaticallyUpdate 保持 0、不下载、不弹“重启以应用策略”。
- 重开：正式 Launcher 在 Gatekeeper 校验新包时的 `ps` 形态与耗时；30 分钟放弃后的提示。


## v6（Claude，2026-11-10）：第六轮复查修复

基线 6d45a727。依据 CODEX-VERSION-GATE-REVIEW-6.md。仅 self_verified（隔离离线测试 + 临时无头 Google Chrome 157 集成测试），未经独立复查与 Codex 真机验收。RPC 方法、phase、错误码不变；status 新增一个可选字段（见“交 Claude”）。Launcher（Rust）未改。

### 暂停目标一定放行（#1）

- Chrome 157 实测：`waitForDebuggerOnStart` 暂停的目标在**断开连接、detach、`setAutoAttach{autoAttach:false}`**（它会 detach 所有自动附着会话）之后都不会被自动放行，窗口一直空白；重连时 `setAutoAttach` 把它报成 `waitingForDebugger:false`；对它（重新附着后）发一次 `Runtime.runIfWaitingForDebugger` 立即恢复。
- 现行为：每个附着到的目标（含 `waitingForDebugger:false`）在准备结束后一律发放行；放行成功前记在本连接的“未确认放行”表中。
- 主动停止（controller 退出、切 safe、附着失败、连接断开后的清理）：先 `Target.setAutoAttach{autoAttach:false, waitForDebuggerOnStart:false, flatten:true}`（浏览器级必须带 flatten），再对“未确认放行”表中每个目标 `Target.attachToTarget{flatten:true}` → `Runtime.runIfWaitingForDebugger` → `Target.detachFromTarget`，最后关闭连接。停止期间新报到的附着也只放行并 detach。
- 每条 CDP 命令 2 秒超时（`commandTimeoutMs`），准备阶段 2 秒（`releaseTimeoutMs`）；全部命令卡住时停止也会结束。
- **残留风险**：controller 进程被强杀时没有机会放行；暂停窗口只有准备阶段（毫秒级到最多 2 秒），被卡住的窗口要等下一个 controller 连上（重连路径会放行）。

### 中止与串行（#2）

- `connectBrowser(endpoint, signal)`：`/json/version` 带 signal 与 2 秒超时（`getCdpBrowserVersion` 新增第三个参数 `{signal, timeoutMs}`，注入的 fetch 不理 signal 时也会结束）；连接返回后若已中止，直接关闭、不发任何命令。
- controller 每次启动新一轮自动附着时传入 `after`（上一轮的 `finished`），上一轮停完（放行 + 关闭）后才连接；退出时等待最后一轮结束。safe → full 不会同时存在两条自动附着。

### 主窗口是否先于页面脚本（#3）

- Chrome 157 实测（`early-update-hold.chromium.test.ts`）：`window.open` 打开的新窗口附着时 URL 为空、暂停，hold 新文档脚本先于页面脚本运行（`holdBeforePage:true`，首条 gate 被纠正）。`Target.createTarget`（同一连接或另一连接）与 `/json/new` 带 URL：附着报 `waitingForDebugger:true` 但页面脚本已跑过，新文档脚本对当前文档不再运行。tab 级附着（浏览器层 `filter:[{type:"tab"}]`，tab 会话再 `setAutoAttach`）对这三种方式同样无效（page 报 `waiting:false`，脚本已跑），**不采用，保持浏览器级附着**。
- Codex 主窗口由主进程 `BrowserWindow.loadURL` 创建，更接近 createTarget（浏览器发起）还是 window.open，需真机确认。
- 补救：放行后立即探测页面；Codex 文档中没有 hold 时立即补装（权威副本，`lateInstall:true`）。
- hold 状态对象新增诊断字段：`lateInstall`（安装时文档已解析或运行过页面脚本：`document.readyState!=="loading"` 或已有 `<script>`）、`source`（`early`/`fallback`）、`installedAt`、`firstGateAt`（`performance.now()` 取整）。“首条 gate 是否早于安装”无法在页面内直接观测（安装前的事件不可见），以 `lateInstall` 作为必要条件判断。
- controller 写 `<CODEXHOST_DATA_DIR 或 ~/.codexhost>/diagnostics/codex-update-hold-v1.json`（原子写，0600）：

```json
{ "schemaVersion": 1, "pid": 123, "startedAt": 0, "updatedAt": 0,
  "state": "attached", "connections": 1, "firstAttachedAt": 0, "codexPages": 1,
  "holdBeforePageScripts": true,
  "mainWindow": { "waitingAtAttach": true, "attachedUrl": "empty", "installed": true,
    "lateInstall": false, "source": "early", "observed": 1, "sent": 1, "error": null,
    "installedAt": 4, "firstGateAt": 5 } }
```

  `state`：connecting/attached/stopped；`attachedUrl`：empty/about:blank/codex（不含 URL）；`mainWindow` 为第一个 Codex 文档；`holdBeforePageScripts`：true=早期会话在主窗口页面脚本前装上（首条 gate 可纠正），false=晚装，null=未知。下次真机实测直接读此文件判断 B1 对主窗口是否有效；若为 false，需改由 Launcher 先起 controller 或开放主进程（另立工单）。

### 其他

- #4：hold 脚本先判 `location.protocol === "app:"`（第四个参数，默认 `app:`，仅测试改用 `http:`），非 Codex 文档（登录页、about:blank）不安装、不记失败。
- #6：manager `stop()` 打断正在轮询的重开（每次轮询前检查停止，轮询等待与停止信号竞速）；被打断的一轮不计失败，随后按停服规则最多发一次启动。
- #5（后台）：见下。

### 交 Claude（界面，本轮未改 apps/hub-desktop/www）

- status 新增可选 `reopenGivenUp: true`：仅当 `error === "CODEX_REOPEN_FAILED"` 且 Hub 已放弃重试（第一次失败起满 30 分钟）时出现。缺失时 `CODEX_REOPEN_FAILED` 表示“仍在每 60 秒重试”，建议文案“重新打开 Codex 失败，正在重试…”；出现时建议“已停止自动重新打开，请手动打开 Codex”。错误码不变。

### 仍需真机

- Codex 主窗口（loadURL）附着时是否暂停、URL 为空还是 app://，`codex-update-hold-v1.json` 中 `holdBeforePageScripts` 的实际值。
- controller 被强杀后 Launcher 是否重起 controller（决定被卡窗口能否自动恢复）。
- 上轮 v5“仍需真机”各项仍然有效。

## 2026-11-11：压住期间抑制官方新版提醒

输入 `5d07cdaf`，实现与检查跨至 2026-11-12；工单 `HUB-CODEX-UPDATE-ALERT`。范围为后台、隔离测试和文档；RPC、status 字段、phase 和错误码不变。仅 self_verified，修复后独立审查和真机验收未完成。

### 本机机制依据

只读核实 `/Applications/ChatGPT.app`（bundle id `com.openai.codex`，Codex `26.1103.60933` / build `25894`）内置 Sparkle `2.9.1` / build `2054`。普通版本跳过键为 `SUSkippedVersion`，类型 NSString；值来自 appcast 的 `sparkle:version`，不是展示用 `sparkle:shortVersionString`。该 build 及更低 build 会被 Sparkle 后台候选过滤。`SUSkippedMajorVersion`、`SUSkippedMajorSubreleaseVersion` 为另一种跳过语义；`CodexSparkleSeenUpdateVersions` 是 Codex 原生插件的已关注提醒数组，不能代替候选跳过键。Hub 不读写后三个键。

完整版本、哈希、ASAR 文件/字符偏移及 native/framework arm64 位置见 [RESEARCH.md](evidence/codex-update-alert-20261111/RESEARCH.md)。ASAR 仅在临时目录提取研究并已删除，App 包未修改。没有改首条 `disableInAppUpdates` latch，也不以关闭自动检查替代这一控制。

### 压住、放行与关闭管理

- Mac 驱动保留 feed 的 `{version, build}` 映射；选择“比已装版本更新且未适配”的候选中最大的 build，以 `defaults write com.openai.codex SUSkippedVersion -string <build>` 写入。多个候选、同一展示版本的不同 build 均参与判断。缺失/无效 build 拒绝压窗操作并报 `CODEX_APPCAST_FAILED`，不拿展示版本猜测。最低系统版本筛选不删除压窗所依据的候选；既有安装适配门槛保持保守。
- 在首个 native 写入前，以原子替换保存 `<dataDir>/codex-update-skipped-version.json`：`{schemaVersion:1, original:string|null, written:string, previous?:string}`。`null` 表示原键缺失；替换 Hub 旧写值时 `previous` 临时保留另一个可能的已写值，覆盖进程崩溃和成功响应丢失。成功读回后收敛为一个 written。记录限 4 KiB，版本限 100 字符；损坏记录保留并阻止放行，不能猜测归属后删除。
- 已有相同或更高的用户跳过值不认领、不降低；其他原值在暂时覆盖前保存。写前再读一次，若用户已改值则本轮失败，不覆盖它。恢复只在当前值严格等于记录中的 Hub 写值时写回 original；原值缺失则删除键。当前是用户新值/用户删除时保留它，只清理自己的记录。defaults 不提供原子 compare-and-swap；最终比较与写入之间仍有跨进程竞争，不能宣称完全锁住用户或 Sparkle。
- 兼容清单适配后，仍等“无任务且键鼠 5 分钟未动”，再经既有连续 15 秒复核。**实际 arm 前**先恢复 Hub 的跳过值并清理成功，再建租约、启动 watchdog、发布 `holdUpdates:false`、开启自动下载和请求后台检查。恢复失败报 `CODEX_PREFERENCES_FAILED`，保持 hold，不建租约、不下载、不 quit；用户手动跳过的版本即使已适配也继续保留。
- feed 定期检查在原生更新退避期间仍更新压窗阈值，不重新触发下载/重开；长时间等待空闲或下载时，定期检查也刷新 feed，发现新未适配候选则压窗并回到兼容等待。两次检查之间新 feed 的出现仍存在观察间隔。
- 关闭管理先停止续租、关回下载并撤销租约，再恢复检查辅助偏好和自己的跳过值，最后恢复原自动下载值并保存 disabled、释放 renderer hold。任何恢复失败保留管理状态和恢复记录，供重试；不把失败当成已关闭。

### 崩溃与 watchdog

管理仍开启时 Hub 正常停服或崩溃均保留跳过记录；下次启动继续原始归属，不把 Hub 自己的跳过值当用户原值。离线/坏 feed 不丢掉已有压窗。关闭管理可不依赖成功读取 feed 进行恢复，初始化快捷退出前也核对是否有跳过记录。

跳过记录独立于 release lease，撤销完成后才能创建 lease，lease 不携带旧跳过快照。watchdog 只关回 `SUAutomaticallyUpdate` 并按原有比较规则恢复检查辅助键；不清理新 owner 的跳过记录、不重写用户的新值，也不重新写回已放行的旧跳过值。偏好命令封装与日期恢复由驱动/watchdog 共用，测试注入每条系统命令。

### 验收边界

测试环境同时隔离 HOME、USERPROFILE、CODEX_HOME、CODEXHOST_DATA_DIR、RLY0_MEMORY_DIR，设置 `RLY0_SKIP_LEGACY_IMPORT=1`、`RLY0_CODEX_UPDATE_CONTROL=0`；defaults、进程/系统查询、quit、watchdog 均由注入驱动执行，未另起 hub-service。证据见 [RESULTS.md](evidence/codex-update-alert-20261111/RESULTS.md)。

仍需获准独立真机：运行中 Sparkle 对外部 defaults 变动的读取时机、后续定时检查是否完全无窗口、已经显示的窗口是否仍需手动关闭、适配后空闲后台下载/退出安装、用户关闭管理/崩溃恢复及真实 watchdog 权限。显式手动检查可能忽略 Sparkle 跳过值；本修复抑制定时提醒，不承诺强制禁止用户所有手动更新入口。feed 变化竞争与 B1 原有真机缺口仍保留，未推送、发布或改日常进程。
