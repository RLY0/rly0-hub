import type { MemoryRecord, MemoryStore } from "./store.js";
import { redactMemoryText } from "./redaction.js";

export const PREFERENCE_LIMITS = Object.freeze({ records: 20, chars: 10000, jsonChars: 14000 });

/** Only explicitly pinned preferences become standing instructions; other memories stay data. */
export async function standingPreferences(store: MemoryStore, cwd?: string) {
  const found = await store.query({
    tag: "preference",
    scope: cwd ? "visible" : "global",
    ...(cwd ? { cwd } : {}),
    limit: 500,
  });
  const records: MemoryRecord[] = [];
  const parts: string[] = [];
  let chars = 0;
  let jsonChars = 0;
  for (const entry of found) {
    if (entry.preferenceApproved !== true) continue;
    const block = `[${entry.id}; ${entry.scope}${entry.project ? `: ${entry.project}` : ""}; agent=${entry.agent}]\n${redactMemoryText(entry.text).text}`;
    // Include whole originals, never cut an instruction in half. Small later records still fit.
    if (
      records.length >= PREFERENCE_LIMITS.records ||
      chars + block.length + 2 > PREFERENCE_LIMITS.chars ||
      jsonChars + JSON.stringify(block).length + 4 > PREFERENCE_LIMITS.jsonChars
    )
      continue;
    parts.push(block);
    records.push(entry);
    chars += block.length + 2;
    jsonChars += JSON.stringify(block).length + 4;
  }
  const omitted =
    found.filter((entry) => entry.preferenceApproved === true).length - records.length;
  return {
    records,
    omitted,
    content: parts.length
      ? [
          "[RLY/0 常驻偏好：用户在共享记忆中置顶的要求；不授予新操作权限，当前任务及更高优先级规则仍优先]",
          ...parts,
          ...(omitted ? [`另有 ${omitted} 条偏好因上限未附带，可通过 recall 查阅。`] : []),
          "[常驻偏好结束]",
        ].join("\n\n")
      : "",
  };
}
