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
