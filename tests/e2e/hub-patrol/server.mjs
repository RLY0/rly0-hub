// Static server for the RLY/0 Hub window's www/ folder, used by the UI patrol only.
// Without window.chrome.webview the page answers its own calls from pages/mock.js.
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../../apps/hub-desktop/www");
const port = Number(process.argv[2] || process.env.HUB_PATROL_PORT || 47317);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

createServer((request, response) => {
  const url = new URL(request.url || "/", "http://localhost");
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/u, "") || "index.html";
  const file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(root + path.sep)) {
    response.writeHead(403).end();
    return;
  }
  let stat;
  try {
    stat = statSync(file);
  } catch {
    response.writeHead(404).end();
    return;
  }
  if (!stat.isFile()) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(response);
}).listen(port, "127.0.0.1", () => {
  console.log(`hub patrol server on http://127.0.0.1:${port}`);
});
