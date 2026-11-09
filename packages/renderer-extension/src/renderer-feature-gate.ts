import type { CodexRendererFeature, CodexRendererPolicy } from "@codexhost/shared-contracts";
export function rendererFeatureEnabled(feature: CodexRendererFeature): boolean {
  const policy = (
    globalThis as typeof globalThis & { __codexhostFeaturePolicyV1?: CodexRendererPolicy }
  ).__codexhostFeaturePolicyV1;
  return (
    !policy ||
    ((policy.mode === "full" || (policy.mode === "core" && feature === "usage")) &&
      !policy.disabled.includes(feature))
  );
}
/** Each optional installer has its own boundary; failures are observable and never stop siblings. */
export function installRendererFeature<T>(
  feature: CodexRendererFeature,
  install: () => T,
  fallback: () => T,
): T {
  if (!rendererFeatureEnabled(feature)) return fallback();
  try {
    return install();
  } catch {
    const state = globalThis as typeof globalThis & { __codexhostFeatureFailuresV1?: string[] };
    state.__codexhostFeatureFailuresV1 ??= [];
    if (!state.__codexhostFeatureFailuresV1.includes(feature))
      state.__codexhostFeatureFailuresV1.push(feature);
    return fallback();
  }
}
