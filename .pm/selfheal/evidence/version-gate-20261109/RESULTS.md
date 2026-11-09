# HUB-CODEX-VERSION-GATE 非视觉候选

工作区：`/Volumes/RLY0Dev/Dev/Projects/codex插件助手/.runtime/codex-version-gate-20261109`。分支：`feat/codex-version-gate`，固定基线 `79fc26e8b2b57b5cb22b6b0fd9b42142f5dde945`。

实现 A/B/C 非视觉逻辑、RPC 契约、测试。没有改其他工作树的源码；原 `.runtime/delegation-20261108` 仍为干净的 79fc26e8。没有推送、发布、安装、真实 defaults 写入、真实 Codex/Hub 重启或真实模型测试。

## 实现文件

- `codex-compat.json`：空初始资产模板；不认证额外版本、不触碰 latest.json。
- `packages/shared-contracts/src/codex-version-gate.ts`、`desktop-compatibility.ts`、`index.ts`：清单 schema、功能 id、版本/策略判定、core-mode 状态。
- `packages/host-runtime/src/rly0-hub-service/codex-compat.ts`：有界获取、严格已知字段/容忍未来字段、有效缓存、minHub、原子策略发布。
- 同目录 `codex-update-manager.ts`、`codex-sparkle.ts`：串行更新状态机、默认一次、原偏好恢复、权限拒绝后可退出管理、持续空闲门、目标二次核对、真实菜单/暂存/签名/进程观察驱动、安装中断恢复。
- 同目录 `hub-state.ts`、`management-routes.ts`、`service.ts`、`codex-control.ts`、`update-check.ts`：持久状态串行写入、状态/设置/说明确认接口、启动/alerts 接入、restart 经 open 重判、当前 Hub 版本读取。
- `packages/host-runtime/src/rly0-maintenance/desktop-compatibility.ts`：移除“连接过/用户旧完整模式选择即认证未知版本”的绕过，未知/不可读版本核心模式。
- `packages/desktop-control/src/codex-renderer-policy.ts`、`core-renderer-session.ts`、`core-usage-snapshot.ts`、`production-controller.ts`、`controller-status.ts`、`renderer-cdp-control-session.ts`、`renderer-draft-prewarm-policy.ts`：版本绑定与热策略切换、被动核心数据桥、过期/损坏拒绝、核心失败无注入、旧注入脚本/所有者清理、native 安装逐项隔离。
- `packages/renderer-extension/src/renderer-feature-gate.ts`、`production-entry.ts`、`install-renderer-binding.ts`、`renderer-binding-probe.ts`：可选模块独立安装边界、功能禁用、usage 隐藏、组合依赖降级；不新增布局/样式。
- 测试：`packages/host-runtime/test/codex-version-gate.test.ts`、现有 `rly0-hub-service.test.ts` 与 `rly0-maintenance/desktop-compatibility.test.ts`；`packages/desktop-control/test/codex-renderer-policy.test.ts`、现有 `production-controller.test.ts` / `renderer-cdp-control-session.test.ts`；`packages/renderer-extension/test/renderer-feature-gate.test.ts`；`tests/e2e/renderer-version-gate.spec.ts`。
- 交接：`.pm/selfheal/CODEX-VERSION-GATE-CONTRACT.md`、`codex-guard-handoff.patch`，功能文档 `docs/features/codex-version-gate.md` 与索引；隔离 PM 状态、看板和老板说明。

## 可重复验证

Node v24.22.2，npm 11.19.1。命令均从上述 cwd 运行；每组先 `mktemp -d` 创建独立根目录，再设置 HOME、USERPROFILE、CODEX_HOME、CODEXHOST_DATA_DIR、RLY0_MEMORY_DIR、`RLY0_SKIP_LEGACY_IMPORT=1`，网络无关测试加 `RLY0_VERSION_GATE_OFFLINE=1`。native exec 在 Vitest 中拒绝直接运行，测试通过注入 synthetic 驱动验证系统命令。

```sh
iso_gate=$(mktemp -d /tmp/rly0-gate-check.XXXXXX)
(
export HOME="$iso_gate" USERPROFILE="$iso_gate"
export CODEX_HOME="$iso_gate/codex" CODEXHOST_DATA_DIR="$iso_gate/hub"
export RLY0_MEMORY_DIR="$iso_gate/memory" RLY0_SKIP_LEGACY_IMPORT=1 RLY0_VERSION_GATE_OFFLINE=1
npm run typecheck
npm run test:typescript
npm run lint
node tools/check-boundaries.mjs
npm run build:renderer
PLAYWRIGHT_BROWSERS_PATH=/Volumes/RLY0Dev/Dev/Cache/ms-playwright npm run test:e2e -- renderer-version-gate.spec.ts --browser=webkit
)
```

