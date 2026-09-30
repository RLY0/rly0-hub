<div align="center">

# RLY/0 Hub (零号枢纽)

**CodexHost's multi-harness hosting, plus multi-account management and other enhancements**

</div>

## About

**RLY/0 Hub** is a derivative of [CodexHost](https://github.com/BytePioneer-AI/codex-host) v0.10.2, forked at that
version. CodexHost lets you run other Agent Harnesses (Pi, Claude Code, and more) natively inside **Codex Desktop**.
RLY/0 Hub builds on top of that with multi-account management, thread management, relay injection, MCP / Skills
management, maintenance tools, and other additions.

RLY/0 Hub **does not bundle or redistribute Codex Desktop, Claude Code, or any other third-party harness**. You
install those yourself from their official sources; RLY/0 Hub only extends the Codex Desktop app you already have
installed.

## Features

These correspond to the settings pages actually implemented today; anything not implemented or only partially
implemented is called out explicitly:

- **Dashboard**: account / session / MCP service / Skills counts, current-account usage, data-directory health,
  activity trends.
- **Account management**:
  - Read-only view of the currently signed-in Codex account and its quota (inherited from CodexHost).
  - Multi-account save / switch / rename / delete — **requires the closed-source RLY/0 Core (`rly0-core`)**. Without
    it, this section shows a notice; the rest of the app is unaffected.
- **Thread management**: browse main/sub threads per project, with counts, sizes, active-day stats, batch selection
  and per-thread export.
- **Relay injection**: UI for third-party model relays (API relay endpoints) — the routing, local proxy, and quota
  detection logic live in the closed-source **RLY/0 Core**; the public repository currently ships the UI and
  integration scaffold. Without RLY/0 Core it shows "requires RLY/0 core" and the rest of the app keeps working.
- **MCP management**: view, add, enable/disable MCP servers configured in `~/.codex/config.toml` (STDIO / HTTP).
- **Skills management**: view installed / backed-up Skills, and import new ones.
- **Maintenance tools**: system diagnostics, exporting a redacted debug log bundle (saved locally only), clearing
  data, force-quitting / restarting Codex (all behind a confirmation step).
- **Appearance**: theme (light/dark/system), UI language, accent color, launch-at-login, etc.
- **Sponsorship**: a voluntary sponsorship entry point in the in-app "About" page — see below.

## Open source and closed source

- The public repository as a whole is licensed under the **GNU Lesser General Public License v3.0 (LGPL-3.0)**,
  inherited from upstream CodexHost. The original CodexHost [`LICENSE`](./LICENSE) file and all copyright notices are
  kept unchanged (see [`NOTICE.md`](./NOTICE.md)).
- **Multi-account switching, quota reading, and relay routing / the local proxy** are implemented in a closed-source
  component, **RLY/0 Core (`rly0-core`)**. It runs as a **separate process** and communicates with this repository's
  code over **JSON-RPC on stdio**; it does not contain, link against, or embed any CodexHost code — the two are
  independent executables talking over an inter-process protocol.
- **This public repository builds and runs fine without RLY/0 Core installed**: the features above simply show
  "requires RLY/0 core" in the UI, while everything else (dashboard, thread management, MCP/Skills management,
  maintenance tools, appearance, etc.) keeps working normally.
- See [`docs/CLOSED_SOURCE.md`](docs/CLOSED_SOURCE.md) for more on the LGPL compliance rationale.

## Privacy and security

- Account snapshots and relay API keys are encrypted with **Windows DPAPI** before being written to disk on the local
  machine.
- The local proxy used by relay injection **only listens on `127.0.0.1`**; it never opens a port to the network.
- RLY/0 Hub and its closed-source component **do not collect or upload any user data** to the author or any third
  party.
- The "Maintenance" page's diagnostic bundle is **saved locally only** and has sensitive fields redacted; there is no
  "send diagnostics to the author" feature.
- See [`docs/PRIVACY.md`](docs/PRIVACY.md) for details.

## Advertising disclosure

The relay-injection page includes a recommended entry for **RLY/0 · Zero Relay** (<https://rly0.com>), operated by the
author personally, clearly labeled as such in the UI, and **can be turned off**. This entry:

- does not change how any request is routed;
- does not lock you into using that relay;
- does not collect any relay API key you add yourself.

## Sponsorship

RLY/0 Hub's in-app "About" page has a **voluntary** sponsorship entry point; using or ignoring it has no effect on any
feature. This README does not include a payment QR code — see the in-app "About" page for the actual entry point.

## Acknowledgements and disclaimers

- Thanks to the [CodexHost](https://github.com/BytePioneer-AI/codex-host) project and its author/contributors: RLY/0
  Hub is a derivative work based on CodexHost v0.10.2; the original copyright and license terms are kept in this
  repository's [`LICENSE`](./LICENSE) and [`NOTICE.md`](./NOTICE.md).
- Some UI/interaction ideas (e.g. account management, relay injection) were inspired by AiMaMi's interface design;
  no code from it is included.
- RLY/0 Hub is not affiliated with OpenAI or Anthropic. Codex, Claude, and similar names are trademarks of their
  respective owners, mentioned here only to describe compatibility.

## Build

Requirements: official Codex Desktop, Node.js 22.19+ or 24, and Rust.

```bash
git clone https://github.com/a1039861261-stack/rly0-hub
cd rly0-hub
npm ci
npm start
```

Full build (TypeScript + renderer extension + Rust components):

```bash
npm run build
```

Or step by step:

```bash
npm run build:typescript   # tsc -b + plugin bundling
npm run build:renderer     # build @codexhost/renderer-extension
npm run build:rust         # build launcher / platform / shim / updater Rust crates
```

Tests:

```bash
npm test                   # TypeScript + Rust tests
npm run typecheck
npm run lint
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the contribution workflow.

---

[简体中文 README](README.md)
