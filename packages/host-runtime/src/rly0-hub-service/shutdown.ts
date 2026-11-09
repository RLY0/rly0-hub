/** One shared disposal for stdin EOF and termination signals. The macOS shell closes stdin
 * and sends SIGTERM; the default SIGTERM action would kill Node before locks are released. */
export function createHubServiceShutdown(options: {
  dispose: () => Promise<void>;
  exit: (code: number) => void;
  signals?: Pick<NodeJS.Process, "once">;
  timeoutMs?: number;
}): () => Promise<void> {
  let disposing: Promise<void> | undefined;
  const dispose = () => (disposing ??= options.dispose().catch(() => undefined));
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    (options.signals ?? process).once(signal, () => {
      // Bounded: a stuck native command must not keep an orphaned service alive.
      const timer = setTimeout(() => options.exit(1), options.timeoutMs ?? 10_000);
      timer.unref?.();
      void dispose().then(() => {
        clearTimeout(timer);
        options.exit(0);
      });
    });
  return dispose;
}
