// The hand-written layer over the generated operations: auth, retries, idempotency keys, typed errors and
// waitForVideo.

import { APIConnectionError, APITimeoutError, AuthenticationError, VideoFailedError, WaitTimeoutError, ZebracatError, makeAPIError } from "./errors.js";
import { GeneratedOperations, OPERATIONS } from "./generated/operations.js";
import type { components } from "./generated/schema.js";
import type { OperationMeta, RequestArgs, RequestOptions } from "./types.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.zebracat.ai";
const TOKEN_PATH = "/api/oauth/token";

/** Statuses worth another attempt. A 429 is always retried; a 5xx only when resending cannot do the work twice. */
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
/** waitForVideo on an API that does not send `poll_after_s` yet: seconds per phase. */
const FALLBACK_POLL_S: Record<string, number> = { planning: 10, generating: 30, rendering: 15 };
/** Phases where nothing changes until the caller acts (or ever): waitForVideo returns. */
const STOP_PHASES = new Set(["completed", "plan_ready", "needs_input"]);
const FAILED_PHASES = new Set(["failed", "cancelled"]);

export type TaskView = components["schemas"]["TaskView"];

/** The tokens the OAuth token endpoint answered. */
export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  [key: string]: unknown;
}

export interface ClientOptions {
  /** API key (`X-API-KEY`, billed from the API balance). Defaults to the ZEBRACAT_API_KEY environment variable. */
  apiKey?: string;
  /** OAuth access token (`Authorization: Bearer zoa_…`, billed from the account's plan credits). */
  accessToken?: string;
  /** With `clientId`: on a 401 the client swaps it for a new pair once and repeats the call. */
  refreshToken?: string;
  clientId?: string;
  /** Only for confidential OAuth clients. */
  clientSecret?: string;
  /** Receives the new tokens after a refresh, so you can store them. */
  onTokenRefresh?: (tokens: OAuthTokens) => void | Promise<void>;
  /** Defaults to ZEBRACAT_BASE_URL, else https://api.zebracat.ai. */
  baseURL?: string;
  /** Milliseconds before one HTTP attempt times out (default 60 000). */
  timeoutMs?: number;
  /** Retries after the first attempt (default 3). */
  maxRetries?: number;
  /** A 429 or 5xx asking to wait longer than this (ms, default 60 000) is thrown instead of waited out. */
  maxRetryWaitMs?: number;
  defaultHeaders?: Record<string, string>;
  /** A fetch implementation (default: the global fetch, Node 18+). */
  fetch?: typeof fetch;
}

export interface WaitOptions {
  /** Give up after this many milliseconds (default 30 minutes). The video keeps going. */
  timeoutMs?: number;
  /** Override the API's `poll_after_s` (milliseconds). */
  pollIntervalMs?: number;
  /** Called with every answer. */
  onUpdate?: (video: TaskView) => void;
  signal?: AbortSignal;
}

function env(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name] || undefined;
}

function newId(): string {
  return globalThis.crypto.randomUUID().split("-").join("");
}

/**
 * Client for the Zebracat public API.
 *
 * ```ts
 * const client = new Zebracat();                               // reads ZEBRACAT_API_KEY
 * const client = new Zebracat({ apiKey: "sk-…" });
 * const client = new Zebracat({ accessToken: "zoa_…", refreshToken: "zor_…", clientId: "…", onTokenRefresh: save });
 * ```
 *
 * Every API operation is a method named after its operationId in camelCase (`createVideo`, `getVideo`, …).
 */
export class Zebracat extends GeneratedOperations {
  apiKey: string | undefined;
  accessToken: string | undefined;
  refreshToken: string | undefined;
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
  readonly baseURL: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly maxRetryWaitMs: number;
  private readonly onTokenRefresh: ClientOptions["onTokenRefresh"];
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private refreshing: Promise<void> | undefined;
  /** @internal Test seams: replaced by the test suite to skip real waiting. */
  _sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
  /** @internal */
  _now: () => number = () => Date.now();

  constructor(options: ClientOptions = {}) {
    super();
    let apiKey = options.apiKey;
    if (apiKey === undefined && options.accessToken === undefined) apiKey = env("ZEBRACAT_API_KEY");
    if (apiKey && options.accessToken) throw new ZebracatError("Pass either apiKey or accessToken, not both.");
    if (!apiKey && !options.accessToken) {
      throw new ZebracatError("No credentials: pass { apiKey } (or set ZEBRACAT_API_KEY), or { accessToken } for OAuth.");
    }
    if (options.refreshToken && !options.clientId) throw new ZebracatError("refreshToken needs the OAuth clientId it was issued to.");
    this.apiKey = apiKey;
    this.accessToken = options.accessToken;
    this.refreshToken = options.refreshToken;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.onTokenRefresh = options.onTokenRefresh;
    let base = options.baseURL ?? env("ZEBRACAT_BASE_URL") ?? DEFAULT_BASE_URL;
    while (base.endsWith("/")) base = base.slice(0, -1);
    this.baseURL = base;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.maxRetryWaitMs = options.maxRetryWaitMs ?? 60_000;
    this.defaultHeaders = options.defaultHeaders ?? {};
    const f = options.fetch ?? globalThis.fetch;
    if (!f) throw new ZebracatError("No fetch available: use Node 18+ or pass { fetch }.");
    this.fetchImpl = f.bind(globalThis);
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { "X-API-KEY": this.apiKey } : { Authorization: `Bearer ${this.accessToken}` };
  }

