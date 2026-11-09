# HUB-CODEX-VERSION-GATE 第二次复查修复

日期：2026-11-09。隔离 worktree：`/Volumes/RLY0Dev/Dev/Projects/codex插件助手/.runtime/codex-version-gate-20261109`，分支 `feat/codex-version-gate`；输入提交 `c796e85c`。状态：implemented / self_verified；本轮只有执行者自检，未进行修复后独立审查，未 reviewed / accepted，不构成发布放行。

范围：报告 `.pm/selfheal/CODEX-VERSION-GATE-REVIEW-2.md`（来源为主工作区对应文件），N1/N2/N3/N4、上轮 6/7 必修，N6–N11 一并处理。N5 的默认空闲定义没有改变，仅提供可替换接口。未改 `apps/hub-desktop/www`。

## 逐项结果

| 项目 | 实现 | 回归证据 |
| --- | --- | --- |
| N1 阻断 | 构建第二入口 `codex-update-watchdog.js`；服务构建、开发原生包预检及正式包审计要求主服务/watchdog 均为非空文件 | baseline archive 实际打包只有 hub-service.mjs；新打包测试审计存在性，删除 watchdog 后审计拒绝；实际临时原生开发 .app 构建/ad-hoc 验签通过，使用包内 Node 加载包内 watchdog runner，注入全部系统驱动，收到 ready，再模拟父进程退出，首次恢复失败后第二次恢复成功，进程退出码 0 |
| N2 阻断 | 按 `com.openai.codex` bundle id 读取运行状态；由系统解析真实安装目录，只等待该目录及该 bundle 缓存下的 updater，不按应用名硬编码 | ChatGPT.app、Codex.app、改名目录、自身缓存 updater、其他应用 updater；运行状态非法响应拒绝，不推断为已退出 |
| N3 | 独立 2 秒续租，不经过串行队列；唯一临时文件防续租写冲突；子进程退出通知清 armed 并在下载 tick 重拉；活父进程超龄阈值 5 分钟并允许 15 次观察恢复窗口，父进程死亡立即关回 | 阻塞 catalog.refresh 串行队列时仍实测续租；睡眠/时间跳变恢复；子进程退出重拉；失效租约与显式取消 |
| N4 | 原生控制必须是系统登录用户 HOME 与默认数据目录；非默认目录、dev/test 模式或 RLY0_CODEX_UPDATE_CONTROL=0 时 driver=null；Swift 开发模式显式禁用、正式模式透传 | 默认真实目录允许、临时 HOME/目录、开发标志、显式关闭、test 与 Windows 拒绝；Swift 已在本轮开发 .app 中实际编译 |
| 上轮 6 | Launcher 读取路径对齐 `<CODEXHOST_DATA_DIR 或 ~/.codexhost>/diagnostics/launcher-startup-v1.json`；相对覆盖路径与 Launcher 一样忽略 | 显式与默认目录测试，匹配真实 StartupRecord 字段及 ChatGPT.app installRoot，按父 pid 匹配，错误 pid 不放行 |
| 上轮 7 | originalCheckPreferences 独立 catch，坏字段只丢辅助原值，不丢 enabled/originalAutoUpdate | 损坏辅助字段后 enabled 与 originalAutoUpdate=true 仍在；关闭时恢复 true，未重新读取 Hub 自己的 false |
| N5 待定 | 所有退出前判断经 CodexIdleDriver/options.idle；默认仍是原来的 busy=false 连续 15 秒 | 注入 idle 驱动验证所有退出检查经过该驱动，不调用默认 busy；未自行决定新的空闲标准 |
| N6 | quit 返回 30 秒后仍运行即清关闭记录并退避；若已经更新并由 Sparkle 重开则进入体检 | 30 秒取消后，用户后来自行退出不会被重开；版本已达目标且进程运行时不再 reopen |
| N7 | 恢复记录从 24 小时缩至 5 分钟；晚于记录的 Codex 心跳作废关闭归属，丢弃记录 | 超龄与较新心跳两种情况均不重开；已有中断安装恢复回归保留 |
| N8 | watchdog 写失败重读租约后重试，携带辅助原值并有条件恢复；保留 Sparkle 新检查日期；原生数据目录排他锁，已退出 owner 的接管也串行化 | 首次 disarm 失败再次成功，包内 worker 同样覆盖；新 check date 不覆盖；两个活 owner 拒绝、真实已退出 child pid 的并发接管仅一个成功 |
| N9 | enclosure 缺失/非法 shortVersionString 整份 feed 拒绝，不遗漏 Sparkle build-only 条目 | 只有 sparkle:version 的真实形态 enclosure 触发 CODEX_APPCAST_FAILED；原候选/实际暂存分离测试保留 |
| N10 | 读取 minimumSystemVersion，feed 最大展示值与系统可安装集合分离；无较新可安装版本不重开；连续三次下载超时暂停至 feed 变化，失败计数跨重启保存 | 系统门槛解析、无可安装新版本保持 up-to-date 且仍展示 feed 最大版本；三次超时后跨 manager 重启仍不 quit，feed 改变恢复；成功/feed 改变重置计数 |
| N11 | 重启/重新开启在退避期返回保留的错误及终态；强制验签按暂存身份在 15 秒单调时钟短窗口复用，身份变化或超时重新验签 | 重新开启不永久 checking；同一短窗口内重复强制检查只验签一次；已有缓存身份变化、删除及退出前验证回归保留 |

## 验证与基线

