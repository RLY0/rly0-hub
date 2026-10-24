import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import {
  parseHubDevArguments,
  prepareMacHubKit,
  runHubDevBuild,
} from "../../scripts/release/macos/hub-dev-kit.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const bridge = await readFile(path.join(root, "apps/hub-desktop/macos/bridge.js"), "utf8");

function createBridge() {
  const requests = [];
  const window = {
    webkit: { messageHandlers: { rly0Hub: { postMessage: (message) => requests.push(message) } } },
  };
  vm.runInNewContext(bridge, { window });
  return { window, requests, webview: window.chrome.webview };
}

describe("macOS Hub page bridge (synthetic)", () => {
  it("uses the native handler for real requests and preserves Chinese parameters", () => {
    const { requests, webview } = createBridge();
    const message = { id: "w1", method: "accounts.rename", params: { alias: "家里电脑" } };
    webview.postMessage(message);
    expect(requests).toEqual([message]);
  });

  it("delivers readiness, responses and stable errors without changing their shape", () => {
    const { window, webview } = createBridge();
    const messages = [];
    webview.addEventListener("message", (event) => messages.push(event.data));
    const values = [
      { event: "ready" },
      { id: "w1", result: { name: "阿零" } },
      { id: "w2", error: { code: -32000, message: "SERVICE_UNAVAILABLE" } },
    ];
    for (const value of values) window.__rly0HubReceive(value);
    expect(messages).toEqual(values);
  });

  it("supports listener removal and ignores unrelated event types", () => {
    const { window, webview } = createBridge();
    let count = 0;
    const listener = () => {
      count += 1;
    };
    webview.addEventListener("message", listener);
    webview.addEventListener("message", listener);
    webview.addEventListener("other", () => {
      count += 100;
    });
    window.__rly0HubReceive({ event: "ready" });
    webview.removeEventListener("message", listener);
    window.__rly0HubReceive({ id: "w1", result: null });
    expect(count).toBe(1);
  });

  it("does not create a mock transport when the native handler is absent", () => {
    const window = {};
    expect(() => vm.runInNewContext(bridge, { window })).toThrow();
    expect(window.chrome).toBeUndefined();
  });

  it("protects the compatibility transport from accidental replacement", () => {
    const { window, webview } = createBridge();
    expect(Object.isFrozen(webview)).toBe(true);
    expect(Reflect.set(window, "chrome", {})).toBe(false);
    expect(Reflect.set(window, "__rly0HubReceive", () => {})).toBe(false);
  });
});

describe("macOS Hub development kit", () => {
  it("requires an explicit new output and accepts preparation without a Mac", () => {
    expect(parseHubDevArguments(["--prepare-only", "--output", "build/mac kit"])).toMatchObject({
      prepareOnly: true,
      outputDirectory: path.resolve("build/mac kit"),
    });
    for (const args of [
      [],
      ["--output"],
      ["--output", "--prepare-only"],
      ["--output", "x", "--output", "y"],
      ["--unknown"],
      ["--prepare-only", "--output", "x", "--node", "node"],
    ]) {
      expect(() => parseHubDevArguments(args)).toThrow();
    }
  });

  it("accepts an Intel source kit and rejects unknown architectures", async () => {
    expect(
      parseHubDevArguments(["--prepare-only", "--output", "build/intel", "--arch", "x64"]).arch,
    ).toBe("x64");
    expect(parseHubDevArguments(["--prepare-only", "--output", "build/m1"]).arch).toBe("arm64");
    for (const arch of ["x86", "universal", "", "../../invalid"]) {
      expect(() => parseHubDevArguments(["--output", "build/mac", "--arch", arch])).toThrow();
      await expect(prepareMacHubKit({ outputDirectory: "unused", arch })).rejects.toThrow("--arch");
    }
  });

  it("refuses a native build on Windows before creating an output directory", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "rly0-mac-host-"));
    const outputDirectory = path.join(parent, "uncreated");
    try {
      await expect(
        runHubDevBuild({ prepareOnly: false, outputDirectory }, "win32"),
      ).rejects.toThrow("requires a Mac");
      await expect(stat(outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects output inside the source UI before creating it", async () => {
    const outputDirectory = path.join(root, "apps/hub-desktop/www/mac-output");
    await expect(prepareMacHubKit({ outputDirectory })).rejects.toThrow("outside apps/hub-desktop");
    await expect(stat(outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["arm64", "x64"])(
    "prepares the actual %s service/UI snapshot and never overwrites",
    async (arch) => {
      const parent = await mkdtemp(path.join(os.tmpdir(), "rly0-mac-kit-"));
      const outputDirectory = path.join(parent, "kit with spaces");
      try {
        const manifest = await prepareMacHubKit({ outputDirectory, arch });
        expect(manifest.target).toBe(`macos-${arch}`);
        expect(manifest.validation).toEqual({
          nativeBuild: "not_run",
          launch: "not_run",
          realAccount: "not_run",
        });
        expect(manifest.included).toEqual({ nodeRuntime: false, core: false });
        expect(
          JSON.parse(await readFile(path.join(outputDirectory, "kit-manifest.json"), "utf8")),
        ).toEqual(manifest);
        const files = manifest.files.map((file) => file.path);
        expect(files).toEqual(
          expect.arrayContaining([
            "sources/Rly0Hub.swift",
            "sources/bridge.js",
            "sources/Info.plist",
            "build-on-mac.sh",
            "payload/app/hub-service.mjs",
            "payload/app/hub-ui/index.html",
            "payload/app/hub-ui/fonts/OFL-LICENSE.txt",
          ]),
        );
        for (const file of manifest.files) {
          const bytes = await readFile(path.join(outputDirectory, file.path));
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
          if (file.path.startsWith("payload/app/hub-ui/")) {
            expect(
              bytes.equals(
                await readFile(
                  path.join(
                    root,
                    "apps/hub-desktop/www",
                    file.path.slice("payload/app/hub-ui/".length),
                  ),
                ),
              ),
            ).toBe(true);
          }
        }
        const service = await readFile(
          path.join(outputDirectory, "payload/app/hub-service.mjs"),
          "utf8",
        );
        expect(service).toContain("serveRly0HubStdio");
        expect(service).not.toContain(root);
        await expect(prepareMacHubKit({ outputDirectory })).rejects.toMatchObject({
          code: "EEXIST",
        });
        expect(await readFile(path.join(outputDirectory, "kit-manifest.json"), "utf8")).toBe(
          `${JSON.stringify(manifest, null, 2)}\n`,
        );
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );
});
