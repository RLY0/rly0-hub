# RLY/0 Hub note

This upstream change describes CodexHost removing Host-side multi-account support. RLY/0 Hub
re-adds saved accounts through the closed-source `rly0-core` bridge, so the following parts of
`specs/codex-multi-account-removal/spec.md` do not describe RLY/0 Hub:

- "Settings has no multi-account actions" and "No current Codex login": RLY/0 Hub's saved-account
  section offers save, switch, rename, remove and **add account**.
- "Add account" runs the official ChatGPT browser login (`account/login/start`, type `chatgpt`)
  in a private official app-server whose `CODEX_HOME` is a throw-away temporary directory. The
  user's live Codex login is never touched; on success `rly0-core` `accounts/importFrom` copies
  the new login into its own store and the temporary directory is deleted. Only one add-account
  login runs at a time. Tokens never pass through the renderer.
- Credentials are stored by `rly0-core`, not in `.codexhost-native-accounts`.

The removed `codexhost/account/*` Host methods stay removed; RLY/0 Hub uses its own
`codexhost/rly0/accounts/*` methods, which are only available when `rly0-core` is present.
