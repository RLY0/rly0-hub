import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** `lsappinfo info -only bundlepath -app <bundle id>` reports a running application only.
 * Both the keyed (`"LSBundlePath"="…"`) and the human (`bundle path="…"`) forms are accepted. */
export function parseLsappinfoBundlePath(output: string): string | null {
  const match =
    /"LSBundlePath"\s*=\s*"([^"\n]+)"/u.exec(output) ??
    /\bbundle path\s*=\s*"([^"\n]+)"/u.exec(output);
  const bundle = match?.[1]?.replace(/\/$/u, "");
  return bundle && path.isAbsolute(bundle) && bundle.endsWith(".app") ? bundle : null;
}

/** The Launcher records each inspected Desktop bundle (`desktop.installRoot`), newest first. */
export async function readLauncherCodexBundle(
  environment: NodeJS.ProcessEnv,
): Promise<string | null> {
  const directory =
    environment.CODEXHOST_DATA_DIR && path.isAbsolute(environment.CODEXHOST_DATA_DIR)
      ? environment.CODEXHOST_DATA_DIR
      : path.join(environment.HOME ?? os.homedir(), ".codexhost");
  try {
    const bytes = await fs.readFile(
      path.join(directory, "diagnostics", "launcher-startup-v1.json"),
    );
    if (bytes.length > 256 * 1024) return null;
    const raw: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("schemaVersion" in raw) ||
      raw.schemaVersion !== 1 ||
      !("records" in raw) ||
      !Array.isArray(raw.records)
    )
      return null;
    for (const record of raw.records as unknown[]) {
      const root: unknown =
        typeof record === "object" && record !== null && "desktop" in record
          ? (record.desktop as { installRoot?: unknown } | null)?.installRoot
          : undefined;
      if (typeof root === "string" && path.isAbsolute(root) && root.endsWith(".app"))
        return root.replace(/\/$/u, "");
    }
    return null;
  } catch {
    return null;
  }
}
