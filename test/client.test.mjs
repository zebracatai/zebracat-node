// The hand-written layer against a local stub server: auth, retries, idempotency keys, typed errors, waiting.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  Zebracat,
  VERSION,
  OPERATION_IDS,
  ZebracatError,
  APIConnectionError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  InsufficientFundsError,
  InternalServerError,
  NotFoundError,
  RateLimitError,
  VideoFailedError,
  WaitTimeoutError,
} from "../dist/index.js";
import { startStub } from "./stub-server.mjs";

const API = "/api/v1/public";
const TASK = "6f1c0d2e9b8a4c7d8e9f0a1b2c3d4e5f";
const video = (phase, extra = {}) => ({ task_id: TASK, status: "processing", phase, engine: "director_v2", ...extra });
const ENVELOPE_402 = {
  error: "Not enough API balance for this video.",
  code: "insufficient_balance",
  type: "insufficient_funds",
  retryable: false,
  hint: "Add credit, then generate again.",
  topup_url: "https://zebracat.ai/api#billing",
  request_id: "req-from-body",
};

let stub;
let sleeps;
let now;

function fake(client) {
  client._sleep = async (ms) => {
    sleeps.push(ms);
    now += ms;
  };
  client._now = () => now;
  return client;
}

function makeClient(options = {}) {
  return fake(new Zebracat({ apiKey: "sk-test", baseURL: stub.url, ...options }));
}

beforeEach(async () => {
  stub = await startStub();
  sleeps = [];
  now = 0;
});
afterEach(async () => {
  await stub.close();
});

// ------------------------------------------------------------------ auth

test("API key header, user agent and request id", async () => {
  stub.on("GET", `${API}/account`, { body: { email: "a@b.c" } });
  assert.deepEqual(await makeClient().getAccount(), { email: "a@b.c" });
  const [call] = stub.calls();
  assert.equal(call.headers["x-api-key"], "sk-test");
  assert.equal(call.headers.authorization, undefined);
  assert.equal(call.headers["user-agent"], `zebracat-node/${VERSION}`);
  assert.equal(call.headers["x-request-id"].length, 32);
});

test("API key from the environment", async () => {
  process.env.ZEBRACAT_API_KEY = "sk-env";
  try {
    stub.on("GET", `${API}/account`, { body: {} });
    await fake(new Zebracat({ baseURL: stub.url })).getAccount();
    assert.equal(stub.calls()[0].headers["x-api-key"], "sk-env");
  } finally {
    delete process.env.ZEBRACAT_API_KEY;
  }
});

test("no credentials, or both, are refused", () => {
  delete process.env.ZEBRACAT_API_KEY;
  assert.throws(() => new Zebracat(), (e) => e instanceof ZebracatError && /No credentials/.test(e.message));
  assert.throws(() => new Zebracat({ apiKey: "sk", accessToken: "zoa_x" }), /not both/);
});

test("OAuth bearer refreshes once on 401 and reports the new tokens", async () => {
  stub.on("GET", `${API}/account`, { status: 401, body: { detail: "expired" } }, { body: { ok: true } });
  stub.on("POST", "/api/oauth/token", { body: { access_token: "zoa_new", refresh_token: "zor_new", token_type: "Bearer", expires_in: 3600 } });
  const saved = [];
  const client = makeClient({ apiKey: undefined, accessToken: "zoa_old", refreshToken: "zor_old", clientId: "cli", onTokenRefresh: (t) => saved.push(t) });
  assert.deepEqual(await client.getAccount(), { ok: true });
  const [first, refresh, second] = stub.requests;
  assert.equal(first.headers.authorization, "Bearer zoa_old");
  assert.equal(refresh.path, "/api/oauth/token");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(refresh.body.toString())), { grant_type: "refresh_token", refresh_token: "zor_old", client_id: "cli" });
  assert.equal(second.headers.authorization, "Bearer zoa_new");
  assert.equal(client.refreshToken, "zor_new");
  assert.equal(saved[0].access_token, "zoa_new");
});

