# 第七次独立复查两项次要问题修复 — 证据（2026-11-10）

分支 `feat/codex-version-gate`，基线 HEAD `d841e49b`（开工时 `git status` 干净）。实现：Claude。

## 1. 停止流程：关自动附着超时后新窗口可能卡住

`packages/desktop-control/src/early-update-hold.ts`

- :109 `Connection.stopReleases`：停止期间附着的窗口的放行 Promise 集合。
- :345-355 `onAttached` 停止分支：放行→detach 的 Promise 登记进 `stopReleases`，完成后自行移除。
- :440-445 `settleStopReleases`：close 前等待集合清空，每轮有超时（`commandTimeoutMs*2+50`），最多 3 轮防止新窗口不断涌入。
- :447-473 `releaseUnconfirmed`：原有“重新附着并放行未确认目标”一轮，抽成函数。
- :476-494 `shutdown`：关自动附着 → 一轮补放 → 等待停止期间的放行；若关自动附着失败（`off === false`），再取一次未确认快照补一轮并再等待，然后才 `close()`。

## 2. window.open 弹窗跳到非 Codex 页面后长期保留会话

- `packages/desktop-control/src/codex-update-hold.ts:186-187, 203`：probe 结果新增 `blank`（文档仍是 `about:` 初始文档）。
- `early-update-hold.ts:261-286` `letGo`：从 pages 移除，排在该页 chain 之后（避免并发的 setHold 重新登记），移除已登记的新文档脚本，再 `Target.detachFromTarget`。
- `early-update-hold.ts:299-305` probe：读到 `codex === false` 且 `blank !== true`、非停止中、该目标从未被识别为 Codex 页面时调用 `letGo`。
  - 保守处理：probe 失败（导航中、上下文销毁）不算结论；仍是初始空白文档时保留（弹窗尚未导航）；曾被识别为 Codex 页面的窗口（主窗口）即使之后显示别的文档也保留会话，避免回到 app:// 时失去早期拦截。

## 测试（全部亲跑，隔离环境：临时 HOME/USERPROFILE/CODEX_HOME/CODEXHOST_DATA_DIR/RLY0_MEMORY_DIR，RLY0_SKIP_LEGACY_IMPORT=1，RLY0_CODEX_UPDATE_CONTROL=0，PATH 含 node-v24）

新增单元测试（`packages/desktop-control/test/early-update-hold.test.ts`）：

- :505 停止期间附着、放行回应较慢的窗口：detach 在放行之后且在 close 之前（第 1 条，等待）。
- :542 关自动附着失败、停止期间附着的窗口首次放行丢失：第二轮重新附着并放行，且在 close 之前（第 1 条，补一轮）。
- :576 弹窗：初始空白文档保留；载入非 Codex 文档后移除脚本并 detach；之后的载入事件与 setHold 不再触碰；曾为 Codex 的页面保留；probe 失败不释放（第 2 条）。
- `codex-update-hold.test.ts`：probe 的 `blank` 字段（app:/about:/https:）。
- 回归验证：把 `early-update-hold.ts` 临时换回 HEAD 版本，上述 3 个新用例全部失败；恢复后通过。

真实 Chromium（`early-update-hold.chromium.test.ts:376`，Google Chrome 157.0.8103.39，headless，临时 profile，`--use-mock-keychain --password-store=basic`，未连接用户 Codex 的调试端口）：

- 新用例：以 `pageProtocol: "app:"` 运行，使 http 弹窗代表登录/第三方页面；断言弹窗正常载入、早期会话先移除脚本再 detach、`Target.getTargets` 中该目标 `attached: false`、页面重载后正常且无任何针对该会话的命令。
- `RLY0_REAL_CHROMIUM=1` 亲跑 2 次：6/6 通过、6/6 通过。
- 对照：旧实现下新用例失败（未 detach）。
- 结束核对：`pgrep -fl rly0-early-hold-chrome`、`pgrep -fl headless=new` 无输出；`$TMPDIR/rly0-early-hold-chrome-*` 无残留。

其余检查：

| 命令 | 结果 |
| --- | --- |
| `npm run build:typescript` | 通过 |
| `npx vitest run --config tests/vitest.config.js packages/desktop-control` | 36 文件通过、1 跳过（Chromium 用例默认跳过）；409 通过、6 跳过 |
| `npx vitest run ... packages/host-runtime/test/codex-version-gate.test.ts packages/host-runtime/test/rly0-hub-service.test.ts` | 2 文件、143 通过 |
| `npm run typecheck` | 通过 |
| `node tools/check-boundaries.mjs` | 通过 |
| 改动文件 `eslint` / `prettier --check` | 通过 |

## 未确认

- 未在真实 Codex Desktop 上验证（按要求不连接用户正在运行的 Codex）；“关自动附着超时”只在模拟浏览器中复现，真实 Chromium 难以稳定制造该超时。
- Windows 未验证。
- 未推送、未发布。
