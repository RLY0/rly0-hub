import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalPageOpener } from "@codexhost/desktop-control";

import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { RLY0_HOME_DATA_DIRECTORY_NAME } from "@codexhost/shared-contracts";

import { createLauncherUrlOpener } from "./launcher-url-opener.js";
import { sharedResourcesProvider } from "./shared-harness-resources.js";

export const HARNESS_PLUGIN_DIRECTORY_ENV = "CODEXHOST_PLUGIN_DIRECTORY";

/** The distribution owns the sibling plugins directory; never search a project cwd. */
export function installedHarnessPluginOptions(
  environment: NodeJS.ProcessEnv,
  managedRemoteHost = false,
  hostRuntimeUrl: string = import.meta.url,
): { pluginRoots: readonly string[]; pluginContext: HarnessPluginContext } {
  const opener = managedRemoteHost ? undefined : createLauncherUrlOpener(environment);
  const openLocalPage = managedRemoteHost ? undefined : createLocalPageOpener(environment);
  return {
    pluginRoots: [
      path.join(path.dirname(fileURLToPath(hostRuntimeUrl)), "plugins"),
      environment[HARNESS_PLUGIN_DIRECTORY_ENV] ??
        path.join(
          environment.CODEXHOST_DATA_DIR
            ? path.resolve(environment.CODEXHOST_DATA_DIR)
            : path.join(os.homedir(), RLY0_HOME_DATA_DIRECTORY_NAME),
          "plugins",
        ),
    ],
    pluginContext: {
      environment,
      platform: process.platform,
      managedRemoteHost,
      ...(!managedRemoteHost ? { sharedResources: sharedResourcesProvider(environment) } : {}),
      ...(opener ? { openLocalUrl: (url: string) => opener(new URL(url)) } : {}),
      ...(openLocalPage ? { openLocalPage } : {}),
    },
  };
}
