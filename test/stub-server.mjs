// A local HTTP server that answers scripted responses and records every request it gets.
import { createServer } from "node:http";

export async function startStub() {
  const routes = new Map();
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://stub");
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      const queue = routes.get(`${req.method} ${url.pathname}`) ?? [];
      const reply = queue.length > 1 ? queue.shift() : queue[0] ?? { status: 404, body: { error: "no stub" } };
      const payload = reply.body === undefined ? "" : JSON.stringify(reply.body);
      const headers = { ...(reply.headers ?? {}) };
      if (payload) headers["Content-Type"] = "application/json";
      res.writeHead(reply.status ?? 200, headers);
      res.end(payload);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    /** Answer `method path` with `replies` in order; the last one repeats. */
    on(method, path, ...replies) {
      routes.set(`${method} ${path}`, replies);
    },
    calls(method, path) {
      return requests.filter((r) => (!method || r.method === method) && (!path || r.path === path));
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
