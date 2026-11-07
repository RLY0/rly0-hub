// A synthetic OpenAI-compatible relay on 127.0.0.1 for the Hub bench: `/v1/models` and the
// Sub2API `/v1/usage` balance, answered only for the synthetic key. Records every request.
import { createServer } from "node:http";

export const GOOD_KEY = "sk-bench-synthetic-relay-0123456789abcdef";
export const MODELS = ["gpt-5.5", "gpt-5.4-mini", "claude-sonnet-5-5"];

export async function startFakeRelay() {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    requests.push({
      method: request.method,
      path: url.pathname,
      auth: Boolean(request.headers.authorization),
    });
    const authorized = request.headers.authorization === `Bearer ${GOOD_KEY}`;
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (!authorized) return send(401, { error: { message: "invalid key (synthetic)" } });
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return send(200, { object: "list", data: MODELS.map((id) => ({ id, object: "model" })) });
    }
    if (request.method === "GET" && url.pathname === "/v1/usage") {
      return send(200, {
        isValid: true,
        balance: 12.34,
        unit: "USD",
        usage: { today: { cost: 0.5, actual_cost: 0.35 }, total: { cost: 10, actual_cost: 7 } },
      });
    }
    return send(404, { error: { message: "not found (synthetic)" } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
