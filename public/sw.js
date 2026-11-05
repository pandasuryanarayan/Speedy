/* Service worker: Web Push delivery only. No offline caching, no intercepts. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data?.text() || 'New message' };
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'Speedy', {
      body: payload.body || 'You have a new message',
      icon: '/assets/favicon.svg',
      badge: '/assets/favicon.svg',
      tag: payload.chatId || 'speedy',
      data: { url: payload.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) if ('focus' in client) return client.focus();
      return self.clients.openWindow(event.notification.data?.url || '/');
    }),
  );
});
