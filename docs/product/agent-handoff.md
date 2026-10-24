# 换个助手接着聊（Handoff）

## 行为

对话一旦开始，它的 Agent 就固定了：每个 Harness 拥有自己的 Native Session，Session 不能在 Harness 之间迁移，Host 也不能把一个 Thread 的后续 Turn 交给另一个 Harness（见 openspec `versioned-renderer-agent-routing` 与 `cross-harness-delegation`：每个 Thread 只归属一个 Harness）。所以「同一个 Thread 内原地切换 Agent」不支持，改为 Handoff：

- 已开始的对话里，Composer 的 Agent 按钮保持可用，悬停提示「换个助手接着聊：会新开一个对话并带上之前的内容」，菜单顶部说明会带过去什么。当前 Agent、未安装或出错的 Agent 不可选。键盘可用（↓/↑ 打开并移动，Enter 选择，Esc 关闭）。
- 选另一个 Agent 时，Renderer 调 `codexhost/thread/handoff`。Host 读出源对话已投影的 Turn，在同一工作目录、目标 Harness 上新建一个普通可写 Thread，标题为 `↪ 原标题 · 接力 <Agent>`，第一条消息就是带过去的内容，然后打开它。原对话不变。
- 新 Thread 与原对话通过 Delegation 关系关联（`requestId` 以 `handoff:` 开头，父 Thread 为原对话），不复制会话身份。
- 在接力出来的对话里再选回原来的 Agent：不新建第三个对话，而是把接力对话里新增的内容（不含第一条接力消息本身；只有对它的确认回复时不发）作为一条消息发回原对话并打开原对话。原对话正在回复时会报错，不会打断它。
- 目标 Agent 使用此人为该 Agent 记住的模型 / 思考 / 权限（与新建对话相同的偏好）；没有偏好或偏好已失效时用该 Agent 自己的默认值。Handoff 不使用委派的无人值守全权限；Codex 目标使用 Codex 自己的审批与沙箱配置。
- 目标是外部 Agent 时不消耗官方 Codex 额度；读取 Codex 源对话只读本地 `thread/read`。

## 带过去的内容

由 `packages/host-runtime/src/thread-handoff.ts` 生成，只用 Host 已投影的 Codex 协议条目：

- 用户与助手的可见消息（单条超过 4000 字时保留首尾，第一轮 3000 字）；
- 运行过的命令、退出码和输出末尾 600 字；
- 改动的文件路径（新增 / 修改 / 删除）；
- MCP / 动态工具的名称与状态、网页搜索词。

不带：推理内容、隐藏提示、工具原始参数、图片内容。总长度默认 24000 字：保留第一轮（通常是任务说明），再从最新一轮往前填，被省略的轮次在消息中注明数量。常见凭据格式（`sk-…`、GitHub/GitLab/Slack/Google/AWS 令牌、JWT、Bearer/Basic 头）会被替换为 `[credential removed]`。进行中的回复不算进对话。第一条消息原样显示在新对话里，带了什么一目了然。

## 限制

- 目标 Agent 收到的是摘要上下文而不是原 Session：命令不会重放，工具状态、权限批准、子 Agent、Codex 的上下文压缩结果都不继承。
- 新对话的第一轮会向目标 Agent 发一次真实请求（请它确认进展后等待指示）。
- 旧版 Host 没有该方法时，按钮维持原来的锁定状态。
