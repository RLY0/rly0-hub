// Bundles `app/hub-service.mjs`, the backend of the standalone RLY/0 Hub window.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build as esbuildBuild } from "esbuild";

const forbiddenInputFragments = [
  "/packages/adapters/",
  "/node_modules/@codexhost/adapter-",
  "/node_modules/@anthropic-ai/",
  "/test/",
  "/tests/",
  "/tools/",
];
const allowedRuntimePackages = new Set(["smol-toml", "zod"]);

function auditHubServiceMetafile(metafile) {
  const inputs = Object.keys(metafile.inputs ?? {}).map(
    (input) => `/${input.replaceAll("\\", "/").replace(/^\/+/u, "")}`,
  );
  const forbidden = inputs.filter((input) =>
    forbiddenInputFragments.some((fragment) => input.includes(fragment)),
  );
  if (forbidden.length > 0) {
    throw new Error(`Hub service bundle contains forbidden inputs: ${forbidden.join(", ")}`);
  }
  const packages = new Set();
  for (const input of inputs) {
    const index = input.lastIndexOf("/node_modules/");
    if (index < 0) continue;
    const segments = input.slice(index + "/node_modules/".length).split("/");
    const name = segments[0]?.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
    if (name && !name.startsWith("@codexhost/")) packages.add(name);
  }
  const unexpected = [...packages].filter((name) => !allowedRuntimePackages.has(name));
  if (unexpected.length > 0) {
    throw new Error(`Hub service bundle contains unreviewed packages: ${unexpected.join(", ")}`);
  }
}

export async function buildHubServiceBundle({ repositoryRoot, outputPath }) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const result = await esbuildBuild({
    absWorkingDir: repositoryRoot,
    entryPoints: ["packages/host-runtime/src/hub-service-main.ts"],
    outfile: outputPath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "bundle",
    sourcemap: false,
    metafile: true,
    minify: false,
    treeShaking: true,
    charset: "utf8",
    legalComments: "none",
    banner: {
      js: 'import { createRequire as __codexhostCreateRequire } from "node:module"; const require = __codexhostCreateRequire(import.meta.url);',
    },
    logLevel: "silent",
  });
  if (!result.metafile) throw new Error("Hub service build did not return a metafile");
  auditHubServiceMetafile(result.metafile);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  const [flag, output] = process.argv.slice(2);
  if (flag !== "--output" || !output) {
    console.error(
      "usage: node packages/host-runtime/scripts/build-hub-service.mjs --output <file>",
    );
    process.exit(1);
  }
  const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
  buildHubServiceBundle({ repositoryRoot, outputPath: path.resolve(output) }).catch((error) => {
    console.error(`Hub service bundle: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
