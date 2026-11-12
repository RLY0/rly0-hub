import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "vitest";

it("keeps Windows Web autostart separate from upstream and the Hub desktop Run value", () => {
  const web = readFileSync(
    new URL("../../crates/platform/src/autostart_windows.rs", import.meta.url),
    "utf8",
  );
  const installer = readFileSync(
    new URL("../../scripts/release/windows/Installer.iss", import.meta.url),
    "utf8",
  );
  const name = /const NAME: PCWSTR = w!\("([^"]+)"\)/u.exec(web)?.[1];
  assert.equal(name, "RLY0HubWeb");
  assert.notEqual(name, "codexhost");
  assert.notEqual(name, /ValueName: "([^"]+)"/u.exec(installer)?.[1]);
  assert.match(installer, /Parameters: "autostart off"/u);
  const message = /^UninstalledAll=(.*)$/mu.exec(installer)?.[1];
  assert.match(message ?? "", /RLY\/0 Hub/u);
  assert.match(message ?? "", /已成功.*卸载/u);
  assert.doesNotMatch(message ?? "", /codexhost|Tailscale|was successfully removed/u);
});
