// Synthetic ioreg output and injected commands only; never reads this machine's input state.
import { describe, expect, it } from "vitest";

import {
  CODEX_UPDATE_INPUT_IDLE_MS,
  codexIdleFromBusyAndInput,
  macInputIdleMs,
  parseHidIdleTime,
} from "../src/rly0-hub-service/codex-input-idle.js";

const ioreg = (ns: string) =>
  `+-o IOHIDSystem  <class IOHIDSystem, id 0x100000483>\n    {\n      "HIDIdleTime" = ${ns}\n      "HIDParameters" = {}\n    }\n`;

describe("Codex update idle rule: no task and five minutes without input", () => {
  it("reads HIDIdleTime nanoseconds as milliseconds", () => {
    expect(parseHidIdleTime(ioreg("301000000000"))).toBe(301_000);
    expect(parseHidIdleTime("no such key")).toBeNull();
    expect(parseHidIdleTime(ioreg("99999999999999999999999"))).toBeNull();
  });

  it("queries IOHIDSystem and treats a failing command as unreadable", async () => {
    const calls: string[][] = [];
    const ok = macInputIdleMs(async (file, args) => {
      calls.push([file, ...args]);
      return ioreg("400000000000");
    });
    expect(await ok()).toBe(400_000);
    expect(calls[0]).toEqual(["/usr/sbin/ioreg", "-c", "IOHIDSystem", "-d", "4"]);
    const broken = macInputIdleMs(async () => {
      throw new Error("ioreg missing");
    });
    expect(await broken()).toBeNull();
  });

  it("needs both: no task running and input idle for at least five minutes", async () => {
    const at = (busy: boolean | null, idle: number | null) =>
      codexIdleFromBusyAndInput(
        async () => busy,
        async () => idle,
      )();
    expect(await at(false, CODEX_UPDATE_INPUT_IDLE_MS)).toBe(true);
    expect(await at(false, CODEX_UPDATE_INPUT_IDLE_MS - 1)).toBe(false);
    expect(await at(true, CODEX_UPDATE_INPUT_IDLE_MS * 10)).toBe(false);
    // Missing heartbeat or unreadable input counts as in use.
    expect(await at(null, CODEX_UPDATE_INPUT_IDLE_MS * 10)).toBe(false);
    expect(await at(false, null)).toBe(false);
  });

  it("does not read input state while a task is running", async () => {
    let reads = 0;
    const idle = codexIdleFromBusyAndInput(
      async () => true,
      async () => {
        reads += 1;
        return CODEX_UPDATE_INPUT_IDLE_MS;
      },
    );
    expect(await idle()).toBe(false);
    expect(reads).toBe(0);
  });
});
