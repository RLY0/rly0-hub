# Codex 版本管理与兼容保底

Hub 默认管理 Codex 更新，用户可关闭。默认只设一次，恢复时保留原 Sparkle 偏好（包括键原先不存在）。兼容清单使用独立 codex-compat.json，离线保留有效缓存和内置表；未验证版本无期限等待，不按时间自动释放。

macOS 驱动在持续空闲后用正常重开触发 Sparkle 后台检查，不点更新菜单；独立 watchdog 为临时放行保底。以签名暂存为实际投放目标，只有连续空闲心跳、目标未改变、安装版本匹配及体检通过才完成更新。Windows 保留开关和安装版本检测，报告无法单应用控制商店更新。下载/安装/系统偏好或 watchdog 失败均显示具体错误，不强杀、不替换 App 包。

未知版本进入 core，被动提供额度/余额数据；core 注入失败进入 safe（不注入增强）。已验证版本可按功能远程禁用；Controller 接收策略变化时释放旧 session 和脚本再安装。旧连接成功记录和用户旧完整模式选择不能绕过版本清单。

技术接口、枚举、缓存边界及尚未通过的真实系统路径见 [.pm/selfheal/CODEX-VERSION-GATE-CONTRACT.md](../../.pm/selfheal/CODEX-VERSION-GATE-CONTRACT.md)。显示层、发布与线上验收由 Claude 集成；当前文档不表示已发布或真机验收。
