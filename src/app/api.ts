/**
 * Fetch wrapper for the app's own API.
 *
 * The admin password (when the deployment has one) lives in sessionStorage and is
 * attached to every request as x-admin-password. A 401 with admin_password_invalid
 * notifies the App so it can raise the password gate — components never handle
 * authentication themselves.
 */

import type { ApiErrorBody } from '../shared/types';

const PASSWORD_KEY = 'adminPassword';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export const getStoredPassword = (): string => sessionStorage.getItem(PASSWORD_KEY) ?? '';
export const setStoredPassword = (value: string): void => {
  if (value) sessionStorage.setItem(PASSWORD_KEY, value);
  else sessionStorage.removeItem(PASSWORD_KEY);
};

let unauthorizedHandler: (() => void) | null = null;
/** App registers once; fired whenever any call bounces off the password gate. */
export const onUnauthorized = (handler: (() => void) | null): void => {
  unauthorizedHandler = handler;
};

export function authHeaders(): Record<string, string> {
  const password = getStoredPassword();
  return password ? { 'x-admin-password': password } : {};
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...authHeaders(),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      /* not JSON */
    }
    const code = body?.error?.code ?? 'request_failed';
    const message = body?.error?.message ?? `Request failed with HTTP ${response.status}.`;
    if (response.status === 401 && code === 'admin_password_invalid') unauthorizedHandler?.();
    throw new ApiError(response.status, code, message);
  }
  return (await response.json()) as T;
}
