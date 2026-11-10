# Codex 版本管理与兼容保底

Hub 默认管理 Codex 更新，用户可关闭。默认只设一次，恢复时保留原 Sparkle 偏好（包括键原先不存在）。兼容清单使用独立 codex-compat.json，离线保留有效缓存和内置表；未验证版本无期限等待，不按时间自动释放。

macOS 驱动在持续空闲后用正常重开触发 Sparkle 后台检查，不点更新菜单；独立 watchdog 为临时放行保底，仅在 macOS 构建中作为第二个入口随服务打包并做存在性审计（Windows 载荷不含该文件）；安装目录在 Codex 仍运行时用 `lsappinfo` 记录，后备为 Launcher 记录的 installRoot，不使用会启动应用的查询；服务收到 SIGTERM/SIGINT 时走正常释放，控制锁按进程启动时间识别 PID 复用；原生控制仅用于登录用户的默认目录，开发/隔离环境默认关闭，status 以可选 unsupportedReason（platform / control-disabled / environment）说明原因。以签名暂存为实际投放目标，只有连续空闲心跳、目标未改变、安装版本匹配及体检通过才完成更新。Windows 保留开关和安装版本检测，报告无法单应用控制商店更新。后台失败计数跨重启保留；相同 feed 连续下载超时三次后等 feed 变化，不再定期重开。quit 被取消 30 秒后清除重开归属；恢复记录只接受 5 分钟内且未出现较新心跳的记录。下载/安装/系统偏好或 watchdog 失败均显示具体错误，不强杀、不替换 App 包。

未知版本进入 core，被动提供额度/余额数据；core 注入失败进入 safe（不注入增强）。已验证版本可按功能远程禁用；Controller 接收策略变化时释放旧 session 和脚本再安装。旧连接成功记录和用户旧完整模式选择不能绕过版本清单。

Codex 自己的主进程会按服务器开关（渲染进程发送的 `electron-sparkle-gates-changed`）打开 Sparkle 后台下载，只写系统偏好压不住。因此 Hub 在 `codex-renderer-policy.json` 顶层下发 `holdUpdates`（管理开启、且不在放行租约中时为 true）。full 和 core 模式都会注入一段独立的小脚本：它监听 Codex 自己派发的 `codex-message-from-view` 事件，hold 时立即经同一桥发送 `disableSparkleAutodownload:true`、`disableInAppUpdates:null` 的纠正副本，不触碰每次启动的 latch；识别不了的形态什么也不发，只记入 `__codexhostFeatureFailuresV1`。为了赶在 Codex 第一条 gate 消息之前，Controller 一启动就连接浏览器级调试端口，用 `Target.setAutoAttach`（`waitForDebuggerOnStart`）暂停每个新目标：Codex 页面先登记 hold 新文档脚本再放行，其他目标立即放行；准备超过 2 秒或失败也一定放行。被暂停的目标在断线、detach 或关闭自动附着后都不会被 Chromium 自动放行，所以每个附着到的目标一律发放行（重连时 Chromium 把上一连接遗留的暂停目标报成未暂停）；主动停止（退出、切 safe）先关自动附着，再重新附着并放行所有未确认放行的目标，最后断开；每条命令都有超时；新一轮自动附着要等上一轮停完才开始。hold 脚本只在 `app:` 文档中安装。只有渲染端自己打开的新窗口（`window.open`）在页面脚本之前暂停；`Target.createTarget`/`/json/new` 带 URL 创建的页面在附着时已经跑过脚本（Chrome 157 实测，tab 级附着同样无效），此时探测会立即补装并记 `lateInstall`。Controller 把主窗口是否先于页面脚本装上写入 `diagnostics/codex-update-hold-v1.json`（`holdBeforePageScripts`，不含 URL）。连接常驻、断线重连；hold 变化时移除旧脚本、按新值重新登记再推送（`early-update-hold.ts`）。页面注入中捆绑的 hold 脚本只作后备，不覆盖已有值；监控循环每轮幂等推送当前值，页面重载后也会纠正。不跨启动存档或补发旧开关。safe 模式不注入，无法拦截；浏览器级附着不可用时可能错过首条消息。放行重开 Codex 前，Hub 会等待旧 Launcher 退出，每次启动后确认 30 秒，确认不到且该 Launcher 仍在运行时不再发第二次启动；失败后每 60 秒再试，满 30 分钟放弃并保留错误（status 带 `reopenGivenUp: true`）；重开期间 status 带 `reopening: true`。停服会打断正在轮询的重开；停服时不受重试暂停限制，但未确认运行就保留会话记录交下次启动恢复。“恢复纯净状态”会一并关闭更新管理。检查日期的恢复兼容 macOS 27 的 `defaults` 缺键报错文本。

技术接口、枚举、缓存边界及尚未通过的真实系统路径见 [.pm/selfheal/CODEX-VERSION-GATE-CONTRACT.md](../../.pm/selfheal/CODEX-VERSION-GATE-CONTRACT.md)。显示层、发布与线上验收由 Claude 集成；当前文档不表示已发布或真机验收。

空闲判定集中为可替换的 CodexIdleDriver：心跳无任务且系统键鼠空闲 ≥5 分钟，再叠加连续 15 秒复核。Launcher 身份从实际 diagnostics 目录读取；辅助偏好损坏不丢失已保存的原自动更新值。第二次复查修复仅完成隔离自检，真实升级和修复后独立审查待验收。
