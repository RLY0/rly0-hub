# Codex 进度：HUB-CODEX-VERSION-GATE 复查修复

2026-11-09；固定基线 2d795e9c（含 Claude 两个界面提交），同一 feat/codex-version-gate worktree。

复查必修 1–5，以及 6/7/9/10 已修并补回归；11 保留行为并说明影响。移除菜单更新，改为持续空闲后的正常重开/后台调度；独立 watchdog 在开启 SUAutomaticallyUpdate 前就绪，崩溃后不依赖 Hub 再启动；候选放行与实际签名暂存目标分离，数值尾零等价；失败恢复、等待/退避、版本稳定策略、CDP 可选功能诊断与释放均有 synthetic 测试。

self_verified：14 文件 204 pass、1 既有 skip、0 fail；typecheck、边界、renderer build、WebKit 1 pass、改动格式通过。lint 同基线 1 处既有错误，新增 0。基线 typecheck 的界面测试 TS2349 已仅在测试中修复；apps/hub-desktop/www 未改。

证据：.pm/selfheal/evidence/version-gate-review-20261109/RESULTS.md、checks.json、baseline.json；CONTRACT v2。无真实 defaults、Codex/Hub 操作、guard 部署、安装/打包/推送/发布。修复后仅自检，未再次独立审查/accepted。

next_action：Claude 核对 v2 文案语义并接发布；另会话独立复查改动；授权独立真机验收 watchdog 路径/权限、后台调度静默程度、实际下载/安装/重开与 Windows。不能将本次 synthetic 结果当静默升级完成。
