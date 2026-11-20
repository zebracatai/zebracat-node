export { Zebracat, DEFAULT_BASE_URL, retryAfterSeconds } from "./client.js";
export type { ClientOptions, OAuthTokens, TaskView, WaitOptions } from "./client.js";
export {
  ZebracatError,
  APIConnectionError,
  APITimeoutError,
  APIError,
  BadRequestError,
  AuthenticationError,
  InsufficientFundsError,
  PermissionDeniedError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  InternalServerError,
  VideoFailedError,
  WaitTimeoutError,
} from "./errors.js";
export type { ErrorBody } from "./errors.js";
export type { OperationMeta, RequestOptions } from "./types.js";
export { OPERATIONS, OPERATION_IDS } from "./generated/operations.js";
export type { components, operations, paths } from "./generated/schema.js";
export { VERSION } from "./version.js";
export { Zebracat as default } from "./client.js";

import type { components } from "./generated/schema.js";
/** Every schema of the API by name, e.g. `Schemas["TaskView"]`. */
export type Schemas = components["schemas"];
