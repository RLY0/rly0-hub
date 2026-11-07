export type BenchReply = {
  id: string;
  result?: unknown;
  error?: { code?: number; message?: string };
};

export type BenchService = {
  readonly root: string;
  readonly home: string;
  readonly pid: number;
  readonly stderrLog: string;
  readonly ready: boolean;
  readonly exited: { code: number | null; signal: string | null } | null;
  send(message: unknown, timeoutMs?: number): Promise<BenchReply>;
  call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  onMessage(listener: (message: Record<string, unknown>) => void): () => void;
  readonly transcript: unknown[];
  stop(): Promise<void>;
  dispose(options?: { keep?: boolean }): void;
};

export function appResources(appPath: string): string;

export function startBenchService(options: {
  resources: string;
  offline?: boolean;
  seed?: ((home: string) => void) | undefined;
  extraEnvironment?: Record<string, string>;
  allowPorts?: number[];
}): Promise<BenchService>;
