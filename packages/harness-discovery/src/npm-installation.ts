import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { resolveHarnessExecutable } from "./resolve.js";
import { withNodeRuntimeOnPath } from "./node-runtime.js";
import {
  fetchInstallationText,
  installationVersion,
  runInstallationCommand,
} from "./installation.js";

/** Optional drivers keep background updates hermetic and on the Hub's proxy. */
export interface NpmInstallationOptions {
  platform?: NodeJS.Platform;
  readText?: (file: string) => Promise<string>;
  realpath?: (file: string) => Promise<string>;
  resolveNpm?: (environment: NodeJS.ProcessEnv) => string | null;
  fetchText?: (url: string) => Promise<string>;
  run?: typeof runInstallationCommand;
}

function referencesNpmBin(shim: string, name: string, bin: string): boolean {
  if (bin.includes("..")) return false;
  const target = `node_modules/${name}/${bin.replace(/^\.\//, "")}`.toLowerCase();
  const text = shim.replaceAll("\\", "/").toLowerCase();
  return text.includes(`%dp0%/${target}"`) || text.includes(`%~dp0/${target}"`);
}

/** Match the CLI's real package, never a different npm prefix found by chance on PATH. */
export async function npmInstallation(
  command: string,
  packages: readonly string[],
  environment: NodeJS.ProcessEnv,
  options: NpmInstallationOptions = {},
) {
  const platform = options.platform ?? process.platform;
  // Keep the legacy default; an explicitly targeted platform also selects its path semantics.
  const pathApi = options.platform ? (platform === "win32" ? path.win32 : path.posix) : path;
  const read = options.readText ?? ((file: string) => readFile(file, "utf8"));
  const canonical = options.realpath ?? realpath;
  const fetchText = options.fetchText ?? fetchInstallationText;
  const run = options.run ?? runInstallationCommand;
  let selected = await canonical(command);
  if (platform === "win32" && /\.(cmd|bat)$/i.test(selected)) {
    const shim = (await read(selected)).replaceAll("\\", "/");
    const root = pathApi.dirname(selected);
    for (const name of packages) {
      const directory = pathApi.join(root, "node_modules", ...name.split("/"));
      const metadata = await read(pathApi.join(directory, "package.json"))
        .then((text) => JSON.parse(text) as { bin?: string | Record<string, string> })
        .catch(() => null);
      const bins =
        typeof metadata?.bin === "string" ? [metadata.bin] : Object.values(metadata?.bin ?? {});
      const bin = bins.find((entry) => referencesNpmBin(shim, name, entry));
      if (bin) {
        selected = await canonical(pathApi.join(directory, bin));
        break;
      }
    }
  }
  let directory = pathApi.dirname(selected);
  for (let depth = 0; depth < 8; depth++) {
    const metadata = await read(pathApi.join(directory, "package.json"))
      .then(
        (text) =>
          JSON.parse(text) as {
            name?: string;
            version?: string;
            bin?: string | Record<string, string>;
          },
      )
      .catch(() => null);
    if (metadata?.name && packages.includes(metadata.name)) {
      const name = metadata.name;
      const currentVersion = installationVersion(metadata.version);
      const segments = name.split("/");
      let modules = directory;
      for (let index = 0; index < segments.length; index++) modules = pathApi.dirname(modules);
      const prefix =
        platform === "win32" ? pathApi.dirname(modules) : pathApi.dirname(pathApi.dirname(modules));
      const globalRoot =
        platform === "win32"
          ? pathApi.join(prefix, "node_modules")
          : pathApi.join(prefix, "lib", "node_modules");
      const env = withNodeRuntimeOnPath(environment);
      const npm = options.resolveNpm
        ? options.resolveNpm(env)
        : resolveHarnessExecutable(
            { id: "npm", command: "npm", installRoots: { posix: [], windows: [] } },
            { environment: env },
          )?.executable;
      let globalInstall = modules === globalRoot;
      if (platform === "win32") {
        // Windows local/global modules have identical layouts. Require a prefix-level
        // npm launcher pointing at this bin, and reject project-owned/ambiguous prefixes.
        const project = (
          await Promise.all(
            ["package.json", "package-lock.json", "npm-shrinkwrap.json"].map((file) =>
              read(pathApi.join(prefix, file)).then(
                () => true,
                (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
              ),
            ),
          )
        ).some(Boolean);
        const bins =
          typeof metadata.bin === "string"
            ? { [name.split("/").at(-1) ?? name]: metadata.bin }
            : (metadata.bin ?? {});
        const launchers = await Promise.all(
          Object.entries(bins).map(async ([bin, entry]) => {
            if (pathApi.basename(bin) !== bin || entry.includes("..")) return false;
            const target = await canonical(pathApi.join(directory, entry)).catch(() => "");
            if (target.toLowerCase() !== selected.toLowerCase()) return false;
            const shim = await read(pathApi.join(prefix, `${bin}.cmd`)).catch(() => "");
            return referencesNpmBin(shim, name, entry);
          }),
        );
        globalInstall = globalInstall && !project && launchers.some(Boolean);
      }
      const canUpdate = globalInstall && !!npm;
      return {
        packageName: name,
        npmExecutable: npm ?? null,
        prefix,
        currentVersion,
        canUpdate,
        latest: async () => {
          const data = JSON.parse(
            await fetchText(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`),
          ) as { version?: string };
          return installationVersion(data.version);
        },
        update: async (version: string) => {
          if (!canUpdate || !npm)
            throw new Error("Use the original package manager to update this installation");
          await run(
            npm,
            ["install", "--global", "--prefix", prefix, `${name}@${installationVersion(version)}`],
            env,
            300_000,
          );
        },
      };
    }
    const parent = pathApi.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}