  private static safeToResend(op: OperationMeta): boolean {
    return SAFE_METHODS.has(op.method) || op.replaysIdempotencyKey;
  }

  protected async request<T>(op: OperationMeta, args: RequestArgs): Promise<T> {
    const opts = args.options ?? {};
    let path = op.path;
    for (const [name, value] of Object.entries(args.path)) {
      const text = String(value);
      // "", "." and ".." would resolve to another endpoint once the URL is normalized: refuse them.
      if (text === "" || text === "." || text === "..") throw new ZebracatError(`Invalid ${name}: ${JSON.stringify(text)}`);
      path = path.split(`{${name}}`).join(encodeURIComponent(text));
    }
    const { query, body } = splitParams(op, args.params);
    const url = new URL(this.baseURL + path);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
    const requestId = newId();
    const headers: Record<string, string> = {
      "User-Agent": `zebracat-node/${VERSION}`,
      Accept: "application/json",
      "X-Request-ID": requestId,
      ...this.defaultHeaders,
    };
    if (op.paid) headers["Idempotency-Key"] = opts.idempotencyKey ?? `zc-${newId()}`;
    Object.assign(headers, opts.headers ?? {});
    const maxRetries = opts.maxRetries ?? this.maxRetries;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;

    let attempt = 0;
    let refreshed = false;
    for (;;) {
      const sentToken = this.accessToken;
      const encoded = await encodeBody(op, body);
      let response: Response;
      try {
        response = await this.send(url, {
          method: op.method,
          headers: { ...headers, ...encoded.headers, ...this.authHeaders() },
          body: encoded.body,
          redirect: "manual",
        }, timeoutMs, opts.signal);
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        const timedOut = err instanceof APITimeoutError;
        const neverSent = !timedOut && isConnectRefused(err);
        if (attempt < maxRetries && (neverSent || Zebracat.safeToResend(op))) {
          attempt += 1;
          await this._sleep(backoffMs(attempt));
          continue;
        }
        if (timedOut) throw new APITimeoutError((err as Error).message, requestId);
        throw new APIConnectionError(`${op.method} ${op.path} failed: ${(err as Error)?.message ?? err}`, requestId, err);
      }

      if (response.status === 401 && this.refreshToken && !refreshed) {
        refreshed = true;
        await response.body?.cancel();
        await this.refresh(sentToken);
        continue;
      }
      if (RETRY_STATUSES.has(response.status) && attempt < maxRetries && (response.status === 429 || Zebracat.safeToResend(op))) {
        const wait = this.retryWaitMs(response, attempt + 1);
        if (wait !== undefined) {
          await response.body?.cancel();
          attempt += 1;
          await this._sleep(wait);
          continue;
        }
      }
      return (await parse(response, requestId)) as T;
    }
  }

  private async send(url: URL, init: RequestInit, timeoutMs: number, signal: AbortSignal | undefined): Promise<Response> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (timedOut) throw new APITimeoutError(`${init.method} ${url.pathname} timed out after ${timeoutMs} ms`);
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private retryWaitMs(response: Response, attempt: number): number | undefined {
    const after = retryAfterSeconds(response.headers.get("Retry-After"));
    if (after === undefined) return backoffMs(attempt);
    const ms = after * 1000;
    return ms <= this.maxRetryWaitMs ? ms : undefined;
  }

