import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";
const root = path.resolve(import.meta.dirname, "../..");
const bundle = await build({
  stdin: {
    contents: `
    import { installRendererBindingProbe } from './packages/renderer-extension/src/renderer-binding-probe.ts';
    import { installRendererFeature } from './packages/renderer-extension/src/renderer-feature-gate.ts';
    globalThis.gateTest = { installRendererBindingProbe, installRendererFeature };
  `,
    resolveDir: root,
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  target: "es2024",
  loader: { ".png": "dataurl", ".jpg": "dataurl", ".svg": "dataurl", ".css": "text" },
  plugins: [tailwindEsbuildPlugin()],
});
test("synthetic DOM: remote disable skips optional installers while remaining binding survives", async ({
  page,
}) => {
  await page.route("https://version-gate.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }),
  );
  await page.goto("https://version-gate.test/");
  await page.addScriptTag({ content: bundle.outputFiles[0]?.text ?? "" });
  const result = await page.evaluate(() => {
    const state = globalThis as unknown as {
      __codexhostFeaturePolicyV1: { schemaVersion: number; mode: string; disabled: string[] };
      __codexhostFeatureFailuresV1: string[];
      gateTest: {
        installRendererFeature<T>(feature: string, install: () => T, fallback: () => T): T;
        installRendererBindingProbe(): { status(): { version: number }; dispose(): void };
      };
    };
    state.__codexhostFeaturePolicyV1 = {
      schemaVersion: 1,
      mode: "full",
      disabled: [
        "settings",
        "sidebar-icons",
        "questions",
        "delegation",
        "schedules",
        "reasoning-wrap",
      ],
    };
    let called = false;
    state.gateTest.installRendererFeature(
      "settings",
      () => {
        called = true;
        return true;
      },
      () => false,
    );
    const failed = state.gateTest.installRendererFeature(
      "usage",
      () => {
        throw new Error("synthetic");
      },
      () => "disabled",
    );
    const sibling = state.gateTest.installRendererFeature(
      "composer",
      () => "survived",
      () => "disabled",
    );
    const binding = state.gateTest.installRendererBindingProbe();
    const version = binding.status().version;
    binding.dispose();
    return { called, failed, sibling, version, failures: state.__codexhostFeatureFailuresV1 };
  });
  expect(result).toEqual({
    called: false,
    failed: "disabled",
    sibling: "survived",
    version: 2,
    failures: ["usage"],
  });
});
