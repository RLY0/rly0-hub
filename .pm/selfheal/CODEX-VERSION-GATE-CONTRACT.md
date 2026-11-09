# HUB-CODEX-VERSION-GATE contract v2 (review fixes)

状态：Codex 技术定义，待 Claude 核对；未发布。基线：79fc26e8；工单：HUB-CODEX-VERSION-GATE。

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

示例为 synthetic。currentVersion/latestVersion/checkedAt 可 null；启动初始化前 defaulted=false、phase=checking。supported 仅表示当前平台有控制适配器，不能代表已经取得系统权限或已通过真机验收。Windows supported=false，保留用户选择并检测安装版本/兼容状态，不改商店全局更新策略；latestVersion=null（无可靠的单应用商店最新版本接口）。关闭管理后不再默认开启，仍刷新兼容策略供 C 保底。

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

Hub 写入版本绑定的 codex-renderer-policy.json；Controller 每 2 秒查看，变更时先释放旧 session/新文档注入脚本，再重新建对应模式，不退出 Desktop。Controller 从当前父 Launcher 的 launcher-startup-v1.json 记录读取实际 Desktop 身份，不依赖是否由 Hub open。启动版本与策略不匹配、损坏或首次不可读时使用 core；运行中临时 I/O/版本读取失败沿用上次策略，版本为 null 时 Hub 不发布覆盖文件。core 只提供被动数据桥，不加载原增强 bundle、不发现 React、不改 native RPC/输入框；桥失败保留握手并退无注入，待重开再试。safe 使用既有 no-renderer。

Claude 实现额度/余额视图时可读取 `globalThis.__codexhostCoreUsageV1`，并监听 `codexhost:core-usage` 事件。形状：`{available:boolean, checkedAt:number|null, quota:{usedPercent:number,resetsAt?:number}|null, balance:{amount:number,unit:"USD"|"CNY"}|null}`。Hub alerts 周期写快照，Controller 发布；超过 10 分钟、未来时间、坏类型显示 unavailable，不造数。此工单仅提供数据桥，新增显示和提示条属于 Claude；未声称核心模式视觉已完成。

可观察 `globalThis.__codexhostFeatureFailuresV1`（失败 feature id 数组）。安装时每个可选功能独立捕获失败，禁用功能不调用 installer。使用原有界面样式，不新增视觉规范。

## macOS 更新驱动的真实边界

用本机 production-appcast-bootstrap.json 中 installationId、当前版本、实际 arch 请求官方 appcast。**不再点击“检查更新”菜单**，不需要菜单 Accessibility 权限，不伪造 Codex 启动参数、不改 App 包。

没有有效暂存时，先等持续 15 秒空闲；将 `SUEnableAutomaticChecks` 和 `SULastCheckTime` 原值（含缺失）存入 `codexUpdates.originalCheckPreferences`，再开启后台自动检查并清除上次检查日期。随后正常 quit，等退出后通过 Hub open 重开，使 Sparkle 走自己的定时后台检查。结束、失败、关闭管理或下次 Hub 初始化时恢复这两个辅助键的原值。SUAutomaticallyUpdate 的原值仍保留到用户关闭管理时恢复。设置未知字段容忍；损坏字段不重新获取 Hub 自己写入的 false 作为原值，损坏整段保守禁用。

开启 SUAutomaticallyUpdate 之前，先原子写 `codex-update-armed.json`（id、at 毫秒、Hub pid、target），启动独立 Node watchdog 并等 IPC ready；watchdog 不可用则不开开关、不 quit。watchdog 每 2 秒读取租约，父进程消失、租约超过 60 秒/未来时间/损坏时写 false；显式删除或更新 id 时退出，不碰已恢复的原设置。Hub 每个 active tick 更新租约。watchdog 与 manager 独立，Hub SIGKILL 后不依赖下一次 Hub 启动或外部 guard；操作系统拒绝 defaults 写入仍可能阻止恢复，需真机权限验证。本轮测试仅注入驱动，没有启动真实 watchdog。

