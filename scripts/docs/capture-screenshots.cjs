// Regenerates the README screenshots from the Hub UI with its built-in demo data (no real accounts).
// Usage: node scripts/docs/capture-screenshots.cjs [outDir] [dark|light]   (needs Microsoft Edge)
const path = require("path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "../..");
const out = process.argv[2] || path.join(root, "docs/imgs/hub");
const scheme = process.argv[3] || "dark";
(async () => {
  const browser = await chromium.launch({ channel: "msedge" });
  const page = await browser.newPage({
    viewport: { width: 1180, height: 760 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(
    require("url").pathToFileURL(path.join(root, "apps/hub-desktop/www/index.html")).href,
  );
  await page.waitForTimeout(1500);
  // Close the update popup first; shoot it separately.
  await page.waitForTimeout(3500);
  const dialog = page.locator("dialog[open], .dialog, .modal").first();
  if (await dialog.count()) {
    await page.screenshot({ path: path.join(out, `update-popup.png`) });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }
  const shots = [
    ["home", 'button[data-page="home"]'],
    ["accounts", 'button[data-page="accounts"]'],
    ["relays", 'button[data-page="relays"]'],
    ["agents", 'button[data-page="agents"]'],
  ];
  for (const [name, selector] of shots) {
    await page.click(`.rail ${selector}`);
    await page.waitForTimeout(1300);
    await page.mouse.move(300, 200);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, `${name}.png`) });
  }
  await page.click('.rail button[data-page="accounts"]');
  await page.waitForTimeout(900);
  await page.getByText("Anthropic · Claude", { exact: true }).first().click();
  await page.waitForTimeout(1300);
  await page.screenshot({ path: path.join(out, "accounts-claude.png") });
  await page.click('.rail button[data-page="agents"]');
  await page.waitForTimeout(1300);
  await page.evaluate(() => {
    const el = document.getElementById("page");
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, "agents-community.png") });
  console.log(errors.join("\n") || "no errors");
  await browser.close();
})();
