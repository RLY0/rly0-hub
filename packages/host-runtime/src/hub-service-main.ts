// Entry of `app/hub-service.mjs`: the backend the standalone RLY/0 Hub window (`bin/rly0-hub.exe`)
// starts with the bundled Node and talks to over stdio. It lives as long as the window's tray.
import {
  resolveRly0HubAutostartCommand,
  resolveRly0InstallRoot,
} from "./rly0-appearance/hub-autostart.js";
import { killCodexProcesses } from "./rly0-hub-service/codex-processes.js";
import { Rly0HubService } from "./rly0-hub-service/service.js";
import { createHubServiceShutdown } from "./rly0-hub-service/shutdown.js";
import { serveRly0HubStdio } from "./rly0-hub-service/stdio-server.js";

const HUB_SERVICE_VERSION = "1";

async function main(): Promise<void> {
  const environment = process.env;
  // The shell closes its end of stdout while shutdown is still releasing; a late write must not
  // turn into an unhandled 'error' that kills the release halfway.
  process.stdout.on("error", () => undefined);
  const installRoot = environment.RLY0_HUB_INSTALL_ROOT || resolveRly0InstallRoot(process.execPath);
  const autostartCommand = resolveRly0HubAutostartCommand(installRoot);
  const service = new Rly0HubService({
    environment,
    installRoot,
    killCodexProcesses: () => killCodexProcesses({ environment, installRoot }),
    // Quota / balance updates for the window (the shell forwards them to the page).
    onEvent: (event, params) => {
      if (process.stdout.writable) process.stdout.write(`${JSON.stringify({ event, params })}\n`);
    },
    ...(autostartCommand ? { autostartCommand } : {}),
  });
  const dispose = createHubServiceShutdown({
    dispose: () => service.dispose(),
    exit: (code) => process.exit(code),
  });
  await service.start().catch(() => undefined);
  process.stdout.write(`${JSON.stringify({ event: "ready", version: HUB_SERVICE_VERSION })}\n`);
  await serveRly0HubStdio(service, process.stdin, process.stdout);
  await dispose();
}

main().then(
  () => process.exit(0),
  () => process.exit(1),
);
