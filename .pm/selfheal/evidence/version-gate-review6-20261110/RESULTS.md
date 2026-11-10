# 版本门禁第六轮复查修复：自检结果（2026-11-10，Claude）

基线 6d45a727，分支 feat/codex-version-gate。依据 CODEX-VERSION-GATE-REVIEW-6.md。仅 self_verified；没有独立复查，没有 Codex 真机验收。没有推送、没有发布；没有连接任何真实 Codex 调试端口，没有写真实 defaults，没有启动/退出 Codex 或 Hub，没有另起 hub-service，没有改 /Applications，没有改 apps/hub-desktop/www。Launcher（Rust）未改。

## 实现

- #1/#2/#3：`packages/desktop-control/src/early-update-hold.ts`（无条件放行、停止流程、命令超时、中止检查、`after` 串行、放行后探测与补装、诊断）；`cdp-client.ts` `getCdpBrowserVersion` 增加 `{signal, timeoutMs}`；`production-controller.ts` 串行启动并写诊断；`controller-status.ts` 诊断文件 `codex-update-hold-v1.json`。
- #3/#4：`codex-update-hold.ts` 协议判定、`lateInstall/source/installedAt/firstGateAt`、`codexUpdateHoldProbeExpression`。
- #5/#6：`packages/host-runtime/src/rly0-hub-service/codex-update-manager.ts`（`reopenGivenUp`、stop 打断轮询）。
- 契约 v6；`docs/features/codex-version-gate.md` 更新。

## 真实 Chromium 实验（临时无头 Google Chrome 157.0.8103.39）

每次：临时 `--user-data-dir`（`$TMPDIR/rly0-*`）、`--remote-debugging-port=0`（读 DevToolsActivePort）、`--headless=new`；结束后 SIGTERM（5 秒后 SIGKILL）并删除临时目录，每轮后用 `pgrep -fl rly0-early-hold` 与 `ls $TMPDIR` 核对无残留。

一次性探索脚本（仓库外，已删除）结论：

| 打开方式 | 浏览器级 auto-attach | tab 级 auto-attach |
| --- | --- | --- |
| `window.open`（带用户手势） | 附着 URL ''、waiting:true；hold 先于页面脚本 | page 报 waiting:false，脚本先跑（无效） |
| `window.open(..., "noopener")` | URL ''、waiting:true（未进一步测） | page 报 waiting:false，hold 晚于页面 |
| `Target.createTarget{url}`（同连接/另一连接） | 附着 URL 已是目标、waiting:true，但页面脚本已跑过，新文档脚本对当前文档不运行 | page 报 waiting:false，同样晚 |
| `PUT /json/new?url` | 同 createTarget | 同 createTarget |

- 断线：暂停的弹窗在关闭 websocket 后保持 URL ''（不自动放行）；重连 setAutoAttach 报 waiting:false；发放行立即加载。
- `setAutoAttach{autoAttach:false}`：浏览器级必须带 `flatten:true`；它 detach 所有自动附着会话，暂停的弹窗保持空白，原 session 的放行报 “Session with given id not found”；显式 `attachToTarget` 后放行即可恢复。因此停止流程为：关自动附着 → 重新附着并放行未确认目标 → 关闭。
- 结论（#3）：tab 级附着不能让 createTarget/`/json/new` 带 URL 的页面先于脚本，保持浏览器级附着；放行后探测补装并记录 `lateInstall`。

仓库内集成测试 `packages/desktop-control/test/early-update-hold.chromium.test.ts`（默认跳过；`RLY0_REAL_CHROMIUM=1` 开启，`RLY0_CHROME_PATH` 可改路径），本工作区亲跑多次（首次因用例间泄漏会话失败，加清理后连续 3 次 5/5 通过）：

1. window.open：弹窗暂停 → hold 先于页面脚本（`holdBeforePage:true`，gate 被纠正，`lateInstall:false`）→ 正常加载；诊断 `holdBeforePageScripts:true, mainWindow.attachedUrl:"empty", waitingAtAttach:true`。
2. createTarget 带 URL：`holdBeforePage:false`，探测补装 `lateInstall:true`；诊断 `holdBeforePageScripts:false, waitingAtAttach:true`（与预期一致：不先于）。
3. 另一连接暂停弹窗后断开（模拟 controller 崩溃）→ 弹窗确认卡在 '' → 启动 hold 后救回。
4. hold 自己的连接在放行前断开 → 重连后救回。
5. 主动停止：放行丢失的弹窗由停止流程救回；停止后再开窗口不被暂停，无 URL '' 的页面。

变异核验（改坏后失败、已还原）：放行改回仅 waiting → 真实测试 3、4 与 2 个单测失败；停止不重新附着 → 真实测试 5 与 1 个单测失败；connect 后不查中止 → 1 个单测失败；manager 轮询不与停止竞速 → stop 打断测试超时失败；放弃时不置标志 → L4 失败。

## 检查（全部在本工作区亲跑）

隔离环境：临时 HOME/USERPROFILE/CODEX_HOME/CODEXHOST_DATA_DIR/RLY0_MEMORY_DIR，RLY0_SKIP_LEGACY_IMPORT=1，RLY0_CODEX_UPDATE_CONTROL=0；系统命令注入。

- `npm run build:typescript`、`npm run typecheck`、`npm run build:renderer`、`node tools/check-boundaries.mjs`（exit 0）：通过。
- `npx vitest run --config tests/vitest.config.js` 覆盖 desktop-control、renderer-extension、shared-contracts 全部；host-runtime 的 codex-version-gate、codex-update-watchdog、codex-input-idle、rly0-hub-service、rly0-codex-updates-ui；tests/release 的 desktop-controller-bundle、host-bundle、hub-macos、hub-watchdog、payload、production-renderer：184 个文件（1 个跳过即真实 Chrome 文件），2019 通过，6 跳过（5 个真实 Chrome + 1 个既有）。lint 修正后 desktop-control 复跑 406 通过。
- 改动的 TS 文件 `eslint`、`prettier --check`：通过；md `prettier --check` 通过。没有跑全仓 lint。

## 未做 / 需真机

- Codex 主窗口（`BrowserWindow.loadURL`）是否像 window.open 那样在脚本前暂停：读 `~/.codexhost/diagnostics/codex-update-hold-v1.json` 的 `holdBeforePageScripts` 与 `mainWindow`。若为 false，B1 对主窗口首条 gate 无效，需 Launcher 先起 controller 或开放主进程（另立工单）。
- controller 被强杀时暂停中的窗口无法放行，需 Launcher 重起 controller 后由重连路径恢复（未验证 Launcher 是否重起）。
- 界面：`reopenGivenUp` 字段文案交 Claude 界面工作。
- codex-update-manager.ts 现为 953 行，超过 800 行复查信号（未拆分）。
