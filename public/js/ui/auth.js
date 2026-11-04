import { h, icon } from '../dom.js';
import { api, setAccessToken } from '../api.js';
import { toastError } from './toast.js';

const FEATURES = [
  'Real-time messaging with delivery and read receipts',
  'Group chats with admins and member controls',
  'Photos and files, encrypted at rest',
  'Hardened sessions: rotating tokens, rate limits, audit log',
];

export function createAuthView({ onAuthenticated }) {
  let mode = 'login';

  const title = h('h2', { text: 'Welcome back' });
  const subtitle = h('p', { class: 'sub', text: 'Sign in to pick up where you left off.' });
  const username = h('input', { class: 'input', name: 'username', autocomplete: 'username', placeholder: 'yourname', required: 'true' });
  const displayName = h('input', { class: 'input', name: 'displayName', autocomplete: 'name', placeholder: 'Your name', maxlength: '48' });
  const password = h('input', { class: 'input', name: 'password', type: 'password', autocomplete: 'current-password', placeholder: 'At least 10 characters', required: 'true' });
  const nameField = h('label', { class: 'field hidden' }, h('span', { text: 'Your name' }), displayName);
  const errorEl = h('span', { class: 'field-error' });
  const submitBtn = h('button', { class: 'btn btn-primary btn-block', type: 'submit', text: 'Sign in' });
  const switchBtn = h('button', { type: 'button', text: 'Create an account' });

  const form = h(
    'form',
    { novalidate: 'true' },
    h('label', { class: 'field' }, h('span', { text: 'Username' }), username),
    nameField,
    h('label', { class: 'field' }, h('span', { text: 'Password' }), password),
    errorEl,
    submitBtn,
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = mode === 'login' ? 'Signing in…' : 'Creating account…';
    try {
      const payload =
        mode === 'login'
          ? { username: username.value.trim(), password: password.value }
          : { username: username.value.trim(), displayName: displayName.value.trim() || username.value.trim(), password: password.value };
      const data = mode === 'login' ? await api.login(payload) : await api.register(payload);
      setAccessToken(data.accessToken);
      onAuthenticated(data.user);
    } catch (err) {
      if (err.details?.length) errorEl.textContent = err.details[0].message;
      else errorEl.textContent = err.message;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = mode === 'login' ? 'Sign in' : 'Create account';
    }
  });

  const setMode = (next) => {
    mode = next;
    const isLogin = mode === 'login';
    title.textContent = isLogin ? 'Welcome back' : 'Create your account';
    subtitle.textContent = isLogin ? 'Sign in to pick up where you left off.' : 'It takes ten seconds. No phone number, no noise.';
    submitBtn.textContent = isLogin ? 'Sign in' : 'Create account';
    password.setAttribute('autocomplete', isLogin ? 'current-password' : 'new-password');
    nameField.classList.toggle('hidden', isLogin);
    switchBtn.textContent = isLogin ? 'Create an account' : 'I already have an account';
    errorEl.textContent = '';
  };

  switchBtn.addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'));

  const el = h(
    'div',
    { class: 'auth' },
    h(
      'section',
      { class: 'auth-brand' },
      h('div', { class: 'auth-logo' }, h('span', { class: 'mark', html: icon('chat') }), 'Speedy'),
      h(
        'div',
        { class: 'auth-copy' },
        h('h1', { text: 'Chat with anyone. No hassle.' }),
        h('p', { text: 'A fast, private messenger built for teams and friends — real time, end to end in your browser, hardened by default.' }),
        h('ul', { class: 'auth-points' }, ...FEATURES.map((f) => h('li', {}, h('span', { html: icon('check') }), f))),
      ),
      h('div', { class: 'auth-foot', text: 'Speedy · Apache-2.0 · self-hosted' }),
    ),
    h(
      'section',
      { class: 'auth-panel' },
      h(
        'div',
        { class: 'auth-card' },
        title,
        subtitle,
        form,
        h('div', { class: 'auth-switch' }, switchBtn),
        h(
          'div',
          { class: 'auth-demo' },
          'Demo accounts: ',
          h('code', { text: 'alice' }),
          ', ',
          h('code', { text: 'bob' }),
          ' or ',
          h('code', { text: 'surya' }),
          ' — password ',
          h('code', { text: 'speedy-demo-123' }),
        ),
      ),
    ),
  );

  return { el, setMode, focus: () => username.focus() };
}
