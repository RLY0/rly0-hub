import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HarnessModelRef } from "@codexhost/shared-contracts";
import { nativeHermesPythonCommand } from "./hermes-runtime.js";

import { decodeHermesModelRefId, encodeHermesModelRef } from "./hermes-models.js";

/**
 * Legacy `hermes` launchers exec the agent repository's virtualenv interpreter:
 *   #!/usr/bin/env bash
 *   exec "<agentDir>/venv/bin/python" "<agentDir>/hermes" "$@"
 * New installers expose --print-runtime-command to retain the native bootstrap
 * and dependency generation. Both paths run the same read-only inventory probe.
 */
const POSIX_VENV_PYTHON_SHIM_PATTERN = /exec\s+"([^"]+?venv\/bin\/python)"/;
const WINDOWS_VENV_HERMES_SHIM_PATTERN = /"([^"]+?[\\/]venv[\\/]Scripts[\\/]hermes\.exe)"/i;

const INVENTORY_PROBE_SCRIPT = `
import json
from hermes_cli.inventory import build_models_payload, load_picker_context
context = load_picker_context()
payload = build_models_payload(
    context,
    explicit_only=True,
    include_unconfigured=False,
    picker_hints=False,
    canonical_order=True,
    pricing=False,
    capabilities=False,
    refresh=False,
    probe_custom_providers=False,
    probe_current_custom_provider=False,
    max_models=64,
)
available_provider_slugs = {
    str(row.get("slug") or "").strip().lower()
    for row in payload.get("providers") or []
    if str(row.get("slug") or "").strip().lower() != "moa"
    and row.get("authenticated") is not False
    and row.get("available") is not False
}
moa_availability = {}
try:
    from hermes_cli.config import load_config
    from hermes_cli.moa_config import normalize_moa_config

    moa = normalize_moa_config(load_config().get("moa") or {})
    for preset_name, preset in (moa.get("presets") or {}).items():
        required_providers = []
        for slot in preset.get("reference_models") or []:
            if isinstance(slot, dict) and slot.get("enabled", True):
                required_providers.append(str(slot.get("provider") or "").strip().lower())
        aggregator = preset.get("aggregator") or {}
        if isinstance(aggregator, dict):
            required_providers.append(str(aggregator.get("provider") or "").strip().lower())
        moa_availability[str(preset_name)] = bool(preset.get("enabled", True)) and bool(required_providers) and all(
            provider and provider in available_provider_slugs for provider in required_providers
        )
except Exception:
    # A virtual preset is unsafe to advertise when its backing providers
    # cannot be verified. Normal providers remain available.
    moa_availability = {}
# Keep configuration interpretation in Hermes. Its resolver understands built-in
# aliases, keyed providers, legacy custom entries and endpoint-specific routes.
from hermes_cli import providers as native_providers
from hermes_cli import models as native_models
resolve_provider = getattr(native_providers, "resolve_provider_full", None)
custom_slug = getattr(native_providers, "custom_provider_slug", None)

def provider_identity(value):
    value = str(value or "").strip()
    if not value:
        return ""
    if value.lower() == "custom":
        # Direct model.base_url routing is not the first named custom provider.
        return "custom"
    # Old configs may store a display name after custom:, including spaces.
    # Apply only Hermes's provider normalization; model identifiers stay opaque.
    if value.lower().startswith("custom:") and callable(custom_slug):
        value = custom_slug(value)
    if callable(resolve_provider):
        resolved = resolve_provider(
            value,
            user_providers=getattr(context, "user_providers", {}),
            custom_providers=getattr(context, "custom_providers", []),
        )
        if resolved is not None:
            return str(resolved.id)
    return value

rows = []
for row in payload.get("providers") or []:
    slug = str(row.get("slug") or "").strip()
    provider = str(row.get("name") or "").strip() or slug
    for entry in row.get("models") or []:
        model_id = (
            str(entry.get("id") or entry.get("model") or entry.get("name") or "").strip()
            if isinstance(entry, dict)
            else str(entry).strip()
        )
        if slug and model_id:
            available = (
                row.get("authenticated") is not False
                and row.get("available") is not False
                and (slug.lower() != "moa" or bool(moa_availability.get(model_id, False)))
            )
            aliases = [
                alias.strip()
                for alias in row.get("aliases") or []
                if isinstance(alias, str) and alias.strip()
            ]
            # The row slug is the native --provider route. Resolve it against
            # the same configuration snapshot, never choose a historical alias.
            native_slug = provider_identity(slug)
            native_model_id = native_slug + ":" + model_id
            rows.append({
                "modelId": native_model_id,
                "modelIdAliases": [
                    alias + ":" + model_id
                    for alias in aliases
                    if alias + ":" + model_id != native_model_id
                ],
                "label": model_id,
                "provider": provider,
                "available": available,
            })
current_provider = str(getattr(context, "current_provider", "") or "").strip()
current_model = str(getattr(context, "current_model", "") or "").strip()
parse_model = getattr(native_models, "parse_model_input", None)
if current_model and callable(parse_model):
    current_provider, current_model = parse_model(
        current_model, provider_identity(current_provider),
    )
current_provider = provider_identity(current_provider)
current_model_id = current_provider + ":" + current_model if current_provider and current_model else None
from hermes_cli import main as native_main
check_configured = getattr(native_main, "_has_any_provider_configured", None)
configured = bool(check_configured()) if callable(check_configured) else None
print("codexhost_inventory=" + json.dumps({"models": rows, "currentModelId": current_model_id, "configured": configured}))
`;

