# Brand assets

Only Codex and codexhost artwork is bundled into the Renderer. External Harness
artwork belongs to `packages/adapters/<id>/assets/`, is declared in each plugin's
manifest, and reaches the Renderer as a validated data URL in the Host directory.
The Renderer uses an image element, never inline plugin SVG.

`codex-logo.png` is the Codex X mark source; `codex-logo-transparent.png` removes
its white background, and `codex-logo-bright.png` uses the official bright blue.
`codex-agent.png` is the Codex App GA mark distributed with OpenAI's official
`openai.chatgpt` VS Code extension.

`codexhost-app-icon.svg` is the vector master of the RLY/0 Hub brand icon: the
RLY/0 figure mark (from https://rly0.com) in paper white on an ink rounded tile,
with the signal square. It is the Renderer settings brand icon (settings header
mark). The navigation-rail glyph uses the same figure path in `currentColor`.
`crates/launcher/assets/codexhost.png` is a 1024px render of this SVG for macOS
application and DMG icons. Windows application and installer icons use the
multi-size `crates/launcher/assets/codexhost.ico` rendered from the SVG.

## External artwork provenance

- Pi: official `https://pi.dev/logo-auto.svg`. The original Renderer paths, viewBox
  and `currentColor` SVG rendering are preserved in the plugin Manifest; the original
  standalone image resource is unchanged. No light plate is added.
- Claude Code: Anthropic's official `anthropic.claude-code` VS Code extension.
- DeepSeek Harness: official web favicon / `FishLogo.tsx`, blue `#4D6BFE`.
- OMP: Oh My Pi `packages/collab-web/public/favicon.svg`.
- OpenCode: official square mark with dark outer plate.
- Grok: cropped first-party `grok.com` mark with transparent rounded corners.
- Kiro: official `https://kiro.dev/icon.svg`.
- CodeBuddy and WorkBuddy: captured first-party `10001.svg` assets; original
  backgrounds, marks, viewBoxes and clipping are preserved.
- Cursor: official `https://cursor.com/favicon.svg` Cube with its dark plate.
- Hermes: the original cropped/resized website favicon, unchanged; its existing light plate,
  padding and rounded corners are declared by the plugin rather than baked into the artwork.
- ZCode: upstream codex-host integration snapshot `b66013bb`.

Product names and marks remain trademarks of their respective owners.
