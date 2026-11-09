# 版本门禁第三轮复查修复 证据（2026-11-09，Claude）

基线 a937545e（feat/codex-version-gate）。全部为主会话亲跑；隔离环境：临时 HOME/USERPROFILE/CODEX_HOME/CODEXHOST_DATA_DIR/RLY0_MEMORY_DIR，RLY0_SKIP_LEGACY_IMPORT=1，RLY0_CODEX_UPDATE_CONTROL=0，Node v24.22.2（外接盘缓存）。

## 处理

| 复查条目 | 处理 | 测试 |
| --- | --- | --- |
| #1 `path to application` 拉起 Codex | 新增 `codex-bundle-location.ts`；`codex-sparkle.ts` quit 前用 lsappinfo 记录路径（后备 Launcher installRoot，都没有则拒绝退出）；installationStopped 只用记录值；quit 加 `is running` 保护 | 完整“后台检查→下载→安装→体检”流程用真实 Mac 驱动 + 注入命令跑到 up-to-date，断言所有命令无 `path to application`、`tell application` 均带保护；两种 lsappinfo 格式解析；Launcher 后备与拒绝退出；变异检查：恢复旧查询后 8 条用例失败 |
| #2 Windows 白名单 | `build-hub-service.mjs` 平台参数，仅 darwin 产出 watchdog；`build.ps1` 传 `--platform win32`；Mac 调用方传 darwin；`verify-kit.mjs` 必备清单加 watchdog | `payload.test.mjs` 在临时目录建 Windows 形态载荷，实际 esbuild 构建 win32 服务后 `validatePayload`（用真实仓库路径做引用检查）通过；darwin 构建产物被白名单与审计拒绝 |
| #3 SIGTERM 不释放锁 / pid 复用 | 新增 `shutdown.ts`，入口处理 SIGTERM/SIGINT 共用一次 dispose；`codex-update-control.ts` 记录 `startedAt`，ESRCH/EPERM/启动时间不同/本 pid 非本进程持有的 id 判失效 | 注入启动时间与信号探测覆盖各情形；SIGTERM（模拟信号源）→ manager.stop → owner 文件删除、exit(0)、dispose 只一次；卡住时 exit(1) |
| #5 旧 watchdog 晚退出 | manager 回调绑定租约 id | 旧租约回调晚到不触发重新挂 watchdog，当前租约回调才触发 |
| #6 pid 复用取到最旧记录 | `records.find`（Launcher 新记录在前） | 同 pid 两条真实形态记录取最新版本 |
| #4（仅后台） | `codexNativeUpdateControlBlocker` + status 可选 `unsupportedReason` | 平台/开发关闭/外接盘数据目录三类原因；supported=true 不带该字段 |

## 检查（亲跑）

- vitest（11 文件）：codex-version-gate、codex-update-watchdog、codex-input-idle、codex-renderer-policy、rly0-hub-service、rly0-codex-updates-ui、hub-macos、hub-watchdog、payload、packagers、macos-validation-kit → 11 文件通过，186 过，1 跳过（payload.test 中既有 Windows 专用用例“starts the current npm CLI without a batch file”）。日志 regression.log。
- `npm run typecheck` → 通过（typecheck.log）。
- `node tools/check-boundaries.mjs` → 通过（boundaries.log）。
- eslint 仅改动文件 → 0 错误（lint.log）；prettier --check 仅改动文件 → 通过（format.log）。

## 未跑 / 未确认

- 未跑：Rust（无改动）、Windows 实机 `build.ps1` 与 `prepare-payload` 全流程（本机为 macOS；以同一构建函数 + 白名单校验代替）、原生 Mac 开发包构建（RLY0_WATCHDOG_NATIVE_KIT=1）、全量 `npm run check`。
- 唯一触碰真实系统的命令：一次只读 `lsappinfo info -only bundlepath -app com.openai.codex`，输出为 `bundle path="/Applications/ChatGPT.app"` 形态。未运行任何针对 Codex 的 osascript，未写 defaults，未启动 watchdog，未动 Hub/Codex/App 包。
- 真机待验：lsappinfo 在退出过程中的表现、正式包 SIGTERM 后锁文件删除、真实 Launcher installRoot 形态、复查报告第 7 条各项。
