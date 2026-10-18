<div align="center">

# RLY/0 Hub

**一个窗口管好 Codex 和各家 AI 编程助手：多账号、中转站、Claude Code / Pi / Hermes / OpenCode 一键接入**

[下载安装包](https://github.com/RLY0/rly0-hub/releases/latest) · [English](README.en.md)

<sub>安装包暂未做代码签名，首次运行时 Windows 可能提示“已保护你的电脑 / 未知发布者”，点 **更多信息 → 仍要运行** 即可。每个版本的 SHA-256 写在 Release 说明里，可用来核对文件。</sub>

<img src="docs/imgs/hub/home.png" alt="RLY/0 Hub 首页" width="100%">

</div>

## 项目简介

**RLY/0 Hub** 是从 [CodexHost](https://github.com/BytePioneer-AI/codex-host) v0.10.2
分支出来的衍生软件。CodexHost 让你在 **Codex Desktop** 内原生运行 Pi、Claude Code 等其他 Agent Harness；
RLY/0 Hub 在此基础上加了一个独立的管理窗口（托盘常驻），把多账号、中转站、AI 助手的安装与切换都放进来，
切换账号或中转站时不用重启 Codex。

RLY/0 Hub 本身**不打包、不分发 Codex Desktop 或 Claude Code 等任何第三方 Harness**，这些软件需要你自行从官方渠道安装
（Hub 里的"一键安装"也只是在你确认后调用官方安装命令）。

## 界面一览

### Codex 多账号

5 小时 / 每周额度、官方重置卡，一键切换

<img src="docs/imgs/hub/accounts.png" alt="Codex 多账号" width="100%">

### Claude 多账号

订阅额度、官方 API Key / 订阅令牌

<img src="docs/imgs/hub/accounts-claude.png" alt="Claude 多账号" width="100%">

### AI 助手

每个助手选用哪个账号 / Key / 中转站

<img src="docs/imgs/hub/agents.png" alt="AI 助手" width="100%">

### 第三方助手

Pi、Hermes、OpenCode 滑动解锁一键安装

<img src="docs/imgs/hub/agents-community.png" alt="第三方助手" width="100%">

### 中转站

填地址和 Key，自动识别名称、图标和模型

<img src="docs/imgs/hub/relays.png" alt="中转站" width="100%">

### 自动更新

后台检查，有新版本时弹窗提示

<img src="docs/imgs/hub/update-popup.png" alt="自动更新" width="100%">

> 截图里的账号、余额均为演示数据。

## 功能列表

- **首页**：当前账号额度、官方重置卡、已装的 AI 助手和中转站余额一屏看完。
- **账号**（OpenAI · Codex / Anthropic · Claude / Google · Gemini / xAI · Grok 四个标签）：
  - 每家都能用三种方式添加：网页登录、导入登录文件（含 Sub2API 导出）、官方 API Key。
  - Codex 与 Claude 支持保存多个账号一键切换，显示 5 小时 / 每周额度和重置时间；Codex 账号切换无需重启。
  - 额度快用完时可自动切到额度最多的账号（先提醒或直接切换）。
- **中转站**：添加中转时自动测试、识别名称和图标、勾选要用的 GPT 模型；本地代理只监听 `127.0.0.1`，
  按模型名路由，可一键恢复官方配置。支持"不登录 OpenAI 也能用"模式。
- **AI 助手**：Claude Code、Antigravity、Grok、OpenCode、Pi、Hermes、Cursor、Kiro 等；
  一键安装（在可见的终端窗口中运行官方命令）、检测连接、为每个助手选择账号 / 官方 Key / 中转站，切换即时生效。
- **设置**：MCP 服务、Skills、AGENTS.md 指令模板、线程管理、维护工具（诊断、脱敏日志包、重启 Codex）、
  外观与开机自启、更新。
- **托盘**：常驻托盘，右键菜单可快速切换账号、打开 Codex、开机自启。
- **自动更新**：后台定期检查 GitHub Release，有新版本时弹窗并在侧边栏"设置"上显示红点。

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
在界面上始终明确标注为“作者自营”，点击只会打开 rly0.com。该推荐位：

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
git clone https://github.com/RLY0/rly0-hub
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
