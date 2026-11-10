# HUB-AGENT-CLI-AUTOUPDATE 独立复查 #1（2026-11-10，只读，范围 9dfd747c..976c0194）
结论：修完后可进入真机验收。复查者隔离亲跑 10 文件 97 项全过；B1/B2 用编译产物 + 假驱动在 /tmp 复现。

## 阻断
B1 agent-cli-updates.ts:311、:356；agent-cli-update-driver.ts:319-328：更新前本来就不 ready（未登录——已确认 Copilot 未登录 inspect 返回 unavailable；联网检查抖动；Host 未加载插件 -32077；检查中关 Codex HOST_UNAVAILABLE；超 60 秒）→ 新版检查不 ready → 回退 → 回退成功判据也是 ready → 必然 ROLLBACK_FAILED；回退日志保留，之后每次启动/每日检查都走恢复路径再装一次旧版，且不受开关控制；好版本被永久拉黑。复现安装记录 ['1.1.0','1.0.0','1.0.0']，failed/ROLLBACK_FAILED。测试 agent-cli-updates.test.ts:59 把回退后检查一律 mock 为 true。修：安装前先 ready() 做基线，不 ready 跳过不装；回退成功判据=版本读回等于原版本且恢复到基线状态；HOST_UNAVAILABLE/超时不算新版坏、不拉黑、稍后重试。
B2 agent-cli-updates.ts:305-317、:343、:353-361：安装失败但什么都没改（断网、ETARGET、镜像未同步；service.ts 注入 npm_config_proxy="" 覆盖用户 .npmrc 代理；Hub 安装器有 npmmirror 备用源 agent-installer.ts:949 自动更新却没有）→ 回退也要联网同样失败 → ROLLBACK_FAILED + 永久拉黑。修：安装失败后先读版本，仍为原版本就当没发生、清日志、不拉黑、下次再试；最新版本查询改用与安装相同的 npm/registry（如 npm view）或沿用安装器镜像回退；别用空 npm_config_proxy 覆盖用户配置。

## 重要
1 死锁：rly0-agents/cli-update-admission.ts:14-25、:61、:64-79：Host 只要锁目录有 .json 就拒绝，不判持有者存活；损坏/空锁按活着；EPERM 或 pid 复用也算活着；Hub 拿锁后写日志前崩溃且之后走不到获取锁（已最新/已拉黑/关开关）→ 锁永不清 → 该助手永久打不开。修：原子写锁含 pid+启动时间；Hub 启动统一清死锁；Host 端也判存活。
2 恢复盲信日志 agent-cli-updates.ts:333-343：不读当前版本就强制装回旧版（会降级用户手修或厂商自更新的版本），npm 没动也拉黑目标。修：恢复前读版本，既非原版本也非目标版本→放弃日志；仍是原版本→只清日志。
3 更新的不是 Host 在用的那份 agent-cli-update-driver.ts:91-118：未读 harness-launch-settings/<id>.json（agents.launchPathSet），环境变量名自推；自定义路径时更新 PATH 上另一份，Host 那份未变连接仍 ready → 误报 updated。修：读同一份启动设置，或让 Host 返回实际可执行文件。
4 PERMISSION_DENIED 不会出现 harness-discovery/src/installation.ts:48：非零退出时 error.code 为数字（本机实测 npm EACCES 退出 243 → number 243），只有启动失败才是字符串。root 所有前缀落到 INSTALL_FAILED → B2 循环。修：安装前检查前缀 lib/node_modules 与 bin 可写，不可写直接报不支持。
5 Windows：超时 SIGKILL 只杀 cmd.exe，npm 继续写，回退又并发起 npm；busy 不算“已打开但空闲”的会话，OpenCode 每会话常驻 opencode serve（adapters/opencode/src/command.ts:72），独立终端里的 CLI 也一样 → EBUSY → B2、半装。修：超时杀进程树；安装前检查有无进程占用该可执行文件/前缀，有就报忙。

## 次要/存疑
- 界面：Codex 没开时每张卡警告色“自动更新没成功：Codex 没开着”（agent-cli-updates.js:70-73）应改等待色；每分钟为 16 个助手各写一次状态文件（后台）。【界面 Claude 修】
- （存疑）回退失败文案“请在下面重新安装一次”，已安装卡片无重装按钮。【界面 Claude 修】
- 手动检查被吞：check()（agent-cli-updates.ts:188）有检查进行时直接返回那次结果；忙碌重试进行中点“全部检查”被丢弃。
- （存疑）两个 Hub 共用状态文件后写覆盖先写，可能抹掉坏版本名单/回退日志。
- （存疑）deepseek recipe 锁 @deepseek-ai/dsh@0.1.5-rc.1，剥离后更新到 latest 0.2.2-rc.1，与锁版本初衷冲突——建议遵守 recipe pin（不自动更新被 pin 的包，或只在 pin 范围内）。
- （存疑）围栏未覆盖 webUi.open、inspectAccount、Hub 侧登录流程（grok-add-login 等）；被拒时用户看到原始错误码 AGENT_CLI_UPDATE_BUSY，结束后不自动恢复。
- 停服可能很慢：一次事务最长约 安装 300s + 每 Host 检查 60s + 回退 300s。

## 已确认无问题
RPC 严格不收命令/包名/版本；状态不带 stderr/代理/路径；始终显式 --prefix、无 sudo、不用 npm prefix -g；包名剥离与 scoped 推导正确；界面枚举与契约一致、离开页面停止轮询。
