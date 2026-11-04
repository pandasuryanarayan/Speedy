import { h } from '../dom.js';

let host = null;

function ensureHost() {
  if (!host) {
    host = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(host);
  }
  return host;
}

export function toast(message, { type = 'info', timeout = 3200 } = {}) {
  const node = h('div', { class: `toast ${type === 'error' ? 'error' : ''}`.trim(), text: message });
  ensureHost().append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, timeout);
}

export const toastError = (err) => toast(err?.message || 'Something went wrong', { type: 'error' });
