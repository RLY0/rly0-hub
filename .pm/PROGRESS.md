# Codex 官方新版弹窗：本地修复已完成（self_verified）

2026-11-11 开始，2026-11-12 完成隔离检查；分支 `feat/agent-cli-autoupdate`，输入 `5d07cdaf`。工单 `HUB-CODEX-UPDATE-ALERT`。

本机只读研究确认 Codex 26.1103.60933 内置 Sparkle 2.9.1，`SUSkippedVersion` 使用 feed build 字符串。后台已增加自己的跳过归属记录、放行前撤销、关闭管理恢复及崩溃恢复；保留用户其他跳过版本，不改 Codex 已关注提醒数组。更新退避和长期等待空闲时也刷新压窗阈值；无任务且键鼠 5 分钟未动的规则保留，仍经连续 15 秒复核。watchdog 不重放旧跳过记录。

验证：5 个文件 167 pass、0 fail、0 skip；typecheck、改动文件 ESLint、依赖边界和改动文件格式通过。全仓 lint exit 1，仅基线已有的 `rly0-hub-promo.test.ts:11`；文件哈希与基线相同。测试为 synthetic feed/系统命令注入，临时用户/配置/数据/记忆目录隔离，原生控制关闭。App 研究临时目录已删除，输入哈希未变。

证据：[RESULTS](selfheal/evidence/codex-update-alert-20261111/RESULTS.md)、[机制研究](selfheal/evidence/codex-update-alert-20261111/RESEARCH.md)。契约与 `docs/features/codex-version-gate.md` 已同步。仅自检，未 reviewed/accepted；未写真实 defaults、未改 App、未退出重启用户 Codex/Hub、未另起 hub-service、未推送发布。

next_action：独立复核；获准独立真机验收运行中 Sparkle 读取跳过值/定时无弹窗、适配后的空闲下载与退出安装、用户关闭管理和真实 watchdog 恢复。已显示窗口、显式手动检查、feed 观察间隔和 defaults 最后比较/写入竞争仍有边界。界面、打包与发布仍由 Claude 负责。

---

# HUB-AGENT-CLI-AUTOUPDATE 复查 #3 修复：self_verified

2026-11-10；feat/agent-cli-autoupdate；输入 `bc3fd9a1a2ee46484b6fed843adef14a2e9bf28f`（保留 Claude 界面）。N1/N2/N3 和四个次要项已实现并补测试。本轮仅自检，修复后的 reviewed/accepted 未完成。

验证：16 文件、244 pass、0 fail、0 skip；compiled dist + 假驱动四场景通过。N1 四次分钟 tick 安装数均为 2，之后每日/手动仍可重试；N2 16 助手乘 6 轮外部占用 96 次检查、0 次释放、0 次安装；N3 实际只读快照不阻塞，真实预热仍阻塞。build:typescript、typecheck、依赖边界、改动源文件 lint/格式通过。全仓 lint exit 1，仅输入已有的 rly0-hub-promo.test.ts:11（文件哈希与输入相同），本轮新增 0。

[契约 v4](selfheal/AGENT-CLI-AUTOUPDATE-CONTRACT.md) 增加内部 hostPid、连接报告 AGENT_CLI_UPDATE_BUSY，明确两步预检/释放后复查、同目标 15 分钟释放限频、回退后的分钟重试边界、失败关闭可重试和协调锁退避。v3 已更正三类严重故障优先于 recoveryPending。逐条源码/测试行号、命令、输出和限制见 [RESULTS](selfheal/evidence/agent-cli-autoupdate-review3-20261110/RESULTS.md)。

没有改 apps/hub-desktop/www；所有被测 npm/系统命令注入驱动，临时用户/数据/记忆目录隔离。未执行真实全局 install/uninstall，未退出重启用户 Codex/Hub，未另起 hub-service，未打包推送发布。本轮测试没有启动原生 CLI 或需要清理的外部测试服务/进程。

next_action：修复后独立复核；Claude 核对 v4 的等待状态接线；在获准独立环境验证 Mac/Windows 原生会话关闭失败/超时重试、子代理/预热、进程归属、真实升级回退/连接、文件占用/ACL 与 UI。原生固定版本回退缺口、外部最后扫描竞争和第三方脱离进程组等既有局限保留。界面、打包和发布归 Claude。

---

# HUB-AGENT-CLI-AUTOUPDATE 复查 #2 修复：self_verified

2026-11-10；feat/agent-cli-autoupdate；固定输入 `62f2bdcc1e1fbf1eba0b2ed68f14742e5ee2628a`。阻断 1、重要 1–4 的后台修复及对应回归完成；次要项已处理，owner 同步探针以 1 秒缓存缓解，未改全异步。仅自检，修复后的 reviewed/accepted 仍未完成。

最终验证：16 文件、233 pass、0 fail、0 skip；build:typescript、typecheck、依赖边界、改动源文件格式通过。全仓 lint exit 1，仅输入已存在的 rly0-hub-promo.test.ts:11，本轮新增 0。证据及逐条实现/测试行号见 [RESULTS](selfheal/evidence/agent-cli-autoupdate-review2-20261110/RESULTS.md)，源码指纹见同目录 source-sha256.json。

修复：安装超时 INSTALL_TIMEOUT 不进分钟重装；围栏内只释放该助手满足全部安全条件的空闲会话，活动回合/后台/审批/持久化保护保持，之后按需 resume；旧版也非 ready/异常/超时撤销目标拉黑；锁身份 UTC/C；POSIX 自有 detached 进程组覆盖重挂父进程后代，不误杀无关进程。次要队列、普通 inspect 围栏、Windows EPERM 与 taskkill 退出竞争、保留 ready 中断目标版、旧日志误拉黑和代理契约同步处理。