test("a refused refresh is an AuthenticationError", async () => {
  stub.on("GET", `${API}/account`, { status: 401, body: { detail: "expired" } });
  stub.on("POST", "/api/oauth/token", { status: 400, body: { error: "invalid_grant" } });
  const client = makeClient({ apiKey: undefined, accessToken: "zoa_old", refreshToken: "zor_old", clientId: "cli" });
  await assert.rejects(client.getAccount(), (e) => e instanceof AuthenticationError && /sign in again/.test(e.message));
});

test("401 without a refresh token is thrown with the request id", async () => {
  stub.on("GET", `${API}/account`, { status: 401, body: { detail: "Invalid API key." }, headers: { "X-Request-ID": "rid-401" } });
  await assert.rejects(makeClient().getAccount(), (e) => e instanceof AuthenticationError && e.requestId === "rid-401" && e.message.includes("Invalid API key."));
});

// ------------------------------------------------------------------ retries

test("429 honours Retry-After, then succeeds", async () => {
  stub.on("GET", `${API}/account`, { status: 429, body: { error: "slow down" }, headers: { "Retry-After": "7" } }, { body: { ok: 1 } });
  assert.deepEqual(await makeClient().getAccount(), { ok: 1 });
  assert.equal(stub.calls().length, 2);
  assert.deepEqual(sleeps, [7000]);
});

test("a Retry-After longer than maxRetryWaitMs is thrown, not waited out", async () => {
  stub.on("GET", `${API}/account`, { status: 429, body: { error: "daily cap" }, headers: { "Retry-After": "3600" } });
  await assert.rejects(makeClient().getAccount(), (e) => e instanceof RateLimitError && e.retryAfter === 3600);
  assert.equal(stub.calls().length, 1);
  assert.deepEqual(sleeps, []);
});

test("5xx on a read is retried with backoff until maxRetries", async () => {
  stub.on("GET", `${API}/account`, { status: 503, body: { error: "busy", request_id: "rid-503" } });
  const client = makeClient();
  await assert.rejects(client.getAccount(), (e) => e instanceof InternalServerError && e.requestId === "rid-503");
  assert.equal(stub.calls().length, 1 + client.maxRetries);
  assert.equal(sleeps.length, client.maxRetries);
  assert.ok(sleeps.every((ms) => ms > 0 && ms <= 8000));
});

test("per-call maxRetries", async () => {
  stub.on("GET", `${API}/account`, { status: 502, body: { error: "bad gateway" } });
  await assert.rejects(makeClient().getAccount({ maxRetries: 0 }), InternalServerError);
  assert.equal(stub.calls().length, 1);
});

test("a paid POST sends one Idempotency-Key, reused across retries", async () => {
  stub.on("POST", `${API}/videos`, { status: 503, body: { error: "busy" } }, { status: 202, body: video("planning") });
  const answer = await makeClient().createVideo({ brief: "How bees make honey", auto_generate: false });
  assert.equal(answer.phase, "planning");
  const [first, second] = stub.calls("POST", `${API}/videos`);
  const key = first.headers["idempotency-key"];
  assert.ok(key.startsWith("zc-"));
  assert.equal(second.headers["idempotency-key"], key);
  assert.deepEqual(JSON.parse(first.body), { brief: "How bees make honey", auto_generate: false });
  assert.equal(first.headers["x-request-id"], second.headers["x-request-id"]);
});

test("the caller's idempotency key is sent", async () => {
  stub.on("POST", `${API}/videos`, { status: 202, body: video("planning") });
  await makeClient().createVideo({ brief: "x" }, { idempotencyKey: "order-42" });
  assert.equal(stub.calls()[0].headers["idempotency-key"], "order-42");
});

test("a paid POST without server replay is not retried on 5xx", async () => {
  stub.on("POST", `${API}/generate_image`, { status: 500, body: { error: "boom" } });
  await assert.rejects(makeClient().generateImage({ prompt: "a cat" }), InternalServerError);
  assert.equal(stub.calls().length, 1);
  assert.ok(stub.calls()[0].headers["idempotency-key"]);
});

