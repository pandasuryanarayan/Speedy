/** Light / dark / system, applied as a data attribute on <html>. */
const KEY = 'speedy.theme';
const ORDER = ['light', 'dark', 'system'];
const media = window.matchMedia('(prefers-color-scheme: dark)');

export const get = () => {
  const stored = localStorage.getItem(KEY);
  return ORDER.includes(stored) ? stored : 'system';
};

export function apply(setting = get()) {
  const resolved = setting === 'system' ? (media.matches ? 'dark' : 'light') : setting;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  return resolved;
}

export function set(setting) {
  localStorage.setItem(KEY, setting);
  return apply(setting);
}

/**
 * Light -> dark -> system -> light. When the setting is "system" the first click
 * flips to the opposite of what is currently rendered, so the click always has a
 * visible effect instead of silently landing on the same appearance.
 */
export function cycle() {
  const current = get();
  const resolved = document.documentElement.dataset.theme || apply(current);
  let next;
  if (current === 'system') next = resolved === 'dark' ? 'light' : 'dark';
  else if (current === 'dark') next = 'system';
  else next = 'dark';
  set(next);
  return next;
}

export const label = () => (get() === 'system' ? 'System' : get() === 'dark' ? 'Dark' : 'Light');

media.addEventListener('change', () => {
  if (get() === 'system') apply('system');
});
