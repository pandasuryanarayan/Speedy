/**
 * API client: bearer access token in memory only (never localStorage), refresh
 * token lives in an httpOnly cookie, CSRF token in a readable cookie.
 */
const CSRF_COOKIE = 'speedy_csrf';

let accessToken = null;
let refreshInFlight = null;

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const setAccessToken = (token) => {
  accessToken = token;
};
export const getAccessToken = () => accessToken;

function csrfToken() {
  const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : '';
}

async function raw(path, { method = 'GET', body, form, headers = {}, auth = true } = {}) {
  const options = {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...headers },
  };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  if (form) options.body = form;
  if (auth && accessToken) options.headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(path, options);
  const contentType = res.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    const err = payload?.error || {};
    throw new ApiError(res.status, err.code || `http_${res.status}`, err.message || 'Request failed', err.details);
  }
  return payload?.data ?? null;
}

export async function refreshSession() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const data = await raw('/api/auth/refresh', {
        method: 'POST',
        auth: false,
        headers: { 'X-CSRF-Token': csrfToken() },
      });
      accessToken = data.accessToken;
      return data;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export async function request(path, options = {}) {
  try {
    return await raw(path, options);
  } catch (err) {
    const canRetry =
      err instanceof ApiError &&
      err.status === 401 &&
      !options._retried &&
      !path.startsWith('/api/auth/refresh') &&
      !path.startsWith('/api/auth/login');
    if (!canRetry) throw err;
    try {
      await refreshSession();
    } catch {
      throw err;
    }
    return raw(path, { ...options, _retried: true });
  }
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  del: (path) => request(path, { method: 'DELETE' }),

  async upload(file) {
    const form = new FormData();
    form.append('file', file);
    const data = await request('/api/attachments', { method: 'POST', form });
    return data.attachment;
  },

  login: (body) => raw('/api/auth/login', { method: 'POST', body, auth: false }),
  register: (body) => raw('/api/auth/register', { method: 'POST', body, auth: false }),
  logout: async () => {
    try {
      await raw('/api/auth/logout', { method: 'POST' });
    } finally {
      accessToken = null;
    }
  },
  me: () => request('/api/auth/me'),
};

export default api;
