import { describe, expect, it } from "vitest";

import { hermesPythonInvocation, parseHermesRuntimeCommand } from "../src/hermes-inventory.js";

describe("Hermes runtime command (PM-managed installs)", () => {
  it("keeps the launcher's bootstrap and runs our code through it", () => {
    const bootstrap =
      "import os, sys, runpy; sys.path.insert(0, 'C:\\h\\hermes-agent'); import hermes_bootstrap; " +
      "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)";
    const launch = parseHermesRuntimeCommand(
      `noise\n${JSON.stringify(["C:\py\python.exe", "-I", "-c", bootstrap])}\n`,
    );
    expect(launch).toEqual({
      python: "C:\py\python.exe",
      prelude:
        "import os, sys, runpy; sys.path.insert(0, 'C:\\h\\hermes-agent'); import hermes_bootstrap; ",
    });
    expect(parseHermesRuntimeCommand("[]")).toBeNull();
    expect(parseHermesRuntimeCommand("not json")).toBeNull();
    // Interpreters without a registered prelude (venv installs) run the code directly.
    expect(hermesPythonInvocation("C:\venv\python.exe", "print(1)")).toEqual({
      args: ["-I", "-c", "print(1)"],
      environment: {},
    });
  });
});

describe("Hermes through an RLY/0 relay", () => {
  it("lists the relay's models as Hermes custom-endpoint choices", async () => {
    const { relayInventory } = await import("../src/hermes-inventory.js");
    const inventory = relayInventory({
      RLY0_HERMES_MODELS: JSON.stringify(["gpt-5.4", "claude-sonnet-4-5", "bad model!"]),
      RLY0_HERMES_RELAY_NAME: "帅api",
      HERMES_MODEL: "claude-sonnet-4-5",
    });
    expect(inventory?.models.map((m) => [m.modelId, m.label])).toEqual([
      ["custom:gpt-5.4", "帅api / gpt-5.4"],
      ["custom:claude-sonnet-4-5", "帅api / claude-sonnet-4-5"],
    ]);
    expect(inventory?.currentModelId).toBe("custom:claude-sonnet-4-5");
    expect(relayInventory({})).toBeNull();
  });
});
