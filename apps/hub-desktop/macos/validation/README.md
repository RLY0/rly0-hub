# Mac 本地验证包

本包包含 Hub 当前页面和后台、Mac 原生窗口源文件、私有 Core 源码及定向验证入口。它是本机开发交接资料，不是正式安装包；含私有源码，不上传公共平台。源码哈希用于核对传输完整性，不是发行签名或独立安全审核证明。

开发者可在完整Hub仓库离线生成此包：`node scripts/release/macos/validation-kit.mjs --core-source <私有Core仓库路径> --output <全新输出目录> --arch arm64`。Intel选择 `--arch x64`。仅复制Core的Cargo清单/锁、Rust源文件、指定验证脚本与说明，不复制Git、账号配置、target或环境变量文件。Core工作树中的已有未提交改动会一并按文件快照记录，不能把快照当成纯提交版。

准备一台与包架构一致的 Mac：M 系列使用 arm64 包，Intel 使用 x64 包。需要已安装 Xcode Command Line Tools、原生 Rust 1.97.1（或兼容且支持 File::try_lock 的版本）、独立同架构 Node.js 22/24，以及 Cargo.lock 所需的本地缓存。没有缓存时会如实失败，不会自动联网下载或安装工具。Rust 官方版本和目标是否可取得须在准备设备时核实。

解压到自己有权限的普通目录，避免临时目录别名、软链接和公共可写路径。在验证包目录执行：

```bash
bash run-on-mac.sh /absolute/path/to/node
```

脚本先检查系统/架构、文件哈希、Swift和Rust工具链，再在单独输出目录编译 Core，运行合成数据文件保护与临时钥匙加密测试，最后编译 Hub 开发窗口。不会打开应用，不创建持久账号钥匙，不登录、切号、迁移数据、配置自启或安装更新；不会将 Core 编入 Hub 应用。测试仅使用合成数据和系统临时文件。

只有上述命令全部成功且源文件复核一致，才写 `results/summary.json`。其中编译通过仍不代表窗口可用；窗口运行、持久 Keychain、真实账号和独立审查始终单独标 `not_run`。失败时保留日志；使用重新解压的全新目录重试，不覆盖旧结果。

结果位置：`results/core-validation.log`、`results/core/`、`results/hub-build.log`、`results/source-verification.json`、`results/summary.json`。保留输出用于后续排查，只需回传经过检查的摘要与失败日志，不发送账号文件或凭据。原生应用输出在 `hub/RLY0 Hub.app`，未经窗口及安全验收前不要登录真实账号。

目前仅在 Windows 上验证打包、文件完整性检查和脚本语法；尚未在 Mac 执行。Intel 环境不能替代 M 系列验收，也不证明当前 Codex Desktop 支持 Intel。
