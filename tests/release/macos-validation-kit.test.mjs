import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseValidationArguments,
  prepareValidationKit,
} from "../../scripts/release/macos/validation-kit.mjs";
import { verifyValidationKit } from "../../apps/hub-desktop/macos/validation/verify-kit.mjs";

describe("Mac validation handoff kit", () => {
  it("requires explicit private source and output, with strict architecture selection", () => {
    expect(parseValidationArguments(["--core-source", "private/core", "--output", "out"])).toEqual({
      coreRoot: "private/core",
      outputDirectory: "out",
      arch: "arm64",
    });
    for (const args of [
      [],
      ["--core-source", "core"],
      ["--output", "out"],
      ["--core-source", "core", "--output", "out", "--arch", "universal"],
      ["--core-source", "core", "--output", "out", "--output", "again"],
      ["--unknown", "x"],
    ]) {
      expect(() => parseValidationArguments(args)).toThrow();
    }
  });

  it("rejects source-contained or source-containing output without reading or writing files", async () => {
    const root = path.resolve("synthetic-hub");
    const coreRoot = path.resolve("synthetic-core");
    for (const outputDirectory of [
      coreRoot,
      path.join(coreRoot, "out"),
      path.join(root, "apps/out"),
      path.dirname(coreRoot),
    ]) {
      await expect(
        prepareValidationKit({
          root,
          coreRoot,
          outputDirectory,
          readRevision: () => {
            throw new Error("must not read");
          },
        }),
      ).rejects.toThrow("KIT_OUTPUT_REJECTED");
    }
  });

  it.each(["arm64", "x64"])(
    "builds a %s kit with source-only Core and tamper detection",
    async (arch) => {
      const parent = await mkdtemp(path.join(os.tmpdir(), "rly0-validation-synthetic-"));
      const coreRoot = path.join(parent, "synthetic-core");
      const outputDirectory = path.join(parent, "kit");
      try {
        for (const [relative, value] of Object.entries({
          "Cargo.toml": "[package]\nname = 'synthetic-core'\nversion = '0.0.0'\n",
          "Cargo.lock": "# synthetic lock\n",
          "src/main.rs": "fn main() {}\n",
          "src/nested/helper.rs": "pub fn synthetic() {}\n",
          "scripts/validate-macos.sh": "#!/usr/bin/env bash\nexit 0\n",
          "docs/macos-secure-store.md": "Synthetic fixture only.\n",
          ".env": "SYNTHETIC_MUST_NOT_COPY=1\n",
          "target/ignored.exe": "synthetic binary must not copy",
        })) {
          const file = path.join(coreRoot, relative);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, value);
        }
        const manifest = await prepareValidationKit({
          coreRoot,
          outputDirectory,
          arch,
          readRevision: async () => ({ commit: "a".repeat(40), hasLocalChanges: true }),
        });
        expect(manifest.included).toEqual({
          coreSource: true,
          coreBinary: false,
          nodeRuntime: false,
          cargoDependencies: false,
        });
        expect(manifest.validation.nativeBuild).toBe("not_run");
        expect(
          manifest.files.some((file) => file.path.includes(".env") || file.path.endsWith(".exe")),
        ).toBe(false);
        expect(manifest.files.map((file) => file.path)).toContain("core/src/nested/helper.rs");
        expect(await verifyValidationKit(outputDirectory)).toEqual({
          target: `macos-${arch}`,
          filesVerified: manifest.files.length,
        });
        const snapshot = JSON.parse(
          await readFile(path.join(outputDirectory, "core/source-snapshot.json"), "utf8"),
        );
        expect(snapshot.hasLocalChanges).toBe(true);
        expect(snapshot.files.map((file) => file.path)).toContain("src/main.rs");
        await expect(
          prepareValidationKit({
            coreRoot,
            outputDirectory,
            arch,
            readRevision: async () => snapshot,
          }),
        ).rejects.toMatchObject({ code: "EEXIST" });
        const source = path.join(outputDirectory, "core/src/main.rs");
        await writeFile(source, "synthetic changed source");
        await expect(verifyValidationKit(outputDirectory)).rejects.toThrow("KIT_HASH_MISMATCH");
        const savedManifest = await readFile(
          path.join(outputDirectory, "validation-manifest.json"),
          "utf8",
        );
        for (const bad of [
          "../outside",
          "/outside",
          "C:/outside",
          "core/../outside",
          "core\\main.rs",
        ]) {
          const edited = JSON.parse(savedManifest);
          edited.files[0].path = bad;
          await writeFile(
            path.join(outputDirectory, "validation-manifest.json"),
            JSON.stringify(edited),
          );
          await expect(verifyValidationKit(outputDirectory)).rejects.toThrow("KIT_PATH_REJECTED");
        }
        const edited = JSON.parse(savedManifest);
        edited.target = arch === "arm64" ? "macos-x64" : "macos-arm64";
        await writeFile(source, "fn main() {}\n");
        await writeFile(
          path.join(outputDirectory, "validation-manifest.json"),
          JSON.stringify(edited),
        );
        await expect(verifyValidationKit(outputDirectory)).rejects.toThrow("KIT_ARCH_MISMATCH");
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );
});
