/** Tiny DOM helpers. No framework, no innerHTML for user data. */

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'html') el.innerHTML = value; // trusted constants only (icons)
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value') el.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'selected') el[key] = Boolean(value);
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clear = (el) => {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
};

const ICONS = {
  send: '<path d="M4.5 11.5 20 4l-7.5 15.5-2-6.2-6-1.8Z"/><path d="m10.5 13.3 4-4"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m20 20-4.2-4.2"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  users: '<path d="M16 20v-1.8a4 4 0 0 0-4-4H6.5a4 4 0 0 0-4 4V20"/><circle cx="9.2" cy="7.4" r="3.6"/><path d="M21.5 20v-1.8a4 4 0 0 0-3-3.8"/><path d="M15.5 4a3.6 3.6 0 0 1 0 7"/>',
  user: '<path d="M19.5 20.5v-1.8a4 4 0 0 0-4-4h-7a4 4 0 0 0-4 4v1.8"/><circle cx="12" cy="7.2" r="3.7"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  back: '<path d="M19 12H5"/><path d="m11.5 18.5-6.5-6.5 6.5-6.5"/>',
  info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 16.2v-4.4"/><path d="M12 8.2h.01"/>',
  clip: '<path d="M20.5 11.6 12 20a5.6 5.6 0 0 1-8-8l8.4-8.3a3.7 3.7 0 0 1 5.3 5.3l-8.4 8.3a1.9 1.9 0 0 1-2.6-2.6l7.7-7.6"/>',
  smile: '<circle cx="12" cy="12" r="8.6"/><path d="M8.6 14.2a4.3 4.3 0 0 0 6.8 0"/><path d="M9.2 9.6h.01M14.8 9.6h.01"/>',
  check: '<path d="m20 6.5-11 11-5-5"/>',
  checks: '<path d="m1.5 12.8 3.8 3.8L13.6 8"/><path d="m9 12.8 3.8 3.8L22.4 8"/>',
  more: '<circle cx="12" cy="5.4" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="18.6" r="1.5"/>',
  trash: '<path d="M3.5 6.5h17"/><path d="M8.5 6.5V4.2h7v2.3"/><path d="M18.6 6.5 17.7 20H6.3L5.4 6.5"/><path d="M10 10.5v6M14 10.5v6"/>',
  edit: '<path d="M12 20.5h8.5"/><path d="M16.6 3.7a2 2 0 0 1 2.9 2.8L7.2 18.8l-4 1 1-4Z"/>',
  reply: '<path d="M9.5 17 4 12l5.5-5"/><path d="M20 18.5V16a4.5 4.5 0 0 0-4.5-4.5H4"/>',
  download: '<path d="M21 15.5v3.8a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 19.3v-3.8"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M12 15V3.5"/>',
  file: '<path d="M14 2.5H6.8A1.8 1.8 0 0 0 5 4.3v15.4a1.8 1.8 0 0 0 1.8 1.8h10.4a1.8 1.8 0 0 0 1.8-1.8V7.5Z"/><path d="M14 2.5v5h5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  logout: '<path d="M9.5 21H5.8A1.8 1.8 0 0 1 4 19.2V4.8A1.8 1.8 0 0 1 5.8 3h3.7"/><path d="m16 16.5 4.5-4.5L16 7.5"/><path d="M20.5 12H9.5"/>',
  shield: '<path d="M12 21.5s7.5-3.6 7.5-9.3V5.4L12 2.5 4.5 5.4v6.8c0 5.7 7.5 9.3 7.5 9.3Z"/><path d="m9 12 2.2 2.2L15.4 10"/>',
  chat: '<path d="M20.5 11.7a8 8 0 0 1-8.6 8 8.6 8.6 0 0 1-3.8-.9L3.5 20.5l1.8-4.4a8 8 0 0 1-.9-3.7 8 8 0 0 1 8-8 8 8 0 0 1 8.1 7.3Z"/>',
  camera: '<path d="M22 19.2a1.8 1.8 0 0 1-1.8 1.8H3.8A1.8 1.8 0 0 1 2 19.2V8.6a1.8 1.8 0 0 1 1.8-1.8h3.6l1.8-2.6h5.6l1.8 2.6h3.6A1.8 1.8 0 0 1 22 8.6Z"/><circle cx="12" cy="13.4" r="3.6"/>',
  userPlus: '<path d="M15.5 20.5v-1.8a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1.8"/><circle cx="8.8" cy="7.2" r="3.7"/><path d="M19 8v6M22 11h-6"/>',
  userMinus: '<path d="M15.5 20.5v-1.8a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1.8"/><circle cx="8.8" cy="7.2" r="3.7"/><path d="M22 11h-6"/>',
  crown: '<path d="M3 18.5h18"/><path d="m3 6.5 4.6 4L12 4l4.4 6.5 4.6-4-1.6 9.2H4.6Z"/>',
  eye: '<path d="M2.2 12S5.7 5.2 12 5.2 21.8 12 21.8 12 18.3 18.8 12 18.8 2.2 12 2.2 12Z"/><circle cx="12" cy="12" r="3.1"/>',
  ban: '<circle cx="12" cy="12" r="8.6"/><path d="m5.9 5.9 12.2 12.2"/>',
  key: '<circle cx="7.6" cy="15.4" r="4.4"/><path d="m10.8 12.2 8.7-8.7"/><path d="m15.2 4.9 3.2 3.2"/><path d="m18.2 1.9 3.2 3.2"/>',
  pin: '<path d="M12 16.8V21"/><path d="M8.8 10.6V4h6.4v6.6l3 3.2H5.8Z"/>',
  lock: '<rect x="4.2" y="10.8" width="15.6" height="10" rx="2.6"/><path d="M8 10.8V7.6a4 4 0 0 1 8 0v3.2"/>',
  unlock: '<rect x="4.2" y="10.8" width="15.6" height="10" rx="2.6"/><path d="M8 10.8V7.6a4 4 0 0 1 7.4-2"/>',
  bell: '<path d="M18 8.6a6 6 0 1 0-12 0c0 5-2 6.4-2 6.4h16s-2-1.4-2-6.4"/><path d="M13.7 19a2 2 0 0 1-3.4 0"/>',
  bellOff: '<path d="M8.7 4.5A6 6 0 0 1 18 8.6c0 1.6.2 2.9.6 3.9"/><path d="M6.2 6.4A6 6 0 0 0 6 8.6c0 5-2 6.4-2 6.4h12"/><path d="M13.7 19a2 2 0 0 1-3.4 0"/><path d="m2.5 2.5 19 19"/>',
  mail: '<rect x="2.5" y="4.8" width="19" height="14.4" rx="2.4"/><path d="m3.4 6.4 8.6 6 8.6-6"/>',
  flag: '<path d="M4.5 21V3.5"/><path d="M4.5 4.4h11.8l-1.7 4 1.7 4H4.5"/>',
  smartphone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.4"/><path d="M11 18.6h2"/>',
  monitor: '<rect x="2.5" y="3.5" width="19" height="13" rx="2.2"/><path d="M8.5 21h7M12 16.5V21"/>',
  alert: '<path d="M12 3.2 2.8 19.4h18.4Z"/><path d="M12 9.6v4.6M12 17.4h.01"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2.4"/><path d="M6 15H4.8A1.8 1.8 0 0 1 3 13.2V4.8A1.8 1.8 0 0 1 4.8 3h8.4A1.8 1.8 0 0 1 15 4.8V6"/>',
};

