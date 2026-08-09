export type ApiError = {
  code: string;
  message: string;
  hint?: string;
  details?: unknown;
};

export class RequestFailed extends Error {
  readonly status: number;
  readonly error: ApiError;
  constructor(status: number, error: ApiError) {
    super(error.message);
    this.name = 'RequestFailed';
    this.status = status;
    this.error = error;
  }
}

/**
 * The browser client authenticates with the session cookie; agents use bearer
 * tokens against the same endpoints. There is no separate "internal" API.
 */
async function request<T = any>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'open-crm-web', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error: ApiError = payload?.error ?? {
      code: 'internal_error',
      message: `Request failed with status ${response.status}`,
    };
    throw new RequestFailed(response.status, error);
  }
  return payload as T;
}

export const api = {
  get: <T = any>(path: string) => request<T>('GET', path),
  post: <T = any>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>('POST', path, body, headers),
  patch: <T = any>(path: string, body: unknown, headers?: Record<string, string>) =>
    request<T>('PATCH', path, body, headers),
  delete: <T = any>(path: string) => request<T>('DELETE', path),
};

export function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}
