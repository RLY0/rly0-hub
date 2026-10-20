# Grok 多账号（测试版）

Hub「账号 → xAI · Grok」保存多个 Grok CLI 账号，手动一键切换，并显示每个账号的额度。尚未用真实 Grok 账号验证，界面标「测试版」。

## 登录在哪

Grok CLI（xAI Grok Build，`@xai-official/grok`）的登录在 `$GROK_HOME/auth.json`，默认 `~/.grok/auth.json`。`GROK_HOME` 是官方设置（[Settings Reference](https://docs.x.ai/build/settings/reference)：config、auth、sessions… 的根目录）。官方 xAI 登录的条目键为 `https://auth.x.ai::<client>`，含 `key`（access token）、`refresh_token`、`expires_at`、`user_id`、`email`（与 `packages/adapters/grok/src/grok-credential-export.ts` 读取的一致）。

## 行为（rly0-core `grok/*`，Hub `agents.grokAccounts.*`）

- **保存**：每个账号是整个 `auth.json` 的 DPAPI 加密副本，按 `user_id` 区分（没有 `user_id` 的登录不能保存）。
- **切换**（只手动）：先把当前 `auth.json` 写回当前账号的副本（CLI 会续期、轮换 token）；当前登录未保存时写入 `backup-*.dpapi`；再原子替换 `auth.json`。新开的 Grok 对话生效。
- **网页登录**：在临时目录 `rly0-grok-login-*` 作为 `GROK_HOME` 运行官方 `grok login`（官方文档 [Enterprise](https://docs.x.ai/build/enterprise)：默认浏览器 OIDC 登录）。去掉 `XAI_API_KEY` / `GROK_API_KEY` / `GROK_TOKEN`，保留企业版的 `GROK_OIDC_*`。CLI 自己打开浏览器；若它打印了 x.ai / grok.com 的链接，对话框提供“重新打开登录页”。CLI 成功退出后由 `grok/importFrom` 保存其中的 xAI 登录，临时目录随即删除。
- **从文件导入**：Grok 的 `auth.json`（或其中单个登录条目）。文件里是 xAI API Key（如 Sub2API 导出）时保存为官方 Key。导入当前登录的同一账号时以当前登录为准。
- **额度**：`GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`（与 Adapter 的 `grok-credits.ts` 相同的请求头和解析规则），显示为一个每周 / 每月 / 额度窗口。
- **续期**：Hub 不续期 Grok token（仓库里没有确定的 token 端点）。已过期的 token 不会被发送；已保存账号显示“登录已过期，切换一次即可更新额度”——切换后由 Grok CLI 自己用 refresh token 续期。

## 真实用户需要确认

1. `grok login` 在 `GROK_HOME` 指向空目录时，登录结果写进该目录的 `auth.json`，且命令在浏览器回调后**自行退出、退出码 0**（Hub 以此判断完成）；是否需要按键 / 是否先自动更新。
2. `auth.json` 的条目里确有 `user_id` 和 `email`；`expires_at` 是 RFC 3339。
3. 切换后新开的 Grok 对话用的是新账号；切过去时 token 已过期的账号，Grok 能自动续期。
4. 账单接口对每个账号的 token 都返回 `config.creditUsagePercent`（或 `monthlyLimit`/`used`）。