下载就绪要求 Sparkle Installation 缓存 .app 的 bundle id、候选版本与 codesign --verify --deep --strict 有效。成功签名结果按路径/身份缓存，失败探测每版本最少间隔 30 秒；quit 前强制重验，之后复查空闲。codesign 原生超时 120 秒。下载超时仅计实际后台下载 30 分钟，持续忙/缺心跳无限等待；失败后 6/12/24 小时退避（进程内递增，持久记录当前 retryAt），不每 5 分钟重新触发重开。已有有效暂存不再触发检查。

feed 最大版本只作展示和 feed 变化复查；由于系统版本/分批投放由 Sparkle 决定，Hub 保守要求 feed 中所有较新候选均已适配，再接受其中实际签名暂存的目标（可以低于 feed 最大版本）。不在 feed、未适配或签名无效的暂存不用于安装。退出前刷新 feed，再核对最大版本未变化且所有较新候选适配；feed 此后变化的竞态仍无法在外部锁定，C 保底必须保留。低于 feed 最大版本的实际投放成功后保留 6 小时重试间隔，避免每 5 分钟重开。

安装版本与暂存目标使用数值分段比较，尾部零等价（如 26.1200.1 与 26.1200.1.0）。安装等待 5 分钟、体检 60 秒。Hub 记录自己发出 quit 的日志；安装超时/驱动异常/关回开关失败也尝试重开当前已安装版本，自己的 updater 尚在运行则延后；其他软件的 updater 不阻碍恢复。发现 Codex 本身仍在运行（quit 被取消或 Sparkle 已重开）则清除关闭归属，防止随后把用户自行退出误当作需要恢复。重启 Hub 可恢复 24 小时内的关闭记录。

官方依据：Sparkle [Customization](https://sparkle-project.org/documentation/customization/)、[SPUUpdater](https://sparkle-project.org/documentation/api-reference/Classes/SPUUpdater.html)、[Documentation](https://sparkle-project.org/documentation/)（2026-11-09 读取）。这是后台调度方案的依据，**不代表当前 Codex 已验证无弹窗、成功下载或退出即安装**。需要按 LIVE-VALIDATION.md 在获授权的独立真机环境验证偏好读取、下载目录、签名耗时、静默程度、安装/自动重开与 watchdog 权限。

## 旧 guard / 发布归属

旧用户本机 guard 位于本仓库工作树以外，不能在本任务直接改写。提供 codex-guard-handoff.patch：检测 hub-desktop.json codexUpdates.enabled=true 时仅在租约新鲜且 Hub pid 存活时让位；否则写 false 后退出，不由旧名单独立放行。需集成人员串行应用到实际脚本；本分支不修改正在运行的 guard，不激活更新管理，不上传资产。

根目录 codex-compat.json 是初始空模板，不额外认证任何版本。Claude 负责核对接口、界面、资产生成上传、版本号和发布。真机验收、独立复查、契约冻结、guard 实际部署、Windows 验收均不由本次离线测试替代。

## 交 Claude 的 v2 差异

RPC 字段、phase 枚举及错误码不新增/删除。waiting-idle 包含“后台检查前等待”，installing 包含“后台检查所需的正常重开”，downloading 不再代表点击菜单；CODEX_UPDATE_CHECK_FAILED 也覆盖 watchdog/后台准备失败，旧“辅助功能权限”专属文案需更新。低版本成功投放时 up-to-date 不表示 feed 最大版本可在当前系统安装。内部持久状态新增 originalCheckPreferences、armed/attempt/session 记录及独立 watchdog 文件；无新增外部接口、端口或远程执行能力。

第 11 条保持：restart 仍退出后 open 重新判定，设置触发的重启不会再走 Launcher 内部平滑 restart；Windows 路径原有强制退出行为可能中断未完成工作。本轮没有恢复旧路径，也没有进行真实 restart。
