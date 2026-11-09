# 独立真机验收清单（not_run）

本轮只验证模拟驱动、隔离文件和 WebKit synthetic DOM。以下不是已执行结果，不授权在当前使用中的 Codex/Hub 操作。后续须由集成人员在**获授权的独立 macOS VM/独立登录环境**执行；不要在日常 Hub 旁启动第二个未沙箱隔离的 hub-service（其启动 inspect 有历史误启动风险）。不复制、替换或修改 Codex App 包，Codex 必须来自官方渠道。

1. 固定候选提交、Hub/Launcher 真实路径、Codex Desktop/build、系统版本和 arch。只读核对 Codex 自带 Sparkle 的 SUAllowsAutomaticUpdates、bundle id 和 appcast bootstrap；如果厂商禁止后台更新，不通过菜单、参数或改包绕过。
2. 分别以三个 VM 快照验证 SUAutomaticallyUpdate 原值 true、false、缺失，以及辅助自动检查开关/上次检查日期原值。启用/关闭管理、准备失败、Hub 重开之后均核对原值恢复；不要以临时 HOME 视为 cfprefsd 隔离。
3. 已适配 feed 放行后，先让 Codex 忙碌或移除心跳超过 30 分钟：不应开开关、不应重开、不应弹更新窗口。持续 fresh idle 15 秒后才允许准备后台检查、正常 quit、等待退出、重开当前 Codex。
4. 确认 watchdog 从构建输出真实路径启动，IPC ready 先于 preference=true。用 VM 内的候选 Hub 进程模拟异常终止：其独立 watchdog 应在后续轮询关回 false；用过期/损坏租约测试相同效果。确认默认写入权限、签名/隔离机制及随应用交付的 Node 可执行路径；本轮未跑真实独立进程。
5. 观察重开后至少一个后台检查周期：记录是否出现任何官方窗口、是否静默下载、Sparkle 实际 staging 目录以及 codesign 耗时。存在窗口、厂商重置偏好或 30 分钟无有效暂存时判失败，不能把请求成功当下载完成。记录失败后不会每 5 分钟重新重开，辅助偏好恢复。
6. 对最低系统版本/分批投放实际选出的较低版本，核对该版本来自当前 feed、已适配且签名有效，再检查安装/体检。未适配的任一较新候选应阻止放行；目标从 feed 消失应取消 quit。退出前后 feed 竞态仍无法锁定，不宣称完全解决上游投放变化。
7. 有效暂存后长时间忙碌：不计入下载超时、不重复点菜单/重开。再次连续空闲后，核对退出前重验签名和 fresh idle。记录 Sparkle 是否在正常 quit 时安装、是否自己重新启动 Codex；不能只根据版本字符串判断成功。
8. 模拟安装失败/安装超时/偏好恢复失败：Hub 关闭过且当前没有运行的 Codex 应恢复打开当前版本；本应用 updater 运行中应延后，其他 App updater 不应阻塞。quit 被用户取消或 Sparkle 已重开时不得在随后用户退出后意外重开。
9. 真实 installedVersion、appcast shortVersionString、暂存版本分别采样，验证数值尾零等价，不将 build identity 与 short version 混用。仍需核对产品实际格式，不把 synthetic 比较覆盖当作真实格式证明。
10. Dock/Launcher/npm start 路径核对当前父 Launcher 的 startup record 与 Controller 版本身份；已适配进入 full，未知进入 core。短暂读取失败不应 full/core 抖动；真实版本变化/远程停用仍应收缩功能。
11. Windows 单独验收：supported=false、无 defaults/osascript/全局商店设置变更；restart 仍有旧强制退出影响，未在本轮执行。Windows/安装包/发布验收归后续独立环境和 Claude。

若任一真实系统行为与契约不符，保留失败状态与证据，修复后再验收。当前没有“无弹窗升级通过”或“可发布”的结论。
