# HUB-CODEX-VERSION-GATE：Hub 管住 Codex 版本 + 未适配保底（2026-11-09 用户确认）

## 用户决定（不可推翻）
1. Hub **默认**替所有用户关掉 Codex 自动更新；用户可在 Hub 设置里关掉这项管理。
2. **无时间上限**：一直压到我们适配好的最新版才放行。
3. 一旦放行就**马上更新**（不等夜间任务）：Codex 空闲时用 Codex 自己的更新器装，装完 Hub 重开 Codex。
4. 同一版本里一起做保底：Codex 版本未验证 → 增强降级、核心照常；线上可按功能远程停用。一次发版（“一步到位”）。

## 现状（Explore 调查 2026-11-09，源码 .runtime/delegation-20261108 @79fc26e8 v0.11.39+2）
- 已有安全模式：`decideLaunchMode()`（host-runtime/src/rly0-maintenance/desktop-compatibility.ts:208）未验证版本 → `CODEXHOST_SAFE_MODE=1` → launcher `--no-renderer` 整体不注入；兼容表写死 shared-contracts/src/desktop-compatibility.ts:53。restart 路径不重新判断（codex-control.ts:170）。读不到版本按完整模式。
- latest.json 解析严格（hub-release.ts:61 未知字段即失败），不能直接加字段。
- Hub 源码无任何 Sparkle 控制；现有控制只在 tools/selfheal/codex_guard.py（用户本机，每小时）。
- renderer 各功能安装无逐项 try/catch（renderer-binding-probe.ts:788 起）；无按功能开关。
- Mac Hub 无一键自更新（hub-updater.ts:96 仅 win32）。

## 方案
### A. 线上兼容清单（新文件，不动 latest.json）
- 资产 `codex-compat.json`，随 Release 上传；读 `releases/latest/download/codex-compat.json`；可 `gh release upload --clobber` 单独改，不必发新版。
- 建议格式（Codex 定稿后冻结为契约）：
  `{schemaVersion:1, updatedAt, verified:[{family:"26.1103", minHub:"0.11.40"}], disabled:[{feature:"<id>", codexFamilies?:[], hubBelow?:"x.y.z", reason}]}`
- 解析宽松于未知字段（向前兼容），但字段类型严格；拿不到时用内置表 + 上次缓存。
- 判定“已适配”= 内置表 ∪ (远程 verified 且 minHub ≤ 当前 Hub)。

### B. Codex 更新管理（Mac 完整；Windows 尽力）
- Hub 首次启动默认开启（hub-state 记录 defaulted，只默认一次；用户关掉后不再改回）。开启时 `defaults write com.openai.codex SUAutomaticallyUpdate -bool false`，记录原值；用户关掉管理时恢复原值。
- 每次 alerts 周期（5 分钟）+ 启动时：查 appcast 最新版（同 tools/selfheal/codex_update.py 的方式，不伪造参数）。最新版已适配且高于当前 → 立即放行：打开自动安装 → 等 Sparkle 下载完成 → 心跳连续空闲 → AppleScript 正常 quit → 等 Autoupdate 结束 → 关回自动安装 → 经 Hub 重开 → 体检。失败保留现状并上报。绝不碰 /Applications 下的 App 包。
- 最新版未适配 → 保持压住，状态显示“等待适配”。
- Windows：商店无法单应用关更新 → 只检测与提示，靠 C 兜底。
- 用户本机：Hub 管理开启后 codex_guard.py 让位（检测到 Hub 管理开启就不写开关），避免双方互相覆盖。

### C. 未适配保底
- 判定改为用 A 的已适配集合；restart 路径也重新判断；读不到版本 → 按未验证处理。
- 未适配 → “核心模式”：只注入低风险模块（额度/余额显示），每个功能逐项 try/catch，失败只停自己；核心模式自身注入失败或体检坏 → 退到现有 no-renderer。
- 远程 disabled 列表在注入前由 controller 拼进 renderer bootstrap，对应功能跳过安装。

### D. 界面（Claude）
- 设置 → 更新 页新增“Codex 更新”区块：开关“由 Hub 管理 Codex 更新（推荐）”+ 当前版本 / 最新版本 / 状态（已是适配最新版 / 有新版等待适配 / 已放行，等 Codex 空闲后更新 / 正在更新 / 更新失败）。
- 核心模式提示条 + 托盘通知：“Codex 刚更新到未适配版本，部分增强已暂停，适配好后自动恢复”。
- 首次默认开启时一次性说明。覆盖加载、错误、离线、无权限（defaults 写失败）、Windows 不可控状态。

## 分工
- Codex：A、B、C 的非视觉逻辑、management-route 状态接口、测试；按 codexhost-pre-push-checks 选检查。
- Claude：D、接口交互核对、发布（含 codex-compat.json 生成与上传接入 release.py/build.ps1）、发布后核对。
- 接口契约（状态接口返回字段、错误码）由 Codex 定义，Claude 核对后冻结。
- 工作区：基于 .runtime/delegation-20261108 新开 worktree 分支 feat/codex-version-gate；Codex 先写，Claude 界面在其契约冻结后串行写入。

## 验收
- 单测：清单解析（未知字段/坏类型/离线缓存）、已适配判定、默认只一次、用户关闭恢复原值、空闲门、restart 重新判断、逐项隔离、远程停用。
- 隔离环境冒烟（临时 HOME 等，见 CLAUDE.md），不碰用户真实 Codex defaults；用户本机真机验证另行安排。
- 门禁按 REPAIR-RUNBOOK：全量无新增失败、独立复查可放行。
