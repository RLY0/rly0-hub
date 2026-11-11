# Codex 官方更新提醒复查 #1 修复结果

日期：2026-11-12。状态：**implemented / self_verified**；修复后的 independent reviewed / accepted **尚未完成**。主会话亲自运行检查，没有另起审查代理或伪造独立结论。

## 范围与输入

- cwd：`/Volumes/RLY0Dev/Dev/Projects/codex插件助手/.runtime/agent-cli-autoupdate`
- 分支：`feat/agent-cli-autoupdate`；输入 HEAD：`a5da7809095786315b20e0055547d11f55d0bdf9`，开始时工作树干净。
- 首先读取报告：主目录 `.pm/selfheal/CODEX-UPDATE-ALERT-REVIEW-1.md`；SHA-256 `1ce122d37d048c76acd6b4236eafde3507ec63b83331ca7833d5a573efe711a7`。
- 原问题：主目录 `.pm/selfheal/CODEX-UPDATE-ALERT.md`；SHA-256 `158919f3afd30a825d5f58b11a4f2826cde02d59a169fa6765a1a9f0f86ea4d3`。
- 保留用户已定行为：Hub 在适配和实际放行前压住更新及后台新版提醒；放行后走原自动下载/安装流程；关闭管理恢复原设置。5 分钟键鼠空闲及连续 15 秒复核不变。
- 只改上述 worktree 的后台、测试、契约、功能文档和进度/证据。`apps/hub-desktop/www`、Rust、renderer、发布脚本均未改。
- 本地提交包含此文件；提交号可用 `git log -1 --format=%H -- .pm/selfheal/evidence/codex-update-alert-review1-20261112/RESULTS.md` 查得。最终代码/测试/契约/功能文档指纹见 [source-sha256.json](source-sha256.json)，命令与结果摘要见 [checks.json](checks.json)。

## 逐条处理

以下路径均相对 cwd，行号对应本轮最终文件。

| 报告项 | 修复及实现位置 | 回归证据 |
| --- | --- | --- |
| 重要 1：已适配但未真正放行时又弹窗 | `codex-sparkle.ts:296` 从所有较新候选取最大 build，不再排除已适配版本；`codex-update-manager.ts:707` 与 renderer 的“enabled && !armed”条件一致；`:254` 在租约占用验证后才撤销跳过；`:803` 收回放行时重设跳过。完整路径位于 `packages/host-runtime/src/rly0-hub-service/`。 | `packages/host-runtime/test/codex-update-alert.test.ts:335` 混合候选；`:434` 首见已适配；`:443` 最后失去空闲后重新压住并可再次放行；`:463` 下载/体检等错误退避；`:480` 三次超时挂起；`:501` 另一活 owner；`:551` 实际下载时不重写跳过，发现未知版本才收回。均 pass。 |
| 重要 2：五分钟刷新临时失败导致六小时退避 | `codex-update-manager.ts:573` 活动状态下局部 catch，保留等待/下载与已有值；确认未适配候选才进入兼容等待；`:853` 用户值临时读失败不打断下载；`:872` 最后 feed 复核失败只延后退出；`:956` 最后用户值读失败收回本次准备，不 quit、不加失败。 | `codex-update-alert.test.ts:515` feed/写偏好失败、没有新增 attempt 记录；`:539` 退出前 feed 失败后下次可继续；`:551` 下载网络错误不改原 attempt；`:747` 已放行下载中读偏好失败保持下载；`:766` 退出前读失败重新压住、failure=0。均 pass。 |
| 重要 3：用户跳过的版本仍导致白关重开 | `codex-skipped-version.ts:105` 扣除已确认 Hub 值，使用原始用户值或当前用户值比较 build；`codex-sparkle.ts:307` 按目标展示版本查对应最大 build；`codex-update-manager.ts:723` 转 `user-skipped`，两处退出前检查，禁止正常 quit/重开；status 附带 `userSkippedVersion`，error 为 null。 | `codex-update-alert.test.ts:295` 同值/更高用户跳过均不创建 watchdog、不发 AppleScript；`:572` 放行准备中用户新跳过也不 quit；`:590` 用户移除跳过后可继续；`:718` 原始用户跳过被较高 Hub 值覆盖时仍拦住实际较低签名目标；`:736` 同展示版本不同 build 不误判。均 pass。 |
| 次要 4：defaults 类型及 macOS 27 缺键格式 | `codex-check-preferences.ts:58` 读取字符串或非负整数，按实际类型恢复；不支持的 bool/float/array/dictionary 拒绝覆盖。`codex-update-alert.test.ts:79` 按键返回 boolean/date/string/integer/array，并保留原始 stdout 换行；两个旧完整流程 fixture 在 `codex-version-gate.test.ts:1515` / `:1888` 补齐 read-type，保留原断言。 | `codex-update-alert.test.ts:600` 展示版本 26.1106.51428/build 26605 的真实 appcast 元素形态（URL/数据环境 synthetic）；`:610` 整数较低/较高原值与类型恢复；`:623` 非法类型不覆盖；`:635` macOS 27 缺键、缺域及旧错误同时用于 read/delete 注入；`:652` 权限错误不当成缺键。均 pass。缺键 delete 为格式回放，不是本轮原生命令实测。 |
| 次要 5：未确认写入误认领用户值 | `codex-skipped-version.ts:87` 只有 confirmed written / 已确认 previous 才属 Hub；`:122` 原子保存 confirmed:false 意图，写后读回才能确认；`:147` 未确认值恢复时不删。响应丢失但读回成功可确认；响应/读回均不明则保守保留。兼容旧 schemaVersion 1。 | `codex-update-alert.test.ts:410` 响应丢失而读回确认、下次 Hub 恢复；`:661` 写失败后用户恰好跳过同 build，不认领不删除；`:676` pending replacement 仅恢复旧已确认值；`:698` 响应和读回均丢失时保留当前值；旧的崩溃、用户改值、坏记录及 watchdog 边界仍 pass。 |

