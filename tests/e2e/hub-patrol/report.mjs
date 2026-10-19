// globalTeardown of the Hub UI patrol: folds results/*.json into report.json and report.md.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const PAGE_NAMES = {
  home: "首页",
  accounts: "账号",
  relays: "中转站",
  agents: "AI 助手",
  maintenance: "维护",
  support: "支持",
  "settings-general": "设置 · 通用",
  "settings-instructions": "设置 · 自定义指令",
  "settings-network": "设置 · 网络代理",
  "settings-backup": "设置 · 备份",
  "settings-mcp": "设置 · MCP",
  "settings-skills": "设置 · Skills",
  "settings-threads": "设置 · 线程",
  "settings-updates": "设置 · 更新",
  wizard: "开始使用向导",
};

export default function writeReport() {
  const runDir = process.env.HUB_PATROL_RUN;
  if (!runDir) return;
  const resultsDir = path.join(runDir, "results");
  if (!existsSync(resultsDir)) return;
  const results = readdirSync(resultsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(path.join(resultsDir, name), "utf8")))
    .sort((a, b) => b.width - a.width || order(a.page) - order(b.page));
  const totals = {
    runs: results.length,
    errors: results.reduce((n, r) => n + r.errors.length, 0),
    warnings: results.reduce((n, r) => n + r.warnings.length, 0),
    clicked: results.reduce((n, r) => n + r.clicked.length, 0),
  };
  writeFileSync(
    path.join(runDir, "report.json"),
    JSON.stringify({ runDir, createdAt: new Date().toISOString(), totals, results }, null, 2),
  );

  const lines = [
    "# RLY/0 Hub 界面巡检报告",
    "",
    `- 运行目录：\`${runDir}\``,
    `- 生成时间：${new Date().toLocaleString("zh-CN")}`,
    `- 页面 × 宽度：${totals.runs} 组；共点击 ${totals.clicked} 个控件`,
    `- 错误：**${totals.errors}**（console.error / 页面异常 / 未处理的 Promise 拒绝 / 请求失败 / 页面横向滚动）`,
    `- 警告：${totals.warnings}（文字溢出、点击失败、加载过久等）`,
    "",
    "| 页面 | 宽度 | 点击 | 跳过 | 错误 | 警告 | 截图 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...results.map(
      (r) =>
        `| ${PAGE_NAMES[r.page] || r.page} | ${r.width} | ${r.clicked.length} | ${r.skipped.length} | ${r.errors.length} | ${r.warnings.length} | \`${r.screenshot}\` |`,
    ),
    "",
  ];
  for (const r of results) {
    if (!r.errors.length && !r.warnings.length && !r.dialogs.length) continue;
    lines.push(`## ${PAGE_NAMES[r.page] || r.page} @${r.width}`, "");
    if (r.errors.length) {
      lines.push("**错误**", "");
      for (const e of r.errors) lines.push(`- [${e.type}] ${e.during}：${oneLine(e.text)}`);
      lines.push("");
    }
    if (r.warnings.length) {
      lines.push("**警告**", "");
      for (const w of r.warnings) lines.push(`- [${w.type}] ${w.during}：${oneLine(w.text)}`);
      lines.push("");
    }
    if (r.dialogs.length) {
      lines.push("**弹出的对话框**", "");
      for (const d of r.dialogs) lines.push(`- 「${d.label}」（${d.during}）：\`${d.screenshot}\``);
      lines.push("");
    }
  }
  writeFileSync(path.join(runDir, "report.md"), lines.join("\n"));
  console.log(`Hub patrol report: ${path.join(runDir, "report.md")}`);
}

const order = (page) => {
  const index = Object.keys(PAGE_NAMES).indexOf(page);
  return index === -1 ? 99 : index;
};
const oneLine = (text) => String(text).replace(/\s+/gu, " ").slice(0, 300);
