# HUB-AGENT-CLI-AUTOUPDATE 独立复查 #2（2026-11-10，只读，范围 976c0194..62f2bdcc）
结论：修完后可进入真机验收。复查者隔离编译+13 文件 175 项全过；/tmp/acrev2/scen.mjs（15 场景状态机）、locks.mjs（真实锁探针含时区）、tree.mjs（进程树/占用）复现。上轮 B1、B2、重要 1–4、关开关、停服、recipe pin 均确认修好（重要 3 仅读代码）。

## 阻断
1 安装超时每分钟重装：agent-cli-updates.ts:53-59 把 npm 安装超时（"Harness command timed out"）归为 CHECK_TIMEOUT；:242-248 每分钟重试所有 CHECK_TIMEOUT；:448-451。网络慢一次安装 >300s 版本未变 → 每分钟再跑一次 300s 安装，锁一直占着，用户开会话被拒。复跑 3 次分钟定时 pi 装了 4 次。修：安装超时用单独码或归 INSTALL_FAILED，按每日或递增间隔重试；每分钟重试只留给读版本/连接检查超时。

## 重要
1 加载过就一直忙：agent-cli-update-system.ts:97-107 把 Host 自己持有的空闲常驻进程（opencode serve、ACP 子进程）算作占用；空闲释放默认关（shared-contracts/src/idle-release.ts:15-18）→ 常用该助手且 Codex 常开的用户几乎永不更新，卡片一直“正在干活”。修：拿到锁后请 Host 释放该助手的空闲会话（不打断运行中的回合）再装，装完会话按需重开；或把 Host 自己的子进程交给 Host 的忙碌语义判断。
2 新旧版都不 ready 仍拉黑新版：agent-cli-updates.ts:453、:457-458、:486-497。更新前 ready，装完因网络抖动/登录过期不 ready → 回退后旧版也不 ready → 新版仍永久跳过（复跑 badVersions=["1.1.0"]，之后 skipped-bad-version）。修：回退后旧版也不 ready 即判环境问题，把目标版从 badVersions 撤掉。
3 锁存活判定受时区影响：cli-update-owner.ts:20-37、:17、:81；ps -o lstart 按调用进程时区输出（实测 UTC/上海/纽约三个不同值），Hub 缓存自身启动时间 → Hub 与 Host 时区环境不同或系统时区中途改 → Host 把活着的 Hub 锁当 pid 复用删除、更新期间放行会话（真实探针复现）。修：ps 调用加 TZ=UTC（并已有 LC_ALL=C 的话保持），或改用 etimes 已运行秒数换算比较。
4 POSIX 杀进程树不完整：harness-discovery/src/installation.ts:65-94 按父进程号找子进程，脱离父子关系的孙进程漏掉（(sleep 103 &) 挂到 1 号进程存活，占输出管道 6.2s 后 COMMAND_TREE_STOP_FAILED——本身安全，保留日志不并发回退）；ps 失败时一个都不杀，npm 继续跑。修：POSIX 下 detached 启动成独立进程组，按进程组整体 kill(-pgid)；ps 失败至少杀直接子进程。不得误杀无关进程（现状确认不误杀，保持）。

## 次要
- agent-cli-updates.ts:272-276：另一个 Hub 正在检查时本 Hub 的“立即检查”被丢弃；:270 与 :285-290 之间窄窗口新请求要等下次触发。
- cli-update-admission.ts:33、cli-update-owner.ts:20：Host 每次开会话/发起 turn 同步调用 ps（Windows powershell 最长 3s），更新期间阻塞 Host——改为异步或缓存。
- 连接检查 codexhost/harness/inspect 不在围栏内，安装中途界面触发检查可能拉起 CLI，Windows 锁文件——围栏期间 inspect 返回忙。
- agent-cli-update-system.ts:28-29：Windows W_OK 不看 ACL；Windows EPERM（文件被占用）被显示成“原安装位置不能写”——区分占用与权限。
- installation.ts:56-63：Windows 进程恰好已退出时 taskkill 报错被误报 COMMAND_TREE_STOP_FAILED。
- 恢复路径当前是目标版且未判坏时，不先验证新版就退回旧版（即使开关关）——可优化为先做连接检查，ready 则保留新版。
- 旧日志（无 quarantine 字段）走回退成功分支不撤销无证据的拉黑。
- 去掉 ALL_PROXY 清空：Hub 选“直连”时会继承环境代理（有意取舍，写进契约）。

## 界面措辞（Claude 改）
安装超时显示“这次检查超时”；回退后连接检查超时（CHECK_TIMEOUT）没走“旧版本已恢复”文案；恢复待执行时显示“有新版，等它空闲后更新”（agent-cli-updates.js:112）；更新前读版本对不上也显示“装完的版本对不上”。后台若新增码/字段写进契约 v3。
