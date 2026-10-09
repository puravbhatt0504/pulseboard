export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

// Access token lives in memory only; the refresh token is an httpOnly cookie the browser holds.
let accessToken: string | null = null;
export const getToken = () => accessToken;
export const setToken = (t: string | null) => void (accessToken = t);

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Refresh tokens rotate and reuse revokes every session, so concurrent callers must share one request.
let refreshing: Promise<boolean> | null = null;
export function refresh(): Promise<boolean> {
  refreshing ??= fetch(`${API_URL}/auth/refresh`, { method: "POST", credentials: "include" })
    .then(async (r) => {
      if (!r.ok) return false;
      setToken((await r.json()).accessToken);
      return true;
    })
    .catch(() => false)
    .finally(() => (refreshing = null));
  return refreshing;
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const send = () =>
    fetch(`${API_URL}${path}`, {
      method: opts.method ?? "GET",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  let res = await send();
  // Silent refresh: no token yet (page reload) or expired → refresh once and retry.
  if (res.status === 401 && !path.startsWith("/auth/") && (await refresh())) res = await send();
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error ?? res.statusText);
  return (res.status === 204 ? undefined : await res.json()) as T;
}