状态机仍由原串行 manager 维护；跳过归属/类型恢复留在已有 skipped-version / preferences 模块，未增加第二套定时器或更新执行器。

## 契约与 Claude 交接

`.pm/selfheal/CODEX-VERSION-GATE-CONTRACT.md:305` 新增“2026-11-12：官方更新提醒复查 #1（交 Claude）”，主 phase 表也加入新状态。

- `phase` 新增 `user-skipped`；可选 `userSkippedVersion:string` 仅在此 phase 返回，值是被拦住的目标展示版本；`error:null`。
- 建议说明用户已跳过该版本，Codex 照常可用。不要显示“正在下载/安装”或引导循环重启；不新增清除用户跳过值的 RPC/按钮。用户移除跳过值或后续目标高于它，下次检查恢复正常流程。
- RPC 方法、错误码和已有字段语义保持；内部 driver 增加 `isVersionSkipped(version)`，hold 不再需要 verified 回调。
- 归属记录仍 schemaVersion 1，增加可选 `originalType:"integer"` 和 `confirmed:false`，旧记录按原归属语义读取。
- `docs/features/codex-version-gate.md:5` 更新当前行为、等待/退避、用户跳过和恢复边界。没有更改界面或声称 Claude 已接线。

## 隔离与验证

按 `.agents/skills/codexhost-pre-push-checks/SKILL.md` 选检查：受影响包的 5 个相邻测试、类型、改动文件 ESLint/格式、依赖边界。没有跑无关 Rust、renderer、live gate、完整仓库测试或发布构建。

工具：Node `v24.22.2`、npm `11.19.1`、Vitest `4.1.10`。Node/npm 路径均在 `/Volumes/RLY0Dev/Dev/Cache/node-v24/bin/`。

每条检查命令由一次性 Python 子进程环境运行，完成后清理临时根目录；不是在本机会话中改写全局环境：

```text
HOME=<new temporary root>
USERPROFILE=<same temporary root>
CODEX_HOME=<root>/codex
CODEXHOST_DATA_DIR=<root>/hub
RLY0_MEMORY_DIR=<root>/memory
RLY0_SKIP_LEGACY_IMPORT=1
RLY0_CODEX_UPDATE_CONTROL=0
```

被测 defaults、osascript、ps、sw_vers、lsappinfo、plutil、codesign、启动/退出/watchdog 操作走注入驱动。相邻测试既有的 Python guard harness 注入 subprocess.run/os.kill；空 Node 退出所有者探针属于测试 harness，继承外层隔离环境，结束后退出。没有启动被测原生 Codex/Hub、真实 watchdog 或 hub-service。

