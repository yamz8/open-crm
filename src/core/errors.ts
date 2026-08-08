/**
 * Every failure an API client can see is one of these. The `hint` field is not
 * decoration: an agent that gets "unknown field `company`" plus "did you mean
 * `company_id`?" fixes its own call instead of retrying the same mistake.
 */
export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'precondition_failed'
  | 'rate_limited'
  | 'idempotency_mismatch'
  | 'internal_error';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
  rate_limited: 429,
  idempotency_mismatch: 409,
  internal_error: 500,
};

export type AppErrorOptions = {
  hint?: string;
  details?: unknown;
  cause?: unknown;
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly hint: string | undefined;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.hint = options.hint;
    this.details = options.details;
  }

  toJSON(): { error: { code: ErrorCode; message: string; hint?: string; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint ? { hint: this.hint } : {}),
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export const badRequest = (message: string, options?: AppErrorOptions): AppError =>
  new AppError('bad_request', message, options);

export const notFound = (entity: string, id: string): AppError =>
  new AppError('not_found', `${entity} ${id} was not found`, {
    hint: `Verify the id, or list ${entity}s to find the right one. Archived records are hidden unless you pass include_archived=true.`,
  });

export const unauthorized = (message = 'Authentication required'): AppError =>
  new AppError('unauthorized', message, {
    hint: 'Send an API token as "Authorization: Bearer <token>", or sign in to get a session cookie.',
  });

export const forbidden = (message: string, options?: AppErrorOptions): AppError =>
  new AppError('forbidden', message, options);

export const conflict = (message: string, options?: AppErrorOptions): AppError =>
  new AppError('conflict', message, options);

export const validationFailed = (message: string, details: unknown, hint?: string): AppError =>
  new AppError('validation_failed', message, { details, ...(hint ? { hint } : {}) });

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
