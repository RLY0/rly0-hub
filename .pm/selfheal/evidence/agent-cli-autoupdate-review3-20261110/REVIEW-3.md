# HUB-AGENT-CLI-AUTOUPDATE 独立复查 #3（2026-11-10，只读，范围 62f2bdcc..841b7a22）
结论：修完后可进入真机验收。隔离编译 + 16 文件 234 项全过；/tmp/acrev3（scen、loop、locks3、tree3、idle、ui）复现。上轮阻断 1、重要 2/3/4、PRE_UPDATE_VERSION_MISMATCH 确认修好（setsid 脱组为契约已写局限）。
界面 N4（ROLLBACK_FAILED/COMMAND_TREE_STOP_FAILED/STATE_WRITE_FAILED 被 recoveryPending 盖住）与 INSTALL_FILE_BUSY 在 skipped-unsupported 下的显示，Claude 已在 bc3fd9a1 修好——契约 v3 “恢复待处理优先显示”一句需改为“除上述三个错误外”。

## 阻断
N1 agent-cli-updates.ts:508-526、:250-257：回退后旧版检查超时或 Host 暂不在 → failed/CHECK_TIMEOUT 或 HOST_UNAVAILABLE，二者在分钟重试名单；按重要 2 新版已不在 badVersions；下一分钟更新前检查正常即再装新版 → 每分钟“装新版→回退”循环（loop.mjs：刚装 CLI 首次连接检查超时一次，4 次分钟定时共装 10 次；Mac 新装程序首启常被安全扫描拖慢，现实可遇）。锁反复占用、会话被拒，界面一直“旧版本已恢复，等连接检查正常”。修（二选一并补测试）：回退流程产生的结果（causeCode 非空）不进分钟重试，只等每日/手动；或记录“上次试装的目标版与时间”，同一目标版每天最多自动试装一次。

## 重要
N2 agent-cli-update-driver.ts:402-421、agent-cli-updates.ts:250-258、:409：先让所有 Host 释放空闲会话、后扫描外部进程；skipped-busy 每分钟重试，每次都再释放（scen R3：外部一直占用时 16 助手×6 轮共 96 次带释放的检查）→ 用户外部终端开着同一助手或另一 Host 正在用时，本 Host 的空闲会话每分钟被关一次。修：两步法——先对所有 Host 只查忙碌+扫描外部进程，全部空闲才释放，释放后再扫一次；同一目标版的释放限频。
N3 external-thread-idle-release.ts:189（排除子代理）与 :222（判定还有线程）：子代理线程恢复后是只读快照会话（external-thread-runtime.ts:839），不占 CLI 进程，但永不符合释放条件又被算“还有线程”；预热草稿同理（idle.mjs：父会话关了、子代理留下 → busy=true）→ 打开过 pi/grok/cursor-cli/omp/codebuddy/antigravity 子代理视图的用户在重启 Codex 前永不更新，叠加 N2 父会话每分钟白关。修：最终判定与 Host 忙碌检查忽略只读子代理会话（或顺手释放）；预热草稿持有真实会话可继续算忙，但靠 N2 两步法避免误关。

## 次要
- external-thread-idle-release.ts:279-281：更新触发的释放若关闭失败/超时（60s），会话被锁到重启 Codex，而用户并未开“自动空闲释放”——写明后果或改为失败即保留会话、不锁。
- INSTALL_FILE_BUSY 预检结果是 skipped-unsupported 且只等每日——建议改为等待类结果（界面已按等待显示）。
- app-server-host.ts:1562：更新期间刷新 AI 助手页，内部 AGENT_CLI_UPDATE_BUSY 原始错误被写成助手连接错误——建议给出“正在更新”的可读状态（字段写进契约交 Claude）。
- agent-cli-updates.ts #drainQueue：另一个 Hub 长期占协调锁时本 Hub 每 100ms 抢锁、约每秒一次系统进程查询——加退避。

## 已确认安全
正在干活/待审批/后台工作/子任务的会话不会被关；释放时恰好发消息不会出错；释放后可按原 resume 机制恢复；任一会话未释放即 busy=true 不安装；普通 inspect 在锁内返回 -32072 不拉起 CLI。
