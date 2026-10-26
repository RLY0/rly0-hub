# NOTICE

RLY/0 Hub（仓库：<https://github.com/RLY0/rly0-hub>）是基于
**CodexHost**（<https://github.com/BytePioneer-AI/codex-host>，自 v0.10.2 分支，已合并上游至 v0.14.0）修改的衍生作品。

- CodexHost 以 **GNU Lesser General Public License v3.0（LGPL-3.0）** 发布。
- 本仓库保留原项目的 [`LICENSE`](./LICENSE) 文件与全部版权声明，未作改动；本项目的修改部分同样以 LGPL-3.0 发布。
- CodexHost 的原始版权归其原作者与贡献者所有。

## 相对上游的修改

1. **用户可见品牌**：设置界面、关于页、Star 提示、Windows 对话框标题等处的 “CodexHost” 改为
   “RLY/0 Hub”（中英文界面统一），图标改为 RLY/0 品牌图形标，配色改为 RLY/0 品牌色。
2. **仓库与更新源**：发布页、Issue 链接、GitHub Release 更新检查 / 下载地址、npm 包元数据中的仓库地址
   全部改为 `RLY0/rly0-hub`，更新器不会再从上游仓库下载安装包。
3. **Windows 安装器**：应用名与发布者改为 “RLY0 Hub”，默认安装目录改为
   `{localappdata}\Programs\rly0-hub`，并使用新的 AppId，可与 CodexHost 并存安装。
4. **用户数据目录**：默认数据目录由 `~/.codexhost` 改为 `~/.rly0-hub`（本机与远端 SSH 主机均适用），
   平台应用数据目录（`%LOCALAPPDATA%`、`~/Library/Application Support`、XDG state）中的 `codexhost`
   改为 `rly0-hub`；`CODEXHOST_DATA_DIR` 环境变量覆盖机制保持不变。

为便于合并上游更新，以下内部标识暂未改名：`codexhost/` RPC 方法前缀、`@codexhost/*` 包名、
`CODEXHOST_*` 环境变量、`data-codexhost-*` DOM 属性、Rust crate 名与可执行文件名。

## 第三方组件

npm 安装包与各平台发布产物中打包的第三方依赖（例如 `smol-toml`，BSD-3-Clause）附带各自的许可证文本，
由发布脚本（`scripts/release/prepare-npm.mjs`、`scripts/release/prepare-payload.mjs`）在打包时生成，
随发行产物一并分发。闭源组件 rly0-core 不在本仓库范围内，其许可与依赖说明由该组件自行提供，
详见 [`docs/CLOSED_SOURCE.md`](docs/CLOSED_SOURCE.md)。

Hub 窗口「账号」页的服务商标识（`apps/hub-desktop/www/pages/provider-marks.js`）仅用于指明对应服务商（指示性使用），
商标归各自所有者：OpenAI、Anthropic、Google Gemini 图形取自 [Simple Icons](https://simpleicons.org) 13.21.0（CC0-1.0）；
xAI 图形取自 [LobeHub Icons](https://github.com/lobehub/lobe-icons)（`@lobehub/icons-static-svg` 1.70.0，MIT License，
Copyright (c) 2023 LobeHub）。

### 改编自 Apache-2.0 项目的代码

以下代码改编自以 [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) 发布的项目，已按其条款保留
出处并标明修改；原项目未参与本仓库，也不对改编后的代码负责。

- **amtiYo/agents**（Agents CLI，Copyright 2026 amtiYo，<https://github.com/amtiYo/agents>，v0.9.2，
  提交 `9d2f3e9235abf3820d5c831db7935f884e60e194`）：`packages/host-runtime/src/rly0-bridge/renderers.ts` 中
  各助手 MCP 配置的渲染函数（Codex/Grok TOML、Gemini、Antigravity、OpenCode、Cursor 等）改编自其
  `src/core/renderers.ts`。修改：去掉生成文件的写入与同步流程，只生成内存中的配置；增加 Pi、Hermes、Kiro
  的格式；密钥不写入全局文件。原 NOTICE：“Agents CLI / Copyright 2026 amtiYo / This product includes
  software developed by amtiYo.”
- **rohitg00/agentmemory**（v0.9.30，提交 `8bf0c827aaaada297896b2b6efe2a64651ae9389`）：
  `packages/host-runtime/src/rly0-memory/redaction.ts` 的令牌格式、私钥块与 URL 凭据正则改编自其
  `src/functions/privacy.ts`。修改：增加凭据赋值与连接字符串密码的处理、中文替换标记。未打包该项目的其他部分。
