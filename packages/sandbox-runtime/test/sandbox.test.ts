import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sandboxSettingsSchema, type SandboxSettings } from "@codexhost/shared-contracts";
import {
  guestProjectPath,
  parseDockerSandboxes,
  readSandboxSettings,
  resolveSandboxBinding,
  sameProject,
  sandboxEnvironment,
  sandboxSettingsFile,
  validateSandboxProject,
  verifySandboxWorkspace,
  verifySandboxBinding,
  writeSandboxSettings,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-isolation-"));
  roots.push(root);
  const environment = { CODEXHOST_DATA_DIR: root, USERPROFILE: path.join(root, "home") };
  const settings: SandboxSettings = {
    version: 1,
    enabled: true,
    runtimeRoot: path.join(root, "runtime"),
    proxy: "socks5h://127.0.0.1:19876",
    projects: [{ name: "claude-demo", id: "id-1", project: "C:\\Projects\\demo" }],
  };
  return { root, environment, settings };
}

describe("isolated execution configuration", () => {
  it("revokes a cached route before any new process can start", async () => {
    const { environment, settings } = await fixture();
    const project = settings.projects[0];
    if (!project) throw new Error("fixture project missing");
    await writeSandboxSettings(environment, { ...settings, projects: [] });
    await expect(
      verifySandboxBinding({ command: "must-not-execute", settings, project }, environment),
    ).rejects.toThrow("ISOLATION_CONFIGURATION_CHANGED");
  });
  it("distinguishes absent configuration from damaged configuration and never falls back on parse errors", async () => {
    const { environment, settings } = await fixture();
    expect(readSandboxSettings(environment)).toBeNull();
    await writeSandboxSettings(environment, settings);
    expect(readSandboxSettings(environment)).toEqual(settings);
    await writeFile(sandboxSettingsFile(environment), "{broken");
    expect(() => resolveSandboxBinding(environment, "C:\\Projects\\demo")).toThrow(
      "ISOLATION_CONFIG_INVALID",
    );
  });
  it("refuses an unauthorized project even when a local Claude command exists", async () => {
    const { environment, settings } = await fixture();
    await writeSandboxSettings(environment, settings);
    expect(() =>
      resolveSandboxBinding(
        { ...environment, CODEXHOST_CLAUDE_COMMAND: process.execPath },
        "C:\\OtherProject",
      ),
    ).toThrow(
      process.platform === "win32" ? "ISOLATION_PROJECT_NOT_AUTHORIZED" : "ISOLATION_WINDOWS_ONLY",
    );
    expect(
      resolveSandboxBinding(environment, "C:\\OtherProject", { ...settings, enabled: false }),
    ).toBeNull();
  });
  it("rejects broad directory sharing and canonicalizes a single project", async () => {
    if (process.platform !== "win32") return;
    const { root, environment } = await fixture();
    const project = path.join(root, "project");
    await mkdir(project);
    expect(await validateSandboxProject(project, environment)).toBe(project);
    await expect(validateSandboxProject(root, environment)).rejects.toThrow(
      "ISOLATION_PROJECT_TOO_BROAD",
    );
    await expect(validateSandboxProject(path.parse(root).root, environment)).rejects.toThrow(
      "ISOLATION_PROJECT_TOO_BROAD",
    );
  });
  it("requires exactly one matching Claude workspace when adopting a sandbox", () => {
    const project = { name: "claude-demo", project: "C:\\Projects\\中文 项目" };
    const box = {
      name: project.name,
      id: "id-1",
      agent: "claude",
      status: "running",
      workspaces: [project.project],
    };
    expect(verifySandboxWorkspace([box], project)).toBe(box);
    for (const changed of [
      { ...box, agent: "codex" },
      { ...box, workspaces: [] },
      { ...box, workspaces: [project.project, "C:\\private"] },
      { ...box, workspaces: ["C:\\Projects\\other"] },
    ])
      expect(() => verifySandboxWorkspace([changed], project)).toThrow(
        "ISOLATION_WORKSPACE_MISMATCH",
      );
    expect(() => parseDockerSandboxes('{"sandboxes":[]}')).toThrow();
    expect(() => parseDockerSandboxes('[{"name":"x"}]')).toThrow();
  });
  it("maps Windows paths without shell interpolation and isolates the CLI data root", async () => {
    const { settings } = await fixture();
    expect(guestProjectPath("D:\\Projects\\中文 项目\\a';&$()")).toBe(
      "/d/Projects/中文 项目/a';&$()",
    );
    expect(() => guestProjectPath("\\\\server\\share")).toThrow();
    expect(sameProject("D:\\Projects\\demo\\", "d:/projects/DEMO")).toBe(true);
    const original = { LOCALAPPDATA: "C:\\original", NO_PROXY: "*" };
    expect(sandboxEnvironment(original, settings)).toMatchObject({
      LOCALAPPDATA: settings.runtimeRoot,
      NO_PROXY: "",
    });
    expect(original.LOCALAPPDATA).toBe("C:\\original");
  });
  it("accepts only credential-free local proxies and validates their ports", async () => {
    const { settings } = await fixture();
    for (const proxy of ["http://127.0.0.1:1234", "socks5h://localhost:1234", "http://[::1]:1234"])
      expect(sandboxSettingsSchema.safeParse({ ...settings, proxy }).success).toBe(true);
    for (const proxy of [
      "http://127.0.0.1:0",
      "http://127.0.0.1:99999",
      "http://user:secret@127.0.0.1:1234",
      "http://example.com:1234",
      "socks5://127.0.0.1:1234",
      "http://127.0.0.1:1234/path",
    ])
      expect(sandboxSettingsSchema.safeParse({ ...settings, proxy }).success).toBe(false);
  });
});
