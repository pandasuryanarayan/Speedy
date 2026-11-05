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

/** Fetch an attachment with the bearer token and hand back a blob URL. */
export async function fetchAttachmentBlob(attachmentId, { retry = true } = {}) {
  const res = await fetch(`/api/attachments/${attachmentId}`, {
    credentials: 'same-origin',
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  });
  if (res.status === 401 && retry) {
    await refreshSession();
    return fetchAttachmentBlob(attachmentId, { retry: false });
  }
  if (!res.ok) throw new ApiError(res.status, 'attachment_failed', 'That file could not be loaded');
  return res.blob();
}

/**
 * Save a file through the API instead of navigating to its URL. This keeps the
 * bearer token in play, so an expired or stripped link in the DOM can never
 * turn a click into an "unauthorized" page.
 */
export async function downloadAttachment(attachment) {
  const blob = await fetchAttachmentBlob(attachment.id);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = attachment.name || 'download';
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Downloads the account export as a file, authenticated like everything else. */
export async function exportMyData() {
  const res = await fetch('/api/users/me/export', {
    credentials: 'same-origin',
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  });
  if (!res.ok) throw new ApiError(res.status, 'export_failed', 'Could not export your data');
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') || '';
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] || 'speedy-export.json';
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
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
  get: (path, options) => request(path, options),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
  patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  del: (path, body) => request(path, { method: 'DELETE', body }),

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