最终回归命令：

```sh
npx --no-install vitest run --config tests/vitest.config.js \
  packages/host-runtime/test/codex-update-alert.test.ts \
  packages/host-runtime/test/codex-version-gate.test.ts \
  packages/host-runtime/test/codex-update-watchdog.test.ts \
  packages/host-runtime/test/codex-input-idle.test.ts \
  packages/host-runtime/test/rly0-codex-updates-ui.test.ts
```

| 检查 | exit | 结果 |
| --- | --- | --- |
| 实现前 alert 聚焦回归 | 1（预期） | 52 项中 20 fail、32 pass；证明原实现缺少对应边界，未删断言或跳过。 |
| 第一轮 alert 聚焦 | 1 | 51 pass / 1 fail；新增确认断言误用于恢复写，已将断言限定首次目标写入。 |
| 第一轮 5 文件相邻回归 | 1 | 193 pass / 2 fail；两处旧完整流程系统驱动未提供 read-type，补真实类型后复验。 |
| 最终上述 5 文件回归 | 0 | **199 pass / 0 fail / 0 skip**；alert 59 项，其他四文件保留原测试。 |
| `npm run typecheck` | 0 | 最终源码及 tests 均通过，`tsc -b` 生成本地 dist；没有运行 release/build:plugins/打包。 |
| 改动 6 个 TS 文件的 `./node_modules/.bin/eslint` | 0 | 最终文件检查通过。 |
| `node tools/check-boundaries.mjs` | 0 | 依赖边界通过。后续仅补局部错误处理和测试，未改变依赖方向。 |
| 改动文件 `./node_modules/.bin/prettier --check` | 0 | TS、BOARD 和证据 JSON 格式通过；仓库默认忽略 Markdown。 |
| `git diff --check` | 0 | 无空白错误。 |
| `npm run lint` | 1 | 仅输入已有 `packages/host-runtime/test/rly0-hub-promo.test.ts:11:20`，Forbidden non-null assertion。本轮改动文件已单独通过；聚合 lint 未运行到边界检查，已单独运行通过。 |

基线 lint 文件当前/输入 SHA-256 均为 `ffda9088fbf18a02d9990616cee66705446f66f1ea38f201f917062131893caa`，字节比较相同。本轮没有顺手修改该文件。npm 的 `Unknown env config "store-dir"` 是命令环境提示，未导致类型/测试失败。

精确 ESLint 范围：

```sh
./node_modules/.bin/eslint \
  packages/host-runtime/src/rly0-hub-service/codex-check-preferences.ts \
  packages/host-runtime/src/rly0-hub-service/codex-skipped-version.ts \
  packages/host-runtime/src/rly0-hub-service/codex-sparkle.ts \
  packages/host-runtime/src/rly0-hub-service/codex-update-manager.ts \
  packages/host-runtime/test/codex-update-alert.test.ts \
  packages/host-runtime/test/codex-version-gate.test.ts
```

## 仍需确认与保留边界

1. 修复后独立复核、Claude 的新状态接线及用户验收未完成；本报告不能作为已发布或真机放行证据。
2. 获准独立真机确认：运行中 Sparkle 何时读取外部偏好、定时检查是否完全无官方窗口、已弹窗口是否消失；critical 更新、“稍后提醒我”和显式手动检查是否绕过跳过值。没有逐条反汇编 Sparkle 2.9.1 比较逻辑。
3. 获准真机确认适配后正常空闲后台下载/退出安装、用户关闭管理、整数原值行为、崩溃/真实 watchdog 恢复；本轮 macOS 27 缺键删除只回放记录格式。Windows 未本地验收，原不支持单应用商店控制的边界不变。
4. 新记录写入未确认时保守保留当前值，可能把一次实际写成功但未确认的 Hub 值作为用户跳过，等待后续人工处理；不能猜测后删除。缺少 confirmed 的旧记录继续按旧已确认归属处理，不能追溯消除旧 false positive。
5. defaults 没有原子 compare-and-swap，最后比较/写入之间仍存在其他进程更改的竞争；feed 观察间隔、当前 B1/safe 模式及用户手动更新入口等原有边界保留。

本轮没有写用户真实 `com.openai.codex` defaults，没有退出/重启用户 Codex 或 Hub，没有另起 hub-service，没有改 App 包、安装、推送或发布。
