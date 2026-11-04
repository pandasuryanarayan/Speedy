import { io } from '/socket.io/socket.io.esm.min.js';
import { getAccessToken } from './api.js';

let socket = null;

export function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({
    path: '/socket.io',
    auth: { token: getAccessToken() },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 600,
    reconnectionDelayMax: 8000,
    timeout: 12000,
  });
  return socket;
}

export const getSocket = () => socket;

export function emitAsync(event, payload) {
  return new Promise((resolve) => {
    if (!socket || !socket.connected) return resolve({ ok: false, error: { code: 'offline', message: 'Reconnecting…' } });
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: { code: 'timeout', message: 'Server did not respond' } });
      }
    }, 10000);
    socket.emit(event, payload, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response || { ok: false, error: { code: 'empty', message: 'No response' } });
    });
  });
}
