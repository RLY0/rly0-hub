# NOTICE

零号枢纽 · RLY/0 Hub（仓库：<https://github.com/a1039861261-stack/rly0-hub>）是基于
**CodexHost**（<https://github.com/BytePioneer-AI/codex-host>，v0.10.2）修改的衍生作品。

- CodexHost 以 **GNU Lesser General Public License v3.0（LGPL-3.0）** 发布。
- 本仓库保留原项目的 [`LICENSE`](./LICENSE) 文件与全部版权声明，未作改动；本项目的修改部分同样以 LGPL-3.0 发布。
- CodexHost 的原始版权归其原作者与贡献者所有。

## 相对上游的修改

1. **用户可见品牌**：设置界面、关于页、Star 提示、Windows 对话框标题等处的 “CodexHost” 改为
   “零号枢纽”（中文界面）/ “RLY/0 Hub”（英文界面）。
2. **仓库与更新源**：发布页、Issue 链接、GitHub Release 更新检查 / 下载地址、npm 包元数据中的仓库地址
   全部改为 `a1039861261-stack/rly0-hub`，更新器不会再从上游仓库下载安装包。
3. **Windows 安装器**：应用名与发布者改为 “RLY0 Hub”，默认安装目录改为
   `{localappdata}\Programs\rly0-hub`，并使用新的 AppId，可与 CodexHost 并存安装。
4. **用户数据目录**：默认数据目录由 `~/.codexhost` 改为 `~/.rly0-hub`（本机与远端 SSH 主机均适用），
   平台应用数据目录（`%LOCALAPPDATA%`、`~/Library/Application Support`、XDG state）中的 `codexhost`
   改为 `rly0-hub`；`CODEXHOST_DATA_DIR` 环境变量覆盖机制保持不变。

为便于合并上游更新，以下内部标识暂未改名：`codexhost/` RPC 方法前缀、`@codexhost/*` 包名、
`CODEXHOST_*` 环境变量、`data-codexhost-*` DOM 属性、Rust crate 名与可执行文件名。
