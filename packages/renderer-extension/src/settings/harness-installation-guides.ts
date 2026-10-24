import type { HarnessPluginDescriptor } from "@codexhost/shared-contracts";
import type { RendererSettingsLocale } from "./localization.js";

export function harnessHasInstallCommands(plugin?: HarnessPluginDescriptor): boolean {
  return (plugin?.installation?.commands.length ?? 0) > 0;
}

/**
 * Plugin manifests are shared with upstream and may name the product "codexhost"; RLY/0 Hub shows
 * its own product name in guide text. Commands, URLs and package names are never rewritten.
 */
function rly0ProductName(text: string | undefined): string | undefined {
  return text?.replace(/(?<![\w@/.-])codexhost(?![\w/.-])/gu, "RLY/0 Hub");
}

export function harnessInstallationGuide(
  plugin: HarnessPluginDescriptor | undefined,
  locale: RendererSettingsLocale,
) {
  const guide = plugin?.installation;
  const text = (
    value: { en: string; "zh-CN"?: string | undefined } | undefined,
  ): string | undefined => rly0ProductName(value?.[locale] ?? value?.en);
  return {
    url: plugin?.links?.installation ?? plugin?.links?.documentation ?? plugin?.links?.website,
    commands: guide?.commands ?? [],
    downloads: guide?.downloads ?? [],
    before: text(guide?.before),
    after: text(guide?.after),
  };
}