export interface HermesInventoryModel {
  /** Native Hermes choice id, e.g. `zai:glm-5-turbo`. */
  modelId: string;
  /** Alternate native identities advertised by Hermes, including custom:<provider>. */
  modelIdAliases?: string[];
  label: string;
  provider: string;
  /** False when Hermes reports unavailable credentials/routes or virtual dependencies. */
  available?: boolean;
}

export interface HermesInventory {
  models: HermesInventoryModel[];
  /** Native id of the configured default model, when discoverable. */
  currentModelId: string | null;
  /** Absent for native versions that do not expose a configuration check. */
  configured?: boolean;
}

/**
 * Current Hermes installs (2026 installer: PM-managed Python, launchers in
 * %LOCALAPPDATA%\hermes\bin) have no venv next to the launcher. Their launcher
 * prints the exact launch command instead: `hermes --print-runtime-command`
 * → `[python, "-I", "-c", "<bootstrap>; runpy.run_module('hermes_cli.main', …)"]`.
 * The bootstrap (dependency selection) is kept and the module entry is
 * replaced by code passed through CODEXHOST_HERMES_CODE.
 */
export interface HermesRuntimeLaunch {
  readonly python: string;
  /** Python statements that prepare Hermes' import path; empty for venv installs. */
  readonly prelude: string;
}

const runtimePreludes = new Map<string, string>();
const runtimeLookups = new Map<string, Promise<string | null>>();

/** Prelude registered for an interpreter found through `--print-runtime-command`. */
export function hermesRuntimePrelude(python: string): string {
  return runtimePreludes.get(python) ?? "";
}

/** Arguments and environment that run `code` in Hermes' own runtime. */
export function hermesPythonInvocation(
  python: string,
  code: string,
  flags: readonly string[] = ["-I"],
): { args: string[]; environment: NodeJS.ProcessEnv } {
  const prelude = hermesRuntimePrelude(python);
  if (!prelude) return { args: [...flags, "-c", code], environment: {} };
  return {
    args: [
      ...flags,
      "-c",
      `${prelude}exec(compile(os.environ['CODEXHOST_HERMES_CODE'], '<codexhost>', 'exec'))`,
    ],
    environment: { CODEXHOST_HERMES_CODE: code },
  };
}

export function parseHermesRuntimeCommand(output: string): HermesRuntimeLaunch | null {
  let value: unknown;
  try {
    value = JSON.parse(output.trim().split(/\r?\n/u).pop() ?? "");
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length < 4) return null;
  const [python, isolate, flag, bootstrap] = value as unknown[];
  if (typeof python !== "string" || isolate !== "-I" || flag !== "-c") return null;
  if (typeof bootstrap !== "string") return null;
  const entry = bootstrap.lastIndexOf("runpy.run_module(");
  if (entry < 0) return null;
  return { python, prelude: bootstrap.slice(0, entry) };
}

