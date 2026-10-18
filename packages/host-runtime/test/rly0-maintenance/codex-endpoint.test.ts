import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkCodexEndpoint,
  displayUrl,
  probeEndpoint,
  resolveCodexEndpoint,
} from "../../src/rly0-maintenance/codex-endpoint.js";

let root: string;
const servers: Server[] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-codex-endpoint-"));
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  await fs.rm(root, { recursive: true, force: true });
});

/** A local server that answers every request with `status`; returns its port. */
async function listen(status: number): Promise<number> {
  const server = createServer((_req, res) => {
    res.statusCode = status;
    res.end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** A port nothing listens on: bind, read the port, close. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe("resolveCodexEndpoint", () => {
  it("follows profile → model_provider → base_url, then openai_base_url, then the official service", () => {
    expect(resolveCodexEndpoint({})).toEqual({
      url: "https://chatgpt.com/backend-api/codex",
      source: "default",
      providerId: "openai",
    });
    expect(resolveCodexEndpoint({ openai_base_url: "http://127.0.0.1:17841/v1" })).toEqual({
      url: "http://127.0.0.1:17841/v1",
      source: "openai_base_url",
      providerId: "openai",
    });
    const config = {
      model_provider: "relay",
      profile: "work",
      openai_base_url: "http://ignored",
      model_providers: {
        relay: { base_url: "https://relay.example/v1" },
        other: { base_url: "http://127.0.0.1:25917/v1" },
      },
      profiles: { work: { model_provider: "other" } },
    };
    expect(resolveCodexEndpoint(config)).toEqual({
      url: "http://127.0.0.1:25917/v1",
      source: "provider",
      providerId: "other",
    });
  });

  it("never shows credentials or a query string", () => {
    expect(displayUrl("https://user:secret@relay.example/v1/?key=abc")).toBe(
      "https://relay.example/v1",
    );
  });
});

describe("probeEndpoint", () => {
  it("treats any HTTP answer as reachable and a refused connection as down", async () => {
    const port = await listen(502);
    expect(await probeEndpoint(`http://127.0.0.1:${port}/v1`)).toEqual({
      reachable: true,
      httpStatus: 502,
    });
    const closed = await freePort();
    expect(await probeEndpoint(`http://127.0.0.1:${closed}/v1`)).toEqual({
      reachable: false,
      failure: "REFUSED",
    });
    expect(await probeEndpoint("not a url")).toEqual({ reachable: false, failure: "BAD_URL" });
  });

  it("reports a timeout when nothing answers in time", async () => {
    const never = () => new Promise<never>(() => undefined);
    const fetcher = (_url: string, init: { signal: AbortSignal }) =>
      Promise.race([
        never(),
        new Promise<never>((_resolve, reject) =>
          init.signal.addEventListener("abort", () => reject(init.signal.reason)),
        ),
      ]);
    expect(await probeEndpoint("http://127.0.0.1:1/v1", { fetcher, timeoutMs: 20 })).toEqual({
      reachable: false,
      failure: "TIMEOUT",
    });
  });
});

describe("checkCodexEndpoint", () => {
  it("flags a local bridge that is configured but not running, and names a known one", async () => {
    const port = await freePort();
    const codexHome = path.join(root, ".codex");
    await fs.mkdir(codexHome, { recursive: true });
    const configPath = path.join(codexHome, "config.toml");
    await fs.writeFile(configPath, `openai_base_url = "http://127.0.0.1:${port}/v1"\n`);
    await fs.mkdir(path.join(root, ".codex-chatgpt-web"));
    await fs.writeFile(
      path.join(root, ".codex-chatgpt-web", "config.json"),
      JSON.stringify({ port, controlToken: "never-read" }),
    );
    const exe = path.join(root, "Local", "Programs", "Codex Web GPT", "Codex Web GPT.exe");
    await fs.mkdir(path.dirname(exe), { recursive: true });
    await fs.writeFile(exe, "");
    const environment = { USERPROFILE: root, LOCALAPPDATA: path.join(root, "Local") };

    expect(await checkCodexEndpoint(configPath, environment)).toEqual({
      url: `http://127.0.0.1:${port}/v1`,
      source: "openai_base_url",
      providerId: "openai",
      local: true,
      reachable: false,
      failure: "REFUSED",
      app: { id: "codex-web-gpt", name: "Codex Web GPT" },
    });
  });

  it("is healthy when the configured endpoint answers", async () => {
    const port = await listen(401);
    const configPath = path.join(root, "config.toml");
    await fs.writeFile(
      configPath,
      `model_provider = "rly0"\n[model_providers.rly0]\nbase_url = "http://127.0.0.1:${port}/v1"\n`,
    );
    const result = await checkCodexEndpoint(configPath, { USERPROFILE: root });
    expect(result).toMatchObject({ local: true, reachable: true, httpStatus: 401 });
    expect(result).not.toHaveProperty("app");
  });
});
