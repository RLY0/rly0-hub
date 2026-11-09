# 版本门禁真机实测修复：自检结果（2026-11-09，Claude）

基线 2903656c，分支 feat/codex-version-gate。仅 self_verified；没有独立复查，没有真机验收。没有推送，没有发布。

## 研究（只读）

- 用 `npx @electron/asar@3.2.17 extract` 把 /Applications/ChatGPT.app 的 app.asar（26.1103.41825，sha256 前缀 766faa8a3da8f6d6）解到 /tmp，研究完已删除。没有改动 App 包。
- 代码位置（压缩单行文件，按字符偏移）：
  - `.vite/build/preload.js`（2cf4d9606e6d37e6）约 5364：`contextBridge.exposeInMainWorld("electronBridge", {sendMessageFromView: e => ipcRenderer.invoke("codex_desktop:message-from-view", e)})`。
  - `webview/assets/348410.46c6a64506.js`（c4c8706247016a35）约 9460 `SITX`：`postMessage` 每次调用都读取 `window.electronBridge`，发送后派发 `CustomEvent("codex-message-from-view", {detail})`；约 5980 `TL6G`：`dispatchMessage(e,a){F.postMessage({...a,type:e})}`。
  - `webview/assets/async/366057.8dff3ed0b6.js`（d5e8a2fcbc633f70）约 370395：`useEffect` 发送 `electron-sparkle-gates-changed`，依赖项是各服务器开关值。
  - `.vite/build/early-bootstrap-854-5239e17d5abd99b3.js`（87dae7cce26fcfe2）约 4882630 是 `ipcMain.handle(ol.fS)`，约 4883188 是 gates 分支；约 4777438 处 `registerCheck(() => hasInAppUpdatesPolicyChanges())` 在策略变化时弹出重启对话框。
  - `.vite/build/early-bootstrap-339-8cdc01c6be3ea2a7.js`（187cb5bbfa90ce93）约 1011074 是 latch，约 1016490 是 `setAutomaticBackgroundDownloadsEnabled`，约 1021032–1022071 是 `initializeMacSparkle`；`fS:"codex_desktop:message-from-view"` 也在该文件。
  - `early-bootstrap.js` 里没有 `ContextBridgeMutability`，桥对象保持 Electron 默认的冻结状态。
- 结论与 latch 语义写在契约 v4 一节。

## 根因核验（亲跑，只写临时 plist，没有写用户 defaults）

- `defaults write <tmp>.plist K -date "2026-11-08 16:55:14 +0000"` 在 zh_CN/en_US/C/空 locale 和 `env -i` 下都成功。日期格式不是原因。
- `defaults read <tmp>.plist Missing` 输出 `Error: Could not find key 'Missing' in domain '…'.`；缺失的域输出 `Error: Domain '…' not found.`；delete 缺键同样如此。对 `com.openai.codex` 一个不存在的键做了一次只读查询，输出相同。系统为 macOS 27.2 26B123。
- 用户真实数据目录（只读）：`codex-update-attempt.json` 停在 22:31（waiting-idle、timeouts 0），`hub-desktop.json` 仍有 originalCheckPreferences。与“`#disarm` 在恢复时抛错、没有保存尝试记录”一致。

## 检查（全部在本工作区亲跑）

隔离环境：临时 HOME/USERPROFILE/CODEX_HOME/CODEXHOST_DATA_DIR/RLY0_MEMORY_DIR，RLY0_SKIP_LEGACY_IMPORT=1，RLY0_CODEX_UPDATE_CONTROL=0，系统命令全部注入。

- `npm run typecheck`：通过。
- `npx vitest run --config tests/vitest.config.js` 覆盖 desktop-control、renderer-extension、shared-contracts 的全部测试，host-runtime 的 codex-version-gate、codex-update-watchdog、codex-input-idle、rly0-codex-updates-ui、rly0-codex-apply、rly0-macos-codex、rly0-macos-codex-restart、codex-runtime-lifecycle，以及 tests/release 的 desktop-controller-bundle、hub-watchdog、payload、production-renderer、host-bundle、hub-macos：185 个文件，1985 通过，1 跳过（既有）。
- 变异核验：把缺键判定改回只认 `does not exist`，3 个新测试失败；还原后通过。
- `npm run build:renderer`：通过（renderer-extension 本轮没有改动）。
- `node tools/check-boundaries.mjs`：通过。
- 改动文件跑 `prettier --check` 与 `eslint`：通过。没有跑全仓 lint，lint 基线里 rly0-hub-promo.test.ts:11 的既有错误不在改动文件中。
- 编译产物 `dist/codex-update-hold.js` 用 node:vm 冒烟，喂入真实形态的 gate 消息：发出的纠正副本为 `disableSparkleAutodownload:true`、`disableInAppUpdates:null`，其余字段原样。

## 未做 / 需真机

- 没有在真实 Codex 中验证纠正消息的效果（SUAutomaticallyUpdate 是否保持 0、是否不下载、是否不弹窗），也没有验证主进程对两条消息的处理顺序。
- 首条 gate 消息早于注入时，启动时的那次检查可能已经开始下载。要彻底解决需要在页面脚本运行前注入（CDP `Target.setAutoAttach` + `waitForDebuggerOnStart`，或主进程方案），涉及 Launcher/controller 启动时序，需要另立工单。
- safe 模式不注入，无法拦截。
- 开发版包装脚本与正式 Launcher 的真实 `ps` 形态、正式 Launcher 退出耗时、macOS 27 上 watchdog 实际写回检查日期，都需要真机验证。
- codex-update-manager.ts 约 890 行，超过 800 行的复查信号。新增的 reopen 确认与 hold 发布仍属于同一状态机，本轮没有拆分。
