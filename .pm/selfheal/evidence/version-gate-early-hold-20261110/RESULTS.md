# 版本门禁提前注入（B1）与第五轮复查修复：自检结果（2026-11-10，Claude）

基线 2e5d245d，分支 feat/codex-version-gate。依据 CODEX-VERSION-GATE-REVIEW-5.md。仅 self_verified；没有独立复查，没有真机验收。没有推送、没有发布；没有连接任何真实 Codex 调试端口，没有写真实 defaults，没有启动/退出 Codex 或 Hub，没有另起 hub-service，没有改 /Applications。Launcher（Rust）未改。

## 实现

- B1：`packages/desktop-control/src/early-update-hold.ts`（新）；`production-controller.ts` 启动并转发 hold 变化；`cdp-client.ts` 增加 `onClose`。
- M1：controller 每轮幂等推送；hold 脚本增加 `override`，注入捆绑的为后备不覆盖；浏览器级会话在 hold 变化时移除旧新文档脚本按新值重登记。
- M2：`codex-update-hold.ts` 删除 localStorage 存档与补发。
- L1/L2/L3/L4/L8：`packages/host-runtime/src/rly0-hub-service/codex-reopen.ts`（新）+ manager `#recoverClosed`、`status().reopening`。
- L5：manager `setEnabled` 报 CODEX_STATE_FAILED，`check()` 重算 hold。
- L6：`codex-compat.ts` hold 初值未知、版本未知时只改 holdUpdates；controller 把只有 hold 的文件当作未发布策略。
- L7：`service.ts` `hub.restorePure` 增加 `steps.codexUpdates`（关闭管理，hold=false）。需用户确认产品决定。
- 契约 v4 更正 + v5 节；功能文档更新。

## 检查（全部在本工作区亲跑）

隔离环境：临时 HOME/USERPROFILE/CODEX_HOME/CODEXHOST_DATA_DIR/RLY0_MEMORY_DIR，RLY0_SKIP_LEGACY_IMPORT=1，RLY0_CODEX_UPDATE_CONTROL=0；CDP 用假 socket 喂真实线格式（`Target.attachedToTarget`、`waitingForDebugger`、`targetInfo.type/url`、flatten 的 sessionId），系统命令全部注入。

- `npm run build:typescript`、`npm run typecheck`、`npm run build:renderer`、`node tools/check-boundaries.mjs`：通过。
- `npx vitest run --config tests/vitest.config.js` 覆盖 desktop-control、renderer-extension、shared-contracts 全部测试；host-runtime 的 codex-version-gate、codex-update-watchdog、codex-input-idle、rly0-hub-service、rly0-codex-updates-ui；tests/release 的 desktop-controller-bundle、host-bundle、hub-macos、hub-watchdog、payload、production-renderer：183 个文件，2004 通过，1 跳过（既有）。
- 改动的 TS 文件 `eslint`、`prettier --check`：通过；两份 md `prettier --check` 通过。没有跑全仓 lint（基线 rly0-hub-promo.test.ts:11 既有错误不在改动文件中）。
- 变异核验（改坏后对应测试失败，已还原）：去掉 finally 放行；去掉移除旧脚本；去掉非 page 目标 detach；去掉已存在页面立即 evaluate；L3 去掉“Launcher 仍在运行不再启动”；L1 停服仍受重试暂停限制；L4 不放弃；L2 Launcher 状态未知按未运行。
- rly0-hub-service 的“启动兼容检查”测试原依赖后台时序（更新管理读版本时会多调一次兼容检查），已为它注入 installedVersion，使计数只反映启动检查和导出。

## 未做 / 需真机

- 端口是否早于首个窗口开放、首个页面暂停时的 URL、controller 崩溃/断线后 Chromium 是否自动放行（不白屏）、浏览器级 session 存在时 `/json/list` 仍给出页面 webSocketDebuggerUrl、新文档脚本先于 webview 异步块运行并纠正首条 gate 消息、SUAutomaticallyUpdate 保持 0 不下载不弹窗。
- 正式 Launcher 在 Gatekeeper 校验新包时的 ps 形态与耗时；30 分钟放弃后的界面提示。
- safe 模式与 `--no-renderer` 仍不拦截。
- codex-update-manager.ts 为 922 行（重开逻辑已移出，但新增放弃/状态字段与 L5 处理仍在状态机内），超过 800 行的复查信号。
- 界面（`reopening` 字段、restorePure 新步骤、放弃重试文案）未改 apps/hub-desktop/www，交 Claude 界面工作。
