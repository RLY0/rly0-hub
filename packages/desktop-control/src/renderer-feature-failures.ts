/** Optional discovery failures remain observable without taking down the renderer session. */
export async function recordRendererFeatureFailure(
  renderer: { evaluate<T>(expression: string): Promise<T> },
  feature: "native-rpc" | "rpc-steering",
): Promise<void> {
  await renderer
    .evaluate(
      `(() => {
    const failures = globalThis.__codexhostFeatureFailuresV1 ??= [];
    if (!failures.includes(${JSON.stringify(feature)})) failures.push(${JSON.stringify(feature)});
  })()`,
    )
    .catch(() => undefined);
}