test("a paid POST without server replay is retried on 429", async () => {
  stub.on("POST", `${API}/generate_image`, { status: 429, body: { error: "x" }, headers: { "Retry-After": "1" } }, { body: { ok: 1 } });
  assert.deepEqual(await makeClient().generateImage({ prompt: "a cat" }), { ok: 1 });
  assert.equal(stub.calls().length, 2);
});

test("a free POST has no Idempotency-Key", async () => {
  stub.on("POST", `${API}/webhooks`, { status: 201, body: { id: 1 } });
  await makeClient().createWebhook({ url: "https://example.com/hook", events: ["video.completed"] });
  assert.equal(stub.calls()[0].headers["idempotency-key"], undefined);
});

test("a refused connection is an APIConnectionError with a request id", async () => {
  const client = fake(new Zebracat({ apiKey: "sk", baseURL: "http://127.0.0.1:9", maxRetries: 1 }));
  await assert.rejects(client.getAccount(), (e) => e instanceof APIConnectionError && e.requestId.length === 32);
  assert.equal(sleeps.length, 1);
});

// ------------------------------------------------------------------ errors

test("402 is typed and carries the envelope", async () => {
  stub.on("POST", `${API}/videos/${TASK}/generate`, { status: 402, body: ENVELOPE_402, headers: { "X-Request-ID": "req-header" } });
  await assert.rejects(makeClient().generateVideo(TASK), (e) => {
    assert.ok(e instanceof InsufficientFundsError);
    assert.equal(e.status, 402);
    assert.equal(e.code, "insufficient_balance");
    assert.equal(e.type, "insufficient_funds");
    assert.equal(e.topupUrl, "https://zebracat.ai/api#billing");
    assert.equal(e.requestId, "req-from-body");
    assert.ok(e.message.includes("req-from-body") && e.message.includes("hint:"));
    return true;
  });
});

for (const [status, Cls] of [[400, BadRequestError], [422, BadRequestError], [404, NotFoundError], [410, NotFoundError], [409, ConflictError], [500, InternalServerError]]) {
  test(`status ${status} is ${Cls.name}`, async () => {
    stub.on("GET", `${API}/videos/${TASK}`, { status, body: { error: "nope", field: "task_id" }, headers: { "X-Request-ID": "h" } });
    await assert.rejects(makeClient().getVideo(TASK, { maxRetries: 0 }), (e) => e instanceof Cls && e.requestId === "h" && e.field === "task_id");
  });
}

// ------------------------------------------------------------------ waitForVideo

test("waitForVideo sleeps poll_after_s until completed", async () => {
  stub.on(
    "GET",
    `${API}/videos/${TASK}`,
    { body: video("planning", { poll_after_s: 10 }) },
    { body: video("generating", { poll_after_s: 30 }) },
    { body: video("rendering", { poll_after_s: 15 }) },
    { body: video("completed", { poll_after_s: null, video_url: "https://cdn/x.mp4" }) },
  );
  const seen = [];
  const done = await makeClient().waitForVideo(TASK, { onUpdate: (v) => seen.push(v.phase) });
  assert.equal(done.video_url, "https://cdn/x.mp4");
  assert.deepEqual(sleeps, [10000, 30000, 15000]);
  assert.deepEqual(seen, ["planning", "generating", "rendering", "completed"]);
});

test("waitForVideo resolves at plan_ready", async () => {
  stub.on("GET", `${API}/videos/${TASK}`, { body: video("planning", { poll_after_s: 10 }) }, { body: video("plan_ready", { poll_after_s: null }) });
  assert.equal((await makeClient().waitForVideo(TASK)).phase, "plan_ready");
});

test("waitForVideo rejects on failed", async () => {
  stub.on("GET", `${API}/videos/${TASK}`, { body: video("failed", { poll_after_s: null, error: { code: "engine", message: "render failed" } }) });
  await assert.rejects(makeClient().waitForVideo(TASK), (e) => e instanceof VideoFailedError && e.phase === "failed" && /render failed/.test(e.message));
});

