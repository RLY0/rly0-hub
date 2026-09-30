import { describe, expect, it } from "vitest";

import {
  rly0AccountChinese,
  switchResultMessage,
} from "../../src/settings/rly0-account-messages.js";

describe("switchResultMessage", () => {
  it("tells the user the switch is live when the backend reloaded", () => {
    expect(switchResultMessage(rly0AccountChinese, { backendReload: "reloaded" })).toContain(
      "已无缝生效",
    );
  });

  it("explains the deferred reload while a reply is running", () => {
    expect(switchResultMessage(rly0AccountChinese, { backendReload: "deferred" })).toContain(
      "当前回复结束后自动生效",
    );
  });

  it("falls back to asking for a restart when the reload failed or is unknown", () => {
    expect(switchResultMessage(rly0AccountChinese, { backendReload: "failed" })).toBe(
      rly0AccountChinese.switchRequiresRestart,
    );
    expect(switchResultMessage(rly0AccountChinese, {})).toBe(
      rly0AccountChinese.switchRequiresRestart,
    );
  });
});
