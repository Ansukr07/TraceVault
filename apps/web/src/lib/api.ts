// Access token lives in memory only; the refresh token is an httpOnly cookie.
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;

export type OfficerProfile = {
  agency: string;
  unit: string;
  rank?: string;
  badgeId: string;
  verified?: boolean;
  rejected?: boolean;
};

export type User = {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  accountType?: 'citizen' | 'officer' | 'official';
  officer?: OfficerProfile;
  uiLanguage?: string;
  voiceLanguage?: string;
};
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const setToken = (t: string | null) => { accessToken = t; };
export const getToken = () => accessToken;

async function refresh(): Promise<boolean> {
  refreshing ??= fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' })
    .then(async (r) => {
      if (!r.ok) return false;
      accessToken = (await r.json()).accessToken;
      return true;
    })
    .catch(() => false)
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function api<T = any>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const r = await fetch(`/api/v1${path}`, { ...init, headers, credentials: 'include' });
  if (r.status === 401 && retry && !path.startsWith('/auth/') && (await refresh())) return api<T>(path, init, false);
  if (r.status === 204) return undefined as T;
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new ApiError(r.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? r.statusText);
  return data as T;
}

export const post = <T = any>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
export const patch = <T = any>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) });
export const del = <T = any>(path: string, body?: unknown) => api<T>(path, { method: 'DELETE', body: body === undefined ? undefined : JSON.stringify(body) });

/** Try to restore a session from the refresh cookie on page load. */
export async function restoreSession(): Promise<User | null> {
  if (!(await refresh())) return null;
  return (await api<{ user: User }>('/me')).user;
}