/** Asks the launcher for its runtime; null for installs whose launcher predates this. */
export function resolveHermesRuntime(
  hermesExecutable: string,
  environment?: NodeJS.ProcessEnv,
  timeoutMs = 15_000,
): Promise<string | null> {
  const cached = runtimeLookups.get(hermesExecutable);
  if (cached) return cached;
  const lookup = new Promise<string | null>((resolve) => {
    const windowsScript = /\.(cmd|bat)$/iu.test(hermesExecutable);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(hermesExecutable, ["--print-runtime-command"], {
        env: { ...process.env, ...environment },
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        shell: windowsScript,
      });
    } catch {
      resolve(null);
      return;
    }
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const launch = code === 0 ? parseHermesRuntimeCommand(stdout) : null;
      if (!launch) {
        resolve(null);
        return;
      }
      runtimePreludes.set(launch.python, launch.prelude);
      resolve(launch.python);
    });
  });
  // Failed lookups are retried next time (Hermes may be installed or repaired meanwhile).
  runtimeLookups.set(hermesExecutable, lookup);
  void lookup.then((python) => {
    if (!python) runtimeLookups.delete(hermesExecutable);
  });
  return lookup;
}

/**
 * RLY/0 Hub routes Hermes through a relay as its `custom` endpoint. Hermes' own inventory does
 * not list a bare custom endpoint's models, so the relay's models (passed in by the Host) are
 * the catalog; `custom:<model>` is Hermes' choice id for them.
 */
export function relayInventory(environment?: NodeJS.ProcessEnv): HermesInventory | null {
  const raw = environment?.RLY0_HERMES_MODELS;
  if (!raw) return null;
  let models: unknown;
  try {
    models = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(models)) return null;
  const relayName = environment?.RLY0_HERMES_RELAY_NAME?.trim() || "RLY/0";
  const list = models
    .filter(
      (model): model is string => typeof model === "string" && /^[\w.:/@+-]{1,128}$/u.test(model),
    )
    .slice(0, 200)
    .map((model) => ({
      modelId: `custom:${model}`,
      label: `${relayName} / ${model}`,
      provider: "custom",
      available: true,
    }));
  if (!list.length) return null;
  const current = environment?.HERMES_MODEL?.trim();
  return {
    models: list,
    currentModelId: current ? `custom:${current}` : (list[0]?.modelId ?? null),
  };
}

export class HermesInventoryError extends Error {}
export class HermesConfigurationRequiredError extends HermesInventoryError {
  constructor() {
    super(
      "Hermes has no configured Provider or API key. Run `hermes setup`, then check the connection again.",
    );
  }
}
export class HermesInventoryTimeoutError extends HermesInventoryError {
  constructor() {
    super("Hermes model inventory probe timed out");
  }
}

