/** Typed errors. Every error that came from the API carries the `requestId` to quote to support. */

export class ZebracatError extends Error {
  requestId: string | undefined;
  constructor(message: string, requestId?: string) {
    super(message);
    this.name = new.target.name;
    this.requestId = requestId;
  }
}

/** The request never got an HTTP answer (DNS, refused connection, reset). */
export class APIConnectionError extends ZebracatError {
  override cause: unknown;
  constructor(message: string, requestId?: string, cause?: unknown) {
    super(message, requestId);
    this.cause = cause;
  }
}

/** The HTTP attempt timed out. */
export class APITimeoutError extends APIConnectionError {}

/** The public error envelope, as the API sends it. */
export interface ErrorBody {
  error?: string;
  code?: string;
  type?: string;
  field?: string;
  hint?: string;
  docs_url?: string;
  retryable?: boolean;
  allowed_values?: unknown[];
  errors?: Record<string, unknown>[];
  request_id?: string;
  topup_url?: string;
  upgrade_url?: string;
  [key: string]: unknown;
}

/** The API answered with an error status. The fields mirror the public error envelope. */
export class APIError extends ZebracatError {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
  /** Machine-readable slug, e.g. `insufficient_balance` or `invalid_choice`. */
  readonly code: string | undefined;
  /** Error class: `invalid_request`, `authentication`, `insufficient_funds`, `rate_limited`, … */
  readonly type: string | undefined;
  readonly field: string | undefined;
  readonly hint: string | undefined;
  readonly docsUrl: string | undefined;
  readonly retryable: boolean | undefined;
  readonly allowedValues: unknown[] | undefined;
  readonly errors: Record<string, unknown>[];
  /** Where to add credit (402), when the API names it. */
  readonly topupUrl: string | undefined;
  /** Where to upgrade the plan (403), when the API names it. */
  readonly upgradeUrl: string | undefined;

  constructor(message: string, init: { status: number; body?: unknown; headers?: Record<string, string>; requestId?: string }) {
    const data: ErrorBody = init.body && typeof init.body === "object" ? (init.body as ErrorBody) : {};
    let text = `${init.status} ${message}`;
    if (data.hint) text += ` (hint: ${data.hint})`;
    if (init.requestId) text += ` [request_id=${init.requestId}]`;
    super(text, init.requestId);
    this.status = init.status;
    this.body = init.body;
    this.headers = init.headers ?? {};
    this.code = data.code;
    this.type = data.type;
    this.field = data.field;
    this.hint = data.hint;
    this.docsUrl = data.docs_url;
    this.retryable = data.retryable;
    this.allowedValues = data.allowed_values;
    this.errors = data.errors ?? [];
    this.topupUrl = data.topup_url;
    this.upgradeUrl = data.upgrade_url;
  }
}

/** 400 or 422: the request is invalid. `field`, `allowedValues` and `errors` say what to fix. */
export class BadRequestError extends APIError {}
/** 401: the API key or access token is missing, wrong, revoked or expired. */
export class AuthenticationError extends APIError {}
/** 402: not enough balance or credits. `topupUrl` is where to add more. */
export class InsufficientFundsError extends APIError {}
/** 403: the plan, the token scope or the account does not allow this. `upgradeUrl` when a plan would. */
export class PermissionDeniedError extends APIError {}
/** 404 or 410: no such object of yours. */
export class NotFoundError extends APIError {}
/** 409: the object is not in a state that allows this yet. */
export class ConflictError extends APIError {}
/** 5xx: the API failed or is unavailable. Safe calls were already retried. */
export class InternalServerError extends APIError {}
/** 429: too many requests, or a daily cap. `retryAfter` is the wait in seconds the API asked for. */
export class RateLimitError extends APIError {
  readonly retryAfter: number | undefined;
  constructor(message: string, init: { status: number; body?: unknown; headers?: Record<string, string>; requestId?: string; retryAfter?: number }) {
    super(message, init);
    this.retryAfter = init.retryAfter;
  }
}

/** `waitForVideo`: the video ended `failed` or `cancelled`. `video` is the last answer. */
export class VideoFailedError extends ZebracatError {
  readonly video: Record<string, unknown>;
  readonly phase: unknown;
  readonly error: unknown;
  constructor(message: string, video: Record<string, unknown>) {
    super(message);
    this.video = video;
    this.phase = video.phase;
    this.error = video.error;
  }
}

/** `waitForVideo`: the timeout passed first. `video` is the last answer; the job keeps running. */
export class WaitTimeoutError extends ZebracatError {
  readonly video: Record<string, unknown> | undefined;
  constructor(message: string, video?: Record<string, unknown>) {
    super(message);
    this.video = video;
  }
}

const BY_STATUS: Record<number, typeof APIError> = {
  400: BadRequestError,
  401: AuthenticationError,
  402: InsufficientFundsError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  410: NotFoundError,
  422: BadRequestError,
};

/** @internal */
export function makeAPIError(status: number, body: unknown, headers: Record<string, string>, requestId: string | undefined, retryAfter: number | undefined): APIError {
  const message = messageOf(body, status);
  if (status === 429) return new RateLimitError(message, { status, body, headers, requestId, retryAfter });
  const Cls = BY_STATUS[status] ?? (status >= 500 ? InternalServerError : BadRequestError);
  return new Cls(message, { status, body, headers, requestId });
}

function messageOf(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const data = body as Record<string, unknown>;
    for (const key of ["error", "detail", "message", "error_description"]) {
      const value = data[key];
      if (typeof value === "string" && value) return value;
      if (value && typeof value === "object" && typeof (value as Record<string, unknown>).error === "string") {
        return (value as Record<string, string>).error as string;
      }
    }
  }
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 500);
  return `HTTP ${status}`;
}
