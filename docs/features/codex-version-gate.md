# Codex 版本管理与兼容保底

Hub 默认管理 Codex 更新，用户可关闭。默认只设一次，恢复时保留原 Sparkle 偏好（包括键原先不存在）。兼容清单使用独立 codex-compat.json，离线保留有效缓存和内置表；未验证版本无期限等待，不按时间自动释放。

macOS 驱动在持续空闲后用正常重开触发 Sparkle 后台检查，不点更新菜单；独立 watchdog 为临时放行保底，仅在 macOS 构建中作为第二个入口随服务打包并做存在性审计（Windows 载荷不含该文件）；安装目录在 Codex 仍运行时用 `lsappinfo` 记录，后备为 Launcher 记录的 installRoot，不使用会启动应用的查询；服务收到 SIGTERM/SIGINT 时走正常释放，控制锁按进程启动时间识别 PID 复用；原生控制仅用于登录用户的默认目录，开发/隔离环境默认关闭，status 以可选 unsupportedReason（platform / control-disabled / environment）说明原因。以签名暂存为实际投放目标，只有连续空闲心跳、目标未改变、安装版本匹配及体检通过才完成更新。Windows 保留开关和安装版本检测，报告无法单应用控制商店更新。后台失败计数跨重启保留；相同 feed 连续下载超时三次后等 feed 变化，不再定期重开。quit 被取消 30 秒后清除重开归属；恢复记录只接受 5 分钟内且未出现较新心跳的记录。下载/安装/系统偏好或 watchdog 失败均显示具体错误，不强杀、不替换 App 包。

未知版本进入 core，被动提供额度/余额数据；core 注入失败进入 safe（不注入增强）。已验证版本可按功能远程禁用；Controller 接收策略变化时释放旧 session 和脚本再安装。旧连接成功记录和用户旧完整模式选择不能绕过版本清单。

技术接口、枚举、缓存边界及尚未通过的真实系统路径见 [.pm/selfheal/CODEX-VERSION-GATE-CONTRACT.md](../../.pm/selfheal/CODEX-VERSION-GATE-CONTRACT.md)。显示层、发布与线上验收由 Claude 集成；当前文档不表示已发布或真机验收。

空闲判定集中为可替换的 CodexIdleDriver，当前默认仍是连续 15 秒没有任务；N5 的最终规则待用户决定。Launcher 身份从实际 diagnostics 目录读取；辅助偏好损坏不丢失已保存的原自动更新值。第二次复查修复仅完成隔离自检，真实升级和修复后独立审查待验收。