[契约 v3](selfheal/AGENT-CLI-AUTOUPDATE-CONTRACT.md) 新增 previousVersion/recoveryPending、INSTALL_TIMEOUT/INSTALL_FILE_BUSY/PRE_UPDATE_VERSION_MISMATCH，以及两个要求有效围栏的内部 Host 方法。没有修改 apps/hub-desktop/www，没有真实全局 npm install/uninstall、另起 hub-service、日常 Codex/Hub 退出重启、打包、推送或发布。POSIX 原生探针只操作自建的固定无害 shell/sleep 并清理。

next_action：修复后独立复核；Claude 接契约 v3 的恢复/超时文案和字段；获准隔离真机验收原生会话释放与按需恢复、活动回合保护、真实更新/回退/连接、Windows ACL/占用和进程树。同步探针首次/到期最多 3 秒、外部进程最后扫描竞争、脱离进程组的第三方守护程序与原生固定版本回退缺口保留；本轮不自批真机或发布。界面、打包及发布仍归 Claude。

---

# HUB-AGENT-CLI-AUTOUPDATE 复查 #1 修复：self_verified

2026-11-10；feat/agent-cli-autoupdate；固定输入 `976c0194`（保留 Claude 界面提交）。B1/B2、重要 1–5 和次要项均完成后台修补与针对性回归。仅自检，修复后独立复核与 accepted 未完成。

主会话最终验证：13 文件、174 pass、0 fail、0 skip；build:typescript、typecheck、边界检查通过。全仓 lint exit 1，仅原输入已有的 rly0-hub-promo.test.ts:11；本轮新增错误 0。源码格式与最终工作树证据见 [RESULTS](selfheal/evidence/agent-cli-autoupdate-review1-20261110/RESULTS.md)。

已处理：ready 基线与临时故障不误拉黑；安装失败先读版本；恢复保留外部换装；PID/启动身份原子锁和启动/Host 死锁清理；Host 启动设置；原 prefix 权限与 npm registry/代理一致性；Windows 树终止及外部空闲进程占用；手动检查排队、recipe pin、入口围栏、合并状态写入、相同状态不重写和停服取消。契约新增 v2 节及 2 个结果、4 个错误码，交 Claude 映射。

没有修改 apps/hub-desktop/www，没有真实全局 npm install/uninstall、另起 hub-service、用户程序退出/重启、推送或发布。next_action：修复后独立复核；Claude 按 [契约 v2](selfheal/AGENT-CLI-AUTOUPDATE-CONTRACT.md) 同步等待/恢复状态，在获准独立环境验收 Mac/Windows、真实账号与代理、升级/回退/占用/停服时长。原生脚本固定版本回退能力缺口及外部启动竞争仍保留；打包和发布归 Claude。

---

# HUB-AGENT-CLI-AUTOUPDATE backend: self_verified

2026-11-10; feat/agent-cli-autoupdate; input 9dfd747c. Implemented backend only; independent review and accepted are not complete.

Startup/daily checks, default-on switch, management RPC, original-prefix npm updates, per-agent work admission, native connection checks, persistent bad versions and rollback recovery are implemented. Version-pinned native OpenCode is supported. Native updaters without verified version-pinned rollback remain explicit detection-only capability gaps.

This main session ran 9 files: 92 pass, 0 fail, 0 skip. Typecheck, boundary and changed-file formatting pass. Repository lint retains exactly the same pre-existing rly0-hub-promo.test.ts:11 error as input 9dfd747c; new errors 0. No live installs, Hub service launch, Desktop restart, UI edits, package, push or release.

Contract: [v1](selfheal/AGENT-CLI-AUTOUPDATE-CONTRACT.md). Evidence: [results](selfheal/evidence/agent-cli-autoupdate-20261110/RESULTS.md).

next_action: Claude UI integration; independent review; authorized isolated real npm/Mac/Windows/proxy/rollback acceptance; Claude owns packaging and release. Preserve explicit native rollback gaps.

---

# 隔离候选进度：HUB-CODEX-VERSION-GATE 第二次复查修复

2026-11-09，feat/codex-version-gate，固定输入 c796e85c。已修 N1/N2 阻断、N3/N4、上轮 6 的 Launcher 读取位置及 7 的 originalCheckPreferences；N6–N11 一并修复。N5 保留默认规则，只收敛 CodexIdleDriver。

self_verified：8 个文件 148 pass、0 fail、0 skip；隔离原生开发 .app 构建、ad-hoc 验签及包内 Node/包内 watchdog 注入驱动冒烟通过。基线 archive c796e85c 的 7 个已有文件 116 pass；旧产物实测只有 hub-service.mjs，缺 watchdog。类型与边界检查通过，lint 与基线均为 rly0-hub-promo.test.ts:11 同一既有错误，新增 0；格式检查见本轮证据。

证据：.pm/selfheal/evidence/version-gate-review2-20261109/RESULTS.md、baseline.json、regression.json、native-package.json 及源码指纹。CONTRACT v3 无 RPC 字段/枚举变化，新增环境隔离语义、持久退避及空闲驱动接口说明，文案交 Claude。apps/hub-desktop/www 未改。

未操作真实 defaults、用户 Codex/Hub、guard 或真实升级；仅构建临时开发验收产物，不是正式 DMG/发布。仅自检，未 reviewed/accepted；用户空闲定义、修复后独立审查、独立真机 Sparkle/权限/Windows 与 guard 部署验收仍待完成。

next_action：Claude 核对 CONTRACT v3 及提示文案；用户定稿 N5 后仅替换空闲驱动；独立审查本轮后端改动，随后在获准独立环境验收真实更新，再由 Claude 决定正式打包发布。
