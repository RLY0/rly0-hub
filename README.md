<div align="center">

# RLY/0 Hub

**在 CodexHost 的多 Harness 宿主能力之上，加上多账号管理等增强功能**

</div>

## 项目简介

**RLY/0 Hub** 是从 [CodexHost](https://github.com/BytePioneer-AI/codex-host) v0.10.2
分支出来的衍生软件。CodexHost 让你在 **Codex Desktop** 内原生运行 Pi、Claude Code 等其他 Agent Harness；
RLY/0 Hub 在此基础上，加入了多账号管理、线程管理、中转注入、MCP / Skills 管理、维护工具等增强功能。

RLY/0 Hub 本身**不打包、不分发 Codex Desktop 或 Claude Code 等任何第三方 Harness**，这些软件需要你自行从官方渠道安装。
RLY/0 Hub 只是在你已安装的 Codex Desktop 中，以扩展的形式接入这些 Harness 并提供额外的管理界面。

## 功能列表

以下功能均对应设置页中已经实现的页面，未实现或仅部分实现的部分会明确标注：

- **仪表盘**：账号、会话、MCP 服务、Skills 的统计概览；当前账户与额度、数据目录健康状态、活跃趋势等信息。
- **账号管理**：
  - 只读展示当前登录的 Codex 账号与额度（继承自 CodexHost）。
  - 多账号保存、切换、改名、删除 —— **需要 RLY/0 Core（rly0-core）**，未安装 RLY/0 Core 时该区域会显示提示，不影响其余功能。
- **线程管理**：按项目查看主线程 / 子线程，统计线程数、大小、活跃天数，支持批量勾选与单条导出。
- **中转注入**：添加 / 编辑 / 测试第三方模型中转（API 中转站），按模型名路由到对应中转；启动仅监听 `127.0.0.1` 的本地代理，
  一键写入 Codex 配置（`[model_providers.rly0]`）并可随时恢复官方配置。中转密钥加密保存、界面只显示掩码。
  路由与本地代理逻辑位于 **RLY/0 Core（rly0-core）**；未安装 RLY/0 Core 时显示“需要 RLY/0 Core”，不会影响其他功能正常使用。
- **MCP 管理**：查看、添加、启用/停用 `~/.codex/config.toml` 中配置的 MCP 服务（STDIO / HTTP）。
- **Skills 管理**：查看已安装 / 已备份的 Skills，支持导入。
- **维护工具**：系统诊断、导出脱敏调试日志包（仅保存到本地）、清理数据、强制关闭 / 重启 Codex（均需二次确认）。
- **外观设置**：主题（浅色 / 深色 / 跟随系统）、界面语言、主题色、开机自启等。
- **赞助**：应用内“关于”页提供自愿赞助入口，详见下文“赞助”一节。

## 开源与闭源

- 本公开仓库整体按 **GNU Lesser General Public License v3.0（LGPL-3.0）** 开源，这是继承自上游 CodexHost 的许可协议；
  仓库保留了 CodexHost 原始的 [`LICENSE`](./LICENSE) 文件与全部版权声明，未做任何改动（详见 [`NOTICE.md`](./NOTICE.md)）。
- **多账号切换、额度读取、中转路由与本地代理**这几项增强功能，其核心逻辑位于闭源组件
  **rly0-core**。rly0-core 是一个**独立进程**，与 RLY/0 Hub（本仓库代码）通过 **stdio 上的 JSON-RPC** 通信，
  不包含、不链接、不嵌入任何 CodexHost 代码，二者是两个独立可执行程序之间的进程间通信关系。
- **在没有安装 rly0-core 的情况下，本公开仓库仍然可以正常编译、运行**：上述几项功能会在界面上显示“需要 RLY/0 Core”，
  其余全部功能（仪表盘、线程管理、MCP / Skills 管理、维护工具、外观设置等）不受影响。
- 关于 LGPL 合规的更多说明，见 [`docs/CLOSED_SOURCE.md`](docs/CLOSED_SOURCE.md)。

## 隐私与安全

- 账号快照与中转站密钥等敏感信息，使用 **Windows DPAPI** 加密后保存在本机磁盘，不会以明文形式落盘。
- 中转注入功能使用的本地代理**只监听 `127.0.0.1`**，不对外网开放端口。
- RLY/0 Hub 及其闭源组件**不收集、不上传任何用户数据**到作者或第三方服务器。
- “维护工具”页生成的诊断包**只保存在本机**，并对其中的敏感信息做脱敏处理；不存在“发送诊断到作者”这类上传功能。
- 详见 [`docs/PRIVACY.md`](docs/PRIVACY.md)。

## 广告披露

软件内“中转注入”页面提供的 **RLY/0 · 零号中转**（<https://rly0.com>）推荐位，是作者本人自营的服务，
在界面上会明确标注为“作者自营”，并且**可以关闭**。该推荐位：

- 不会改变任何请求的路由方式；
- 不会锁定或强制使用该中转站；
- 不会收集你添加的任何中转站密钥。

## 赞助

RLY/0 Hub 的“关于”设置页提供了**自愿性质**的赞助入口，支持与否完全不影响软件的任何功能。
本 README 不放置收款码图片，具体入口以软件内“关于”页为准。

## 致谢与声明

- 感谢 [CodexHost](https://github.com/BytePioneer-AI/codex-host) 原项目及其作者与贡献者：RLY/0 Hub 是在 CodexHost v0.10.2
  基础上修改的衍生作品，原始版权与许可条款详见本仓库的 [`LICENSE`](./LICENSE) 与 [`NOTICE.md`](./NOTICE.md)。
- 部分功能页面（如账号管理、中转注入等）在**界面设计思路**上参考了 AiMaMi 的交互方式，**不包含其任何代码**。
- RLY/0 Hub 与 OpenAI、Anthropic 均无隶属或合作关系；Codex、Claude 等名称为其各自权利人的商标，仅用于说明兼容性。

## 构建

环境要求：官方 Codex Desktop、Node.js 22.19+ 或 24、Rust。

```bash
git clone https://github.com/a1039861261-stack/rly0-hub
cd rly0-hub
npm ci
npm start
```

如需完整构建产物（TypeScript + Renderer 扩展 + Rust 组件）：

```bash
npm run build
```

也可以分步构建：

```bash
npm run build:typescript   # tsc -b + 插件打包
npm run build:renderer     # 构建 @codexhost/renderer-extension
npm run build:rust         # 构建 launcher / platform / shim / updater 等 Rust crate
```

运行测试：

```bash
npm test                   # TypeScript + Rust 测试
npm run typecheck          # 类型检查
npm run lint               # ESLint + 包边界检查
```

更多贡献流程见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

---

[English README](README.en.md)
