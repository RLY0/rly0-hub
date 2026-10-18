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