export function icon(name, cls = '') {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

export function iconEl(name) {
  const span = document.createElement('span');
  span.className = 'icon-slot';
  span.innerHTML = icon(name);
  return span.firstElementChild;
}

export const HUES = 6;
export function hueFor(id = '') {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 997;
  return String(hash % HUES);
}

export function initials(name = '?') {
  const parts = String(name)
    .trim()
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function avatarEl({ id, name, avatarUrl, online = false, size = '' }, { showPresence = false } = {}) {
  const el = h('div', { class: `avatar ${size}`.trim(), dataset: { hue: hueFor(id || name) } });
  if (avatarUrl) {
    const img = h('img', { src: avatarUrl, alt: '', loading: 'lazy' });
    img.addEventListener('error', () => {
      img.remove();
      el.textContent = initials(name);
    });
    el.append(img);
  } else {
    el.textContent = initials(name);
  }
  if (showPresence && online) el.append(h('span', { class: 'presence-dot' }));
  return el;
}

export const pad2 = (n) => String(n).padStart(2, '0');

export function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function sameDay(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

export function fmtDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export function fmtListTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (sameDay(d, Date.now())) return fmtTime(ts);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' });
}

export function fmtLastSeen(ts) {
  if (!ts) return 'offline';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'last seen just now';
  if (diff < 3_600_000) return `last seen ${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `last seen ${Math.floor(diff / 3_600_000)}h ago`;
  return `last seen ${fmtDay(ts)}`;
}

export function fmtBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function debounce(fn, ms = 250) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}