实际执行通过绝对依赖路径复用已有 node_modules（只读依赖代码），工作区内 workspace 链接指向本候选自己的 packages；不安装依赖或浏览器。

## 测试状态

最终候选：**self_verified；未 reviewed / accepted**。

| 检查 | 退出码 / 结果 | 与基线比较 |
| --- | --- | --- |
| npm run typecheck | 0 / pass | 无新增类型错误 |
| npm run test:typescript | 1 / 9419 pass、18 fail、69 skipped | 18 fail 全部属于基线 19 fail 集合，新增 0；没有声明全量全绿 |
| 七文件聚焦 vitest | 0 / 105 pass | 新需求与受影响生命周期回归通过 |
| npm run lint | 1 / 既有 rly0-hub-promo.test.ts:11 非空断言 | 与基线同一个错误，新增 0 |
| node tools/check-boundaries.mjs | 0 / pass | 跨包边界通过（lint 在 ESLint 处退出，故单独执行） |
| npm run build:renderer | 0 / pass | 未打包应用 |
| WebKit renderer-version-gate.spec.ts | 0 / 1 pass | 临时 HOME + 既有浏览器缓存，无真实 Codex |
| 改动文件 prettier / git diff --check | 0 / pass | 仅改动文件格式，无删断言/skip |

聚焦命令为 `npx vitest run --config tests/vitest.config.js` 后接上述 host-runtime 三个测试文件、desktop-control 三个测试文件与 renderer-extension/renderer-feature-gate.test.ts。

最终机器可读状态写在 [comparison.json](comparison.json)。固定基线是 `git archive 79fc26e8` 的独立副本，不依赖开发中源码。初次“基线”全量与编辑重叠，结果已弃用；正式基线为独立副本的 19 失败 / 9387 通过 / 69 跳过。全量失败必须与该固定集合比较，不能只比较数量。

- WebKit synthetic DOM 测试：1 pass，退出 0；验证实际 binding 可释放、远程禁用不执行 installer、单功能异常不阻止其他功能。
- guard 交接补丁：在临时副本应用，fake appcast/subprocess 一旦被调用即断言失败；开启管理时返回 managed_by_hub，退出 0，无 appcast/defaults 调用。实际源 guard SHA-256 `6bb39aa83d2aece7a10631f9a9dbf92a8ae26e8127c2d0af123689b01d5681ec`，没有改动源脚本。
- 曾尝试合跑旧 renderer-binding-startup.spec.ts：该旧文件缺少 JPG loader，在浏览器启动前构建失败；未改旧断言或把它标 pass。新用例单独用已有 WebKit 通过；临时 HOME 的默认 Chromium 缓存不存在，不安装浏览器。
- 中途发现的 CDP 断开后额外求值回归已修复，保留原“立即停止等待”断言；没有删除测试/断言。
- 分页/MappingStore 清理 ENOTEMPTY 在基线多次运行结果不同；对照记录保留。若最终集合出现新项，必须标明，不可用“环境问题”代替对照证据。
- Rust/clippy/native Gate：not_run。无 Rust/打包修改，本轮按 codexhost-pre-push-checks 选择 TS/Renderer/边界及浏览器检查；未宣称 REPAIR-RUNBOOK 全量发布门禁通过。

## 未完成与风险

1. 契约尚待 Claude 核对/冻结；设置页、提示条及核心模式数据桥的显示层由 Claude 接入。没有自行实现新视觉。
2. 独立复查未取得结果：RLY/0 wrapper 两次分别报 CODEXHOST_NOT_FOUND、CODEXHOST_FAILED；没有启动成功 reviewer 的证据，只能标自检。
3. guard 在工作树以外，只交付已测补丁，集成人员需串行应用到真实脚本，否则双方仍可能覆盖偏好。没有部署补丁。
4. macOS 实际菜单权限/本地化、Sparkle 暂存目录、真实下载/签名/自动安装/重开完整链路 not_run。官方菜单可能弹确认对话框，不能声称无交互升级成功。
5. Sparkle 未提供经验证的目标锁定接口；quit 前重查缩小竞态，不能保证官方投放之后不改变。保留核心模式兜底；不把计时当下载完成。
6. Windows 为检测安装版本/兼容提示与保底，不控制商店全局更新，未知商店最新版返回 null；Windows 真机 not_run。
7. 兼容资产上传、Hub 配套版本、打包、发布和线上验收均由 Claude 负责且未执行。本候选不构成上线放行。