所有最终检查以临时 HOME/USERPROFILE/CODEX_HOME/CODEXHOST_DATA_DIR/RLY0_MEMORY_DIR，`RLY0_SKIP_LEGACY_IMPORT=1`、`RLY0_CODEX_UPDATE_CONTROL=0` 运行。涉及偏好、进程控制的测试均注入驱动；临时 HOME 自身不被当作 defaults 隔离保障。baseline 是 `git archive c796e85c` 到临时目录，使用相同已安装依赖，未改原工作树来回切换。

| 检查 | 固定基线 | 本轮最终 | 命令/输出 |
| --- | --- | --- | --- |
| 选定回归 | 7 个原有文件，116 pass，0 fail | 8 个文件，148 pass，0 fail，0 skip（原有文件新增 31 条，新增打包文件 1 条） | `npx vitest run --config tests/vitest.config.js <8 files>`，完整参数见 [regression.json](regression.json)，基线见 [baseline.json](baseline.json) |
| 类型 | exit 0 | exit 0 | `npm run typecheck`，[typecheck.json](typecheck.json) |
| lint | exit 1，rly0-hub-promo.test.ts:11 既有 non-null assertion | exit 1，同一路径/规则/行，新增 0 | `npm run lint`，[lint.json](lint.json)；未修改/跳过此无关测试 |
| 依赖边界 | 未另跑（lint 在既有错误处停止） | exit 0 | `node tools/check-boundaries.mjs`，[boundaries.json](boundaries.json) |
| 改动格式 | 本轮改动选定 | exit 0 | `node_modules/.bin/prettier --check <changed files>`，[format.json](format.json)；证据 JSON 同样已格式化 |
| 原生开发包 | 旧服务 bundle 确认缺 watchdog | 1 个原生包专项 pass | `RLY0_WATCHDOG_NATIVE_KIT=1 npx vitest run --config tests/vitest.config.js tests/release/hub-watchdog.test.mjs`，[native-package.json](native-package.json) |
| 其他 | 不适用 | pass | `bash -n apps/hub-desktop/macos/build-on-mac.sh`、`git diff --check`；`apps/hub-desktop/www` diff 为空 |

按 codexhost-pre-push-checks 选择 TS/契约/平台与打包检查。未改 Rust 或 renderer-extension，不运行全量 Rust、全量 TS、renderer build 或重复浏览器矩阵；本轮原生 Swift 已由开发包构建检查。原生开发包是临时 ad-hoc .app 与开发 ZIP，不是正式 DMG/发布包；未启动 Swift 窗口、Hub service 或真实 Codex。测试完成自动删除临时产物，可按上述命令重复构建。

源码指纹：[source-fingerprint.json](source-fingerprint.json)，排序路径+文件 SHA-256 行聚合：`58d5c853958802fe96192e6eae123894a7e7184d90870c43fca3451466b04fbf`。Node v24.22.2、npm 11.19.1。所有检查原始脱敏摘要、命令、cwd 与退出码见同目录 JSON；JSON 中 base 表示输入提交，未提交源码由此指纹绑定。

## 契约与交付边界

[CONTRACT v3](../../CODEX-VERSION-GATE-CONTRACT.md) 无 RPC 字段、phase 或错误码变更；supported=false 新增环境隔离语义，退避/取消/暂停文案和可替换 idle 驱动已说明，交 Claude 接显示层。同步更新功能文档、PROGRESS/PROGRESS_CODEX、BOARD 与老板看这里。正式打包、版本号和发布仍由 Claude 负责，本轮仅按工单构建临时验证产物。

未运行：真实 Sparkle 静默检查/下载/安装/重开、真实 defaults 权限、Windows、旧 guard 部署及与睡眠唤醒的真实互操作。未修改 guard 运行文件，未退出/重启用户 Codex/Hub，未上传、推送、发布。旧 guard patch 的 60 秒门槛仍需在实际部署与互操作验收时核对，不能用本轮测试证明真实升级已经通畅。损坏的原始辅助偏好无法凭空还原；损坏 owner/reclaim 记录按拒绝接管处理，避免误夺控制权。

next_action：用户决定 N5；Claude 核对契约 v3 和文案；另独立会话复查本轮安全敏感改动；之后再在获准独立环境验收真实升级与 guard/Windows，决定发布。执行者未自批 accepted。

【可复用结论】
- macOS 临时 HOME 不能隔离 cfprefsd 或应用控制；原生更新控制需显式环境门禁，并核对系统登录用户 HOME 与默认数据目录；测试系统副作用必须注入驱动。
- Hub 主服务为单文件 bundle 时，相邻 watchdog 源码不会自动进入产物；watchdog 必须独立构建入口、做产物存在性审计，并用包内 Node/包内 worker 验证启动与握手。
- Codex 的 bundle id 是 com.openai.codex，应用文件名可为 ChatGPT.app；按 bundle id 查询运行状态，按系统解析的安装目录匹配自己的 updater。
- Launcher 身份记录在 <CODEXHOST_DATA_DIR 或 ~/.codexhost>/diagnostics/launcher-startup-v1.json，读取时匹配父 pid；临时目录测试也须采用实际目录和 StartupRecord 形态。
- watchdog 续租需独立于长时间串行任务，保留子进程退出监听并允许重拉；恢复写失败须重新确认租约归属后重试。
- Sparkle 的新 SULastCheckTime 不应被旧快照覆盖；辅助字段损坏不能丢失已保存的 originalAutoUpdate。
- Sparkle feed 里无法映射 shortVersionString 的 enclosure 应拒绝，而不是静默过滤；展示的 feed 最大版本、当前系统可安装集合和实际签名暂存目标须分开。
- 本轮隔离原生开发包与 148 项回归不替代真实 Sparkle、Windows、guard 部署或发布验收。
【可复用结论结束】
