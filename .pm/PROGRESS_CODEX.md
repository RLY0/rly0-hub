# Codex 进度：HUB-CODEX-VERSION-GATE

工作区：feat/codex-version-gate @79fc26e8 基线。仅此 worktree 写入。

实现：兼容清单/缓存/minHub、默认一次及原偏好恢复、Sparkle 适配器与串行空闲升级状态机、安装中断恢复、management RPC、核心模式被动数据桥、逐功能安装隔离和远程禁用、restart 重判。

最终自测：类型/边界/renderer 构建通过，聚焦 105 pass；全量 9419 pass、18 fail（全部为基线已有）、69 skipped，新增失败 0；lint 同基线 1 fail。WebKit synthetic DOM 1 pass。

验证与差异见 `.pm/selfheal/evidence/version-gate-20261109/RESULTS.md`。没有新登录、真实模型调用、真实 defaults 写入、真实客户端操作或发布。

独立复查派发失败：RLY/0 delegation wrapper 首次 CODEXHOST_NOT_FOUND；显式传入已安装 npm launcher 后 CODEXHOST_FAILED。没有取得 reviewer 结果；仅自检。

剩余：Claude 交互核对与显示/发布接入；真实 guard 串行部署；独立审查；macOS 菜单/权限/Sparkle 完整链路及 Windows 验收。
