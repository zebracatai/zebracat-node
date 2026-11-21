/** One API operation, as the generator read it from the OpenAPI document. */
export interface OperationMeta {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  /** "json", "multipart", "binary" (the raw bytes of one file) or null (no request body). */
  readonly body: "json" | "multipart" | "binary" | null;
  /** Names of the query parameters; every other key of `params` goes in the body. */
  readonly query: readonly string[];
  /** `params` is `{ body, query }` (a body field shares a query parameter's name). */
  readonly wrapped: boolean;
  /** A POST that spends money: it carries an `Idempotency-Key`. */
  readonly paid: boolean;
  /** The server answers a repeated `Idempotency-Key` with the first answer, so a 5xx may be retried. */
  readonly replaysIdempotencyKey: boolean;
  readonly deprecated: boolean;
  /** Sends the API key or access token. False for an operation the API serves without credentials. */
  readonly auth: boolean;
}

/** Per-call overrides. */
export interface RequestOptions {
  /** Milliseconds before one HTTP attempt times out. */
  timeoutMs?: number;
  /** Retries after the first attempt (429 and 5xx, see the README). */
  maxRetries?: number;
  /** Extra headers for this call. */
  headers?: Record<string, string>;
  /** The `Idempotency-Key` of a paid POST. Without one, the SDK makes one per call. */
  idempotencyKey?: string;
  /** Cancels the call (and its retries). */
  signal?: AbortSignal;
}

/** @internal */
export interface RequestArgs {
  path: Record<string, string | number>;
  params: unknown;
  options: RequestOptions | undefined;
}
