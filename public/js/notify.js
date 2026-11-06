/**
 * Browser notifications for messages that arrive while the tab is in the
 * background. Local (no server involved) - Web Push, when the instance has VAPID
 * keys, covers the closed-tab case on top of this.
 */
const KEY = 'speedy.notify';

export const supported = () => typeof window !== 'undefined' && 'Notification' in window;

export const permission = () => (supported() ? Notification.permission : 'unsupported');

export const isEnabled = () => permission() === 'granted' && localStorage.getItem(KEY) !== 'off';

export async function request() {
  if (!supported()) return 'unsupported';
  const result = await Notification.requestPermission();
  if (result === 'granted') localStorage.setItem(KEY, 'on');
  return result;
}

export function disable() {
  localStorage.setItem(KEY, 'off');
}

export const state = () => {
  if (!supported()) return 'unsupported';
  if (permission() === 'denied') return 'blocked';
  return isEnabled() ? 'on' : 'off';
};

/** Shows a notification only when the tab is not visible and the user opted in. */
export function notify({ title, body, onClick }) {
  if (!isEnabled() || !document.hidden) return null;
  try {
    const note = new Notification(title, {
      body,
      icon: '/assets/favicon.svg',
      badge: '/assets/favicon.svg',
      tag: 'speedy-message',
      silent: false,
    });
    note.onclick = () => {
      window.focus();
      note.close();
      onClick?.();
    };
    return note;
  } catch {
    return null;
  }
}