test("waitForVideo times out without oversleeping", async () => {
  stub.on("GET", `${API}/videos/${TASK}`, { body: video("generating", { poll_after_s: 30 }) });
  await assert.rejects(makeClient().waitForVideo(TASK, { timeoutMs: 70000 }), (e) => e instanceof WaitTimeoutError && e.video.phase === "generating");
  assert.deepEqual(sleeps, [30000, 30000, 10000]);
});

test("waitForVideo falls back per phase without poll_after_s", async () => {
  stub.on("GET", `${API}/videos/${TASK}`, { body: video("planning") }, { body: video("generating") }, { body: video("completed") });
  assert.equal((await makeClient().waitForVideo(TASK)).phase, "completed");
  assert.deepEqual(sleeps, [10000, 30000]);
});

test("waitForVideo pollIntervalMs overrides", async () => {
  stub.on("GET", `${API}/videos/${TASK}`, { body: video("generating", { poll_after_s: 30 }) }, { body: video("completed", { poll_after_s: null }) });
  await makeClient().waitForVideo(TASK, { pollIntervalMs: 5000 });
  assert.deepEqual(sleeps, [5000]);
});

// ------------------------------------------------------------------ shapes

test("download returns the redirect Location", async () => {
  stub.on("GET", `${API}/video/${TASK}/download`, { status: 302, headers: { Location: "https://cdn/v.mp4" } });
  assert.equal(await makeClient().downloadVideo(TASK), "https://cdn/v.mp4");
});

test("delete resolves undefined", async () => {
  stub.on("DELETE", `${API}/webhooks/5`, { status: 204 });
  assert.equal(await makeClient().deleteWebhook(5), undefined);
});

test("multipart upload sends the file", async () => {
  stub.on("POST", `${API}/uploads`, { status: 201, body: { url: "https://cdn/u.png" } });
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "cat.png", { type: "image/png" });
  await makeClient().uploadFile({ file, kind: "image" });
  const call = stub.calls()[0];
  assert.ok(call.headers["content-type"].startsWith("multipart/form-data"));
  const text = call.body.toString("latin1");
  assert.ok(text.includes('filename="cat.png"') && text.includes("\x89PNG"));
  assert.ok(text.includes('name="kind"') && text.includes("image"));
});

test("query parameters go in the URL, not the body", async () => {
  stub.on("GET", `${API}/video/status`, { body: { status: "completed" } });
  await makeClient().getVideoTaskStatus({ task_id: TASK });
  assert.deepEqual(stub.calls()[0].query, { task_id: TASK });
  assert.equal(stub.calls()[0].body.length, 0);
});

test("left-out fields are not sent and null is sent", async () => {
  stub.on("POST", `${API}/videos`, { status: 202, body: video("planning") });
  await makeClient().createVideo({ brief: "x", voice_id: null, style_id: undefined });
  assert.deepEqual(JSON.parse(stub.calls()[0].body), { brief: "x", voice_id: null });
});

test("path parameters are escaped", async () => {
  stub.on("GET", `${API}/videos/a%2Fb`, { body: video("completed") });
  await makeClient().getVideo("a/b");
  assert.equal(stub.calls()[0].path, `${API}/videos/a%2Fb`);
});

test("path parameters that would change the endpoint are refused before any request", async () => {
  for (const bad of ["", ".", ".."]) {
    await assert.rejects(makeClient().getVideo(bad), (e) => e instanceof ZebracatError && /Invalid task_id/.test(e.message));
  }
  assert.equal(stub.calls().length, 0);
});

test("every operation in the spec is a method; package and code versions agree", () => {
  const spec = JSON.parse(readFileSync(new URL("../openapi/openapi.json", import.meta.url), "utf8"));
  const ids = [];
  for (const item of Object.values(spec.paths)) for (const [m, op] of Object.entries(item)) if (["get", "post", "put", "patch", "delete"].includes(m)) ids.push(op.operationId);
  const camel = (s) => s.split("_").map((p, i) => (i ? p[0].toUpperCase() + p.slice(1) : p)).join("");
  const client = makeClient();
  const missing = ids.filter((id) => typeof client[camel(id)] !== "function");
  assert.deepEqual(missing, []);
  assert.equal(OPERATION_IDS.length, ids.length);
  assert.equal(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version, VERSION);
});
