# HUB-CODEX-VERSION-GATE contract v1

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
| up-to-date | 当前已达适配最新版，或更新后体检通过 |
| waiting-compatibility | 最新版尚未适配，无期限等待 |
| downloading | 已调用 Codex 自己的检查更新命令，等待 Sparkle 暂存证据 |
| waiting-idle | 已有对应版本签名有效暂存，等连续 15 秒 fresh busy=false 心跳 |
| installing | 已正常 quit，等 Desktop/Autoupdate 全部退出且安装版本精确匹配目标 |
| health-check | 已关回自动安装并经 Hub 重开，等真实界面体检 |
| failed | 失败；error 指明原因，不声称更新成功 |

业务错误走返回字段，不抛原始系统输出：CODEX_PREFERENCES_FAILED、CODEX_APPCAST_FAILED、CODEX_VERSION_UNAVAILABLE、CODEX_UPDATE_CHECK_FAILED、CODEX_DOWNLOAD_TIMEOUT、CODEX_INSTALL_TIMEOUT、CODEX_UPDATE_TARGET_CHANGED、CODEX_REOPEN_FAILED、CODEX_HEALTH_FAILED、CODEX_STATE_FAILED。compatibility.error 独立为 COMPAT_UNAVAILABLE、COMPAT_INVALID、COMPAT_CACHE_WRITE_FAILED 或 null；离线不掩盖已有缓存。RPC 参数错误 -32602 INVALID_PARAMS；未挂载 manager/意外路由异常 -32000 CODEX_UPDATES_UNAVAILABLE。

## 注入与 Claude 交接

renderer.mode 为 full/core/safe；旧 maintenance.compatibility 的 state 新增 core-mode。连接成功、用户旧“完整模式”选择均不能认证未知 Desktop family。open/restart 都重新判定；restart 走退出后 open，不沿用 Launcher 内部旧模式。

Hub 写入版本绑定的 codex-renderer-policy.json；Controller 每 2 秒查看，变更时先释放旧 session/新文档注入脚本，再重新建对应模式，不退出 Desktop。启动版本与策略不匹配、损坏或无法读取时使用 core。core 只提供被动数据桥，不加载原增强 bundle、不发现 React、不改 native RPC/输入框；桥失败保留握手并退无注入，待重开再试。safe 使用既有 no-renderer。

Claude 实现额度/余额视图时可读取 `globalThis.__codexhostCoreUsageV1`，并监听 `codexhost:core-usage` 事件。形状：`{available:boolean, checkedAt:number|null, quota:{usedPercent:number,resetsAt?:number}|null, balance:{amount:number,unit:"USD"|"CNY"}|null}`。Hub alerts 周期写快照，Controller 发布；超过 10 分钟、未来时间、坏类型显示 unavailable，不造数。此工单仅提供数据桥，新增显示和提示条属于 Claude；未声称核心模式视觉已完成。

可观察 `globalThis.__codexhostFeatureFailuresV1`（失败 feature id 数组）。安装时每个可选功能独立捕获失败，禁用功能不调用 installer。使用原有界面样式，不新增视觉规范。

## macOS 更新驱动的真实边界

用本机 production-appcast-bootstrap.json 中 installationId、当前版本、实际 arch 请求官方 appcast。只改 SUAutomaticallyUpdate；原值在首次副作用前持久保存。通过 Codex 应用菜单的实际“Check for Updates/检查更新”触发检查，没有虚构 CLI 参数；需要 Accessibility 权限，菜单不可用报失败并关回自动安装。

下载就绪要求 Sparkle Installation 缓存中目标 .app 的 bundle id/短版本匹配且 codesign --verify --deep --strict 成功；不是固定计时。正常 quit 前重读 appcast，发现目标变化就取消，不退出 Codex。全流程不复制、不替换、不分发 Codex App 包。

运行超时只停止本次尝试，不释放未适配版本：下载 30 分钟、安装 5 分钟、体检 60 秒。Hub 中断后先关回自动安装；只有 30 分钟内安装日志与当前版本精确匹配，才等待 updater 退出并恢复重开。

系统菜单、本机 Sparkle 缓存路径、macOS 实际下载/安装/签名/重开链路均需另行真机验收。Sparkle 不提供已验证的目标锁定 API；退出前重读 appcast缩小竞态，但官方投放在此后改变仍可能绕过目标，C 必须保留。AppleScript 检查菜单可能弹官方更新对话框；未声称无交互安装已通过。

## 旧 guard / 发布归属

旧用户本机 guard 位于本仓库工作树以外，不能在本任务直接改写。提供 codex-guard-handoff.patch：检测 hub-desktop.json codexUpdates.enabled=true 时退出，不执行 defaults 写入。需集成人员串行应用到实际脚本；本分支不修改正在运行的 guard，不激活更新管理，不上传资产。

根目录 codex-compat.json 是初始空模板，不额外认证任何版本。Claude 负责核对接口、界面、资产生成上传、版本号和发布。真机验收、独立复查、契约冻结、guard 实际部署、Windows 验收均不由本次离线测试替代。