export async function venvPythonFromShim(
  hermesExecutable: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  try {
    const shim = await readFile(hermesExecutable, "utf8");
    if (platform === "win32") {
      const target = WINDOWS_VENV_HERMES_SHIM_PATTERN.exec(shim)?.[1];
      return target ? path.win32.join(path.win32.dirname(target), "python.exe") : null;
    }
    return POSIX_VENV_PYTHON_SHIM_PATTERN.exec(shim)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function inventoryPythonCandidates(
  hermesExecutable: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const executableDirectory = pathApi.dirname(hermesExecutable);
  const environmentDirectory = pathApi.basename(executableDirectory).toLowerCase();
  const candidates: string[] = [];
  if (environmentDirectory === "scripts") {
    candidates.push(pathApi.join(executableDirectory, "python.exe"));
  } else if (environmentDirectory === "bin") {
    candidates.push(
      pathApi.join(executableDirectory, platform === "win32" ? "python.exe" : "python"),
    );
  }
  const relativePython = platform === "win32" ? "venv/Scripts/python.exe" : "venv/bin/python";
  // Current standalone installers place the public launcher in <root>/bin
  // and the bound Python environment in <root>/hermes-agent/venv.
  candidates.push(pathApi.resolve(executableDirectory, "../hermes-agent", relativePython));
  // Older user-local installers place the launcher in ~/.local/bin and the
  // agent environment in ~/.hermes/hermes-agent.
  candidates.push(
    pathApi.resolve(executableDirectory, "../../.hermes/hermes-agent", relativePython),
  );
  return [...new Set(candidates)];
}

function runProbe(
  pythonExecutable: string,
  timeoutMs: number,
  environment?: NodeJS.ProcessEnv,
  arguments_: string[] = ["-I", "-c", INVENTORY_PROBE_SCRIPT],
): Promise<HermesInventory> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable, arguments_, {
      cwd: path.dirname(pythonExecutable),
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new HermesInventoryTimeoutError());
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new HermesInventoryError(`Hermes inventory probe failed to start: ${String(error)}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new HermesInventoryError(
            `Hermes inventory probe exited with ${code}${stderr.trim() ? `: ${stderr.trim().slice(-400)}` : ""}`,
          ),
        );
        return;
      }
      try {
        const payload = stdout
          .split(/\r?\n/)
          .find((line) => line.startsWith("codexhost_inventory="));
        const parsed = JSON.parse(
          payload ? payload.slice("codexhost_inventory=".length) : stdout.trim(),
        ) as {
          models?: HermesInventoryModel[];
          currentModelId?: unknown;
          configured?: unknown;
        };
        const models = (parsed.models ?? []).filter(
          (model) => typeof model?.modelId === "string" && model.modelId.length > 0,
        );
        resolve({
          models,
          ...(typeof parsed.configured === "boolean" ? { configured: parsed.configured } : {}),
          currentModelId:
            typeof parsed.currentModelId === "string" && parsed.currentModelId.length > 0
              ? parsed.currentModelId
              : null,
        });
      } catch {
        reject(new HermesInventoryError("Hermes inventory probe returned malformed output"));
      }
    });
  });
}

/**
 * Resolve the virtualenv interpreter behind the `hermes` launcher and read the
 * real model inventory (same substrate as `hermes model`). Read-only: no
 * Session is created and no config is written.
 */
export async function readHermesModelInventory(
  hermesExecutable: string,
  timeoutMs = 20_000,
  options: { environment?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): Promise<HermesInventory> {
  const relay = relayInventory(options.environment);
  if (relay) return relay;
  const platform = options.platform ?? process.platform;
  const command = await nativeHermesPythonCommand(
    hermesExecutable,
    INVENTORY_PROBE_SCRIPT,
    { ...process.env, ...options.environment },
    timeoutMs,
    platform,
  );
  if (command) return runProbe(command.command, timeoutMs, options.environment, command.arguments);
  const candidates = [
    (await resolveHermesRuntime(hermesExecutable, options.environment)) ?? "",
    (await venvPythonFromShim(hermesExecutable, platform)) ?? "",
    ...inventoryPythonCandidates(hermesExecutable, platform),
  ].filter((candidate, index, all) => candidate.length > 0 && all.indexOf(candidate) === index);
  let pythonExecutable: string | null = null;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      pythonExecutable = candidate;
      break;
    } catch {
      // Try the next supported Hermes installation layout.
    }
  }
  if (!pythonExecutable) {
    throw new HermesInventoryError(
      `Hermes inventory interpreter not found (searched: ${candidates.join(", ")})`,
    );
  }
  return runProbe(pythonExecutable, timeoutMs, options.environment);
}

export interface HermesCatalogModel {
  ref: HarnessModelRef;
  label: string;
  description?: string;
}

/** Encode inventory rows into transport-safe catalog models (base64url refs). */
export function catalogModelsFromInventory(inventory: HermesInventory): {
  models: HermesCatalogModel[];
  defaultModel: HarnessModelRef | null;
} {
  const models: HermesCatalogModel[] = [];
  let defaultModel: HarnessModelRef | null = null;
  const seen = new Set<string>();
  for (const model of inventory.models) {
    if (model.available === false) continue;
    const nativeModelId = model.modelId;
    const ref = encodeHermesModelRef(nativeModelId);
    if (!ref) continue;
    if (
      inventory.currentModelId &&
      (model.modelId === inventory.currentModelId ||
        nativeModelId === inventory.currentModelId ||
        model.modelIdAliases?.includes(inventory.currentModelId))
    ) {
      if (defaultModel && defaultModel.id !== ref.id) {
        throw new HermesInventoryError("Hermes configured Model matches multiple Provider routes");
      }
      defaultModel = ref;
    }
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    models.push({
      ref,
      // RLY/0 relay models already carry the relay's name ("AIHub / gpt-5.5").
      label: model.provider === "custom" ? model.label : `${model.provider} / ${model.label}`,
      description: `Provider: ${model.provider}`,
    });
  }
  if (inventory.currentModelId && models.length > 0 && !defaultModel) {
    throw new HermesInventoryError("Hermes configured Model is absent from its available catalog");
  }
  return { models, defaultModel };
}

/** Best-effort native model id for a transport-safe ref (labels never round-trip). */
export function nativeModelIdFromRefId(refId: string): string | null {
  return decodeHermesModelRefId(refId);
}

export const hermesInventoryPathsForTests = {
  os,
  path,
};
