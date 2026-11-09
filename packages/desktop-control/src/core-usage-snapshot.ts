import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
const snapshot = z.object({
  checkedAt: z.number().nonnegative(),
  quota: z.object({ usedPercent: z.number().finite(), resetsAt: z.number().optional() }).nullable(),
  balance: z.object({ amount: z.number().finite(), unit: z.enum(["USD", "CNY"]) }).nullable(),
});
export async function readCoreUsageSnapshot(
  environment = process.env,
  now = Date.now(),
): Promise<unknown> {
  const unavailable = { available: false, checkedAt: null, quota: null, balance: null };
  try {
    const bytes = await readFile(
      path.join(
        environment.CODEXHOST_DATA_DIR ?? path.join(os.homedir(), ".rly0-hub"),
        "codex-core-usage.json",
      ),
    );
    if (bytes.length > 16 * 1024) return unavailable;
    const value = snapshot.parse(JSON.parse(bytes.toString("utf8")));
    if (value.checkedAt > now || now - value.checkedAt > 10 * 60_000) return unavailable;
    return { available: true, ...value };
  } catch {
    return unavailable;
  }
}
