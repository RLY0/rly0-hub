import type {
  SharedResourceRequest,
  SharedSkill,
} from "@codexhost/harness-adapter/plugin";

/**
 * Hermes takes Codex skills natively: the gateway process registers each skill folder with the
 * plugin API (`PluginContext.register_skill`), the same process-local path the delegation skill
 * uses; nothing is installed and no Hermes config is written. Hermes reads MCP servers only from
 * its global `config.yaml`, so MCP (and the memory server) arrive only when the person turns on
 * the Hub's managed block there; memory otherwise reaches Hermes as a read-only digest.
 */
export const HERMES_SHARED_SKILL_REQUEST: SharedResourceRequest = Object.freeze({
  harnessId: "hermes",
  skills: true,
  skillFiles: true,
});
export const HERMES_SHARED_CONTEXT_REQUEST: SharedResourceRequest = Object.freeze({
  harnessId: "hermes",
  memory: true,
});

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;

/** Python run before the gateway: registers the skills, never failing the gateway start. */
export function hermesSharedSkillBootstrap(skills: readonly SharedSkill[]): string {
  const entries = skills
    .filter((skill) => SAFE_NAME.test(skill.name))
    .slice(0, 64)
    .map((skill) => [skill.name, `${skill.directory.replace(/[\\/]+$/u, "")}/SKILL.md`]);
  if (!entries.length) return "";
  return `import hermes_bootstrap
from tui_gateway import server
from pathlib import Path
try:
    from hermes_cli.plugins import PluginContext, PluginManifest, get_plugin_manager
    _rly0_shared = PluginContext(PluginManifest(name="rly0-shared"), get_plugin_manager())
    for _rly0_name, _rly0_file in ${JSON.stringify(entries)}:
        try:
            _rly0_shared.register_skill(_rly0_name, Path(_rly0_file))
        except Exception:
            pass
except Exception:
    pass
`;
}