  /** Swap the refresh token for a new pair (the API rotates both). Concurrent 401s share one refresh. */
  private async refresh(sentToken: string | undefined): Promise<void> {
    if (this.accessToken !== sentToken) return;
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.refreshToken ?? "", client_id: this.clientId ?? "" });
    if (this.clientSecret) form.set("client_secret", this.clientSecret);
    let response: Response;
    try {
      response = await this.send(new URL(this.baseURL + TOKEN_PATH), {
        method: "POST",
        headers: { "User-Agent": `zebracat-node/${VERSION}`, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }, this.timeoutMs, undefined);
    } catch (err) {
      throw new APIConnectionError(`OAuth token refresh failed: ${(err as Error)?.message ?? err}`, undefined, err);
    }
    const body = await readBody(response);
    const tokens = body as OAuthTokens | undefined;
    if (response.status !== 200 || !tokens || typeof tokens !== "object" || !tokens.access_token) {
      throw new AuthenticationError("The access token expired and the refresh token was refused: sign in again.", {
        status: response.status,
        body,
        headers: headersOf(response),
        requestId: response.headers.get("X-Request-ID") ?? undefined,
      });
    }
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token ?? this.refreshToken;
    await this.onTokenRefresh?.(tokens);
  }

  /**
   * Read `getVideo` until the video stops changing on its own, waiting `poll_after_s` between reads.
   *
   * Resolves when the phase is `completed` (`video_url` is the file), `plan_ready` (a plan made with
   * `auto_generate: false`: show the quote, call `generateVideo`, then wait again) or `needs_input` (answer
   * `question` with `answerVideoQuestion`). Rejects with VideoFailedError when it ends `failed` or `cancelled`, and
   * WaitTimeoutError after `timeoutMs` (the video keeps going; wait again later).
   */
  async waitForVideo(taskId: string, options: WaitOptions = {}): Promise<TaskView> {
    const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
    const deadline = this._now() + timeoutMs;
    for (;;) {
      const answer = await this.request<TaskView>(OPERATIONS.get_video, { path: { task_id: taskId }, params: undefined, options: { signal: options.signal } });
      options.onUpdate?.(answer);
      const video = answer as unknown as Record<string, unknown>;
      const phase = String(video.phase ?? "");
      if (FAILED_PHASES.has(phase)) {
        let reason = video.error as unknown;
        if (reason && typeof reason === "object") {
          const e = reason as Record<string, unknown>;
          reason = e.message ?? e.code;
        }
        throw new VideoFailedError(`Video ${taskId} ${phase}${reason ? `: ${reason}` : ""}`, video);
      }
      let waitS: number;
      if ("poll_after_s" in video) {
        if (video.poll_after_s === null || video.poll_after_s === undefined) return answer;
        waitS = Number(video.poll_after_s);
      } else if (STOP_PHASES.has(phase)) {
        return answer;
      } else {
        waitS = FALLBACK_POLL_S[phase] ?? 15;
      }
      let waitMs = options.pollIntervalMs ?? waitS * 1000;
      const remaining = deadline - this._now();
      if (remaining <= 0) throw new WaitTimeoutError(`Video ${taskId} is still ${phase} after ${timeoutMs} ms.`, video);
      waitMs = Math.max(1000, Math.min(waitMs, remaining));
      await this._sleep(waitMs);
    }
  }
}

// ------------------------------------------------------------------ helpers

function splitParams(op: OperationMeta, params: unknown): { query: Record<string, unknown>; body: Record<string, unknown> | undefined } {
  if (params === undefined || params === null) return { query: {}, body: undefined };
  const all = params as Record<string, unknown>;
  if (op.wrapped) return { query: (all.query as Record<string, unknown>) ?? {}, body: all.body as Record<string, unknown> };
  const query: Record<string, unknown> = {};
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) {
    if (v === undefined) continue;
    if (op.query.includes(k)) query[k] = v;
    else body[k] = v;
  }
  return { query, body: op.body ? body : undefined };
}

async function encodeBody(op: OperationMeta, body: Record<string, unknown> | undefined): Promise<{ body?: BodyInit; headers: Record<string, string> }> {
  if (!op.body || body === undefined) return { headers: {} };
  if (op.body === "json") return { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } };
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    if (value instanceof Blob) {
      const name = (value as Blob & { name?: string }).name || "upload";
      form.append(key, value, name);
    } else if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      form.append(key, new Blob([value as BlobPart]), "upload");
    } else if (typeof value === "object") {
      form.append(key, JSON.stringify(value));
    } else {
      form.append(key, String(value));
    }
  }
  return { body: form, headers: {} };
}

function headersOf(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function parse(response: Response, requestId: string): Promise<unknown> {
  const status = response.status;
  if (status >= 400) {
    const body = await readBody(response);
    const fromBody = body && typeof body === "object" ? ((body as Record<string, unknown>).request_id as string | undefined) : undefined;
    const rid = fromBody || response.headers.get("X-Request-ID") || requestId;
    throw makeAPIError(status, body, headersOf(response), rid, retryAfterSeconds(response.headers.get("Retry-After")));
  }
  if (status >= 300 && status < 400) {
    await response.body?.cancel();
    return response.headers.get("Location") ?? undefined;
  }
  return readBody(response);
}

/** `Retry-After` as seconds: a number, or an HTTP date. */
export function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const n = Number(trimmed);
  if (trimmed !== "" && Number.isFinite(n)) return Math.max(0, n);
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, (when - Date.now()) / 1000);
}

/** 500 ms, 1 s, 2 s, … capped at 8 s, minus up to 25 % jitter. */
function backoffMs(attempt: number): number {
  const base = Math.min(8000, 500 * 2 ** (attempt - 1));
  return base * (1 - 0.25 * Math.random());
}

function isConnectRefused(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } })?.cause;
  return cause?.code === "ECONNREFUSED" || cause?.code === "ENOTFOUND" || cause?.code === "EAI_AGAIN";
}
