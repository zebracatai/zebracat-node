# Zebracat TypeScript / JavaScript SDK

The official client for the [Zebracat API](https://api.zebracat.ai/docs): make videos with AI from a brief, a script
or a link, then read, quote, generate and download them. Fully typed from our OpenAPI document; no runtime
dependencies (uses the built-in `fetch`).

```bash
npm install @zebracat/sdk
```

Node.js 20 or newer. ES modules and CommonJS both work.

## Quickstart

Create an API key at <https://zebracat.ai/api> and export it:

```bash
export ZEBRACAT_API_KEY=sk-...
```

```ts
import { Zebracat } from "@zebracat/sdk";

const client = new Zebracat(); // reads ZEBRACAT_API_KEY

// 1. Plan a video. Planning is free; nothing is charged until you generate.
const started = await client.createVideo({
  brief: "How bees make honey",
  auto_generate: false,
  options: { seconds: 30, aspect: "vertical", media_type: "ai_video" },
});
if (!("task_id" in started)) throw new Error("dry_run answers a quote, not a video");

// 2. Wait for the plan, then look at the price.
const planned = await client.waitForVideo(started.task_id); // resolves at plan_ready
console.log(await client.quoteVideo(planned.task_id));

// 3. Generate it (this spends credit) and wait for the file.
await client.generateVideo(planned.task_id);
const done = await client.waitForVideo(planned.task_id); // resolves at completed
console.log(done.video_url);
```

Pass `auto_generate: true` to plan and generate in one call; `waitForVideo` then resolves once the video is done.
(This quickstart is type-checked in CI: [examples/quickstart.ts](examples/quickstart.ts).)

## Every operation is a method

Each operation of the [OpenAPI document](openapi/openapi.json) is a method named after its `operationId` in
camelCase: `createVideo`, `getVideo`, `listVideos`, `quoteVideo`, `generateVideo`, `cloneVideo`, `translateVideo`,
`listVoices`, `listTemplates`, `uploadFile`, `createUploadLink`, `createWebhook`, `listCapabilities`, `getAccount`,
and the rest.

- Path parameters come first: `client.getVideo("6f1c…")`.
- Then one object with the body fields and query parameters, named as in the API (`snake_case`):
  `client.createVideo({ brief: "…", auto_generate: true })`.
- Then per-call options: `{ timeoutMs, maxRetries, headers, idempotencyKey, signal }`.
- Answers are the API's JSON, typed. Every schema is exported: `import type { Schemas } from "@zebracat/sdk"`,
  then `Schemas["TaskView"]`.
- Files (`uploadFile`, `createCloneVoice`) take a `Blob` or `File`; `uploadToLink` also takes a `Uint8Array`.
- Operations the API marks deprecated still work and are marked `@deprecated` for your editor.

## Uploading a file

`uploadFile` takes a picture in one call. For a video to translate, clone or swap, or a voice sample, use a one-time
upload link: `uploadWithLink` asks for the link (`createUploadLink`) and sends the file to it.

```ts
const stored = await client.uploadWithLink("talk.mp4", { use: "translate" }); // a local path, Blob or Uint8Array
const video = await client.translateVideo({ video_url: stored.url, target_language: "es" });
```

`use` is `picture`, `translate`, `clone`, `swap` or `voice_clone`; it sets the accepted types and the size cap.

## Authentication

```ts
new Zebracat({ apiKey: "sk-..." });       // X-API-KEY, billed from the API balance

new Zebracat({                            // OAuth: Authorization: Bearer zoa_..., billed from plan credits
  accessToken: "zoa_...",
  refreshToken: "zor_...",
  clientId: "your-oauth-client-id",
  clientSecret: undefined,                // only for confidential clients
  onTokenRefresh: (tokens) => save(tokens),
});
```

With a refresh token, a `401` makes the client swap it for a new pair once (`POST /api/oauth/token`, the API rotates
both tokens) and repeat the call; concurrent calls share one refresh. `onTokenRefresh` receives the new tokens so you
can store them.

`ZEBRACAT_BASE_URL` (or `baseURL`) points the client at another server.

## Retries

A call is repeated up to `maxRetries` times (default 3) when the API answers `429`, `500`, `502`, `503` or `504`, or
the connection drops:

- A `Retry-After` header is honoured. A wait longer than `maxRetryWaitMs` (default 60 s, e.g. a daily cap) is thrown
  as `RateLimitError` with `retryAfter` (seconds) instead of waited out.
- Without `Retry-After` the wait is 0.5 s, 1 s, 2 s… (at most 8 s) with jitter.
- A `429` is always retried: the API refused before doing anything.
- A `5xx` or a dropped connection is retried only when resending cannot do the work twice: reads, `PUT`, `DELETE`,
  and the paid POSTs whose server replays the first answer for a repeated `Idempotency-Key` (`createVideo`,
  `cloneVideo`, `translateVideo` and the v1 creators). Other POSTs throw at once, so a charge is never repeated.

## Idempotency keys

Every POST that spends money (it can answer `402`, or it buys credit) sends an `Idempotency-Key`. The SDK makes one
per call and reuses it across that call's retries. Pass your own to make a retry from your side safe too:

```ts
await client.createVideo({ brief: "…", auto_generate: true }, { idempotencyKey: `order-${orderId}` });
```

The same key with a different body answers `422 idempotency_key_reused`.

## Waiting for a video

`waitForVideo(taskId, { timeoutMs, pollIntervalMs, onUpdate, signal })` reads the video again after the
`poll_after_s` seconds the API gives (falling back to 10–30 s per phase on an API that does not send it). It resolves
when nothing more happens on its own:

| phase | what you do next |
|---|---|
| `completed` | `video_url` is the file; `downloadVideoFile(taskId)` resolves to the URL as well |
| `plan_ready` | show `quoteVideo(taskId)`, then `generateVideo(taskId)` and wait again |
| `needs_input` | answer `question` with `answerVideoQuestion(taskId, {...})` and wait again |

It rejects with `VideoFailedError` (`.video`, `.phase`, `.error`) when the video fails or is cancelled, and
`WaitTimeoutError` (`.video`) after `timeoutMs` (default 30 minutes); the video keeps going on our side.

## Errors

Every error from the API is a subclass of `APIError` and carries the public error envelope:

```ts
import { APIError, InsufficientFundsError, RateLimitError } from "@zebracat/sdk";

try {
  await client.generateVideo(taskId);
} catch (err) {
  if (err instanceof InsufficientFundsError) console.log("Add credit:", err.topupUrl);
  else if (err instanceof RateLimitError) console.log("Try again in", err.retryAfter, "s");
  else if (err instanceof APIError) console.log(err.status, err.code, err.hint, err.requestId);
  else throw err;
}
```

| status | class |
|---|---|
| 400, 422 | `BadRequestError` (`field`, `allowedValues`, `errors`) |
| 401 | `AuthenticationError` |
| 402 | `InsufficientFundsError` (`topupUrl`) |
| 403 | `PermissionDeniedError` (`upgradeUrl`) |
| 404, 410 | `NotFoundError` |
| 409 | `ConflictError` |
| 429 | `RateLimitError` (`retryAfter`) |
| 5xx | `InternalServerError` |
| no answer | `APIConnectionError`, `APITimeoutError` |

`requestId` is the id to quote to support: the API's `request_id` (also the `X-Request-ID` header). The SDK sends an
`X-Request-ID` of its own on every call, so even a connection error has one.

## Development

```bash
npm ci
npm run generate         # regenerate src/generated from openapi/openapi.json
npm run generate:check   # CI: fails when the generated code is out of date
npm run typecheck
npm test                 # builds, then runs against a local stub server (no network)
```

`openapi/openapi.json` comes from the backend: `python manage.py spectacular --format openapi-json --file
openapi.json` (or download `https://api.zebracat.ai/docs/openapi.json`). Copy it here, regenerate, commit both.

## Releasing

Bump `version` in `package.json` and `src/version.ts`, commit, tag `vX.Y.Z` and push the tag.
`.github/workflows/release.yml` tests, builds and publishes to npm with trusted publishing (GitHub OIDC, provenance;
no token is stored anywhere).
