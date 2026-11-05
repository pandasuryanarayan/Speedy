import { h, avatarEl, icon, debounce, fmtBytes } from '../dom.js';
import { api, exportMyData } from '../api.js';
import { toast, toastError } from './toast.js';

let openCount = 0;

export function openModal({ title, body, footer, wide = false, onClose }) {
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    openCount = Math.max(0, openCount - 1);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };

  const modal = h(
    'div',
    { class: `modal ${wide ? 'wide' : ''}`.trim(), role: 'dialog', 'aria-modal': 'true' },
    h(
      'div',
      { class: 'modal-head' },
      h('h3', { text: title }),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', html: icon('x'), onclick: close }),
    ),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null,
  );

  const backdrop = h('div', { class: 'modal-backdrop' }, modal);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
  openCount += 1;
  setTimeout(() => (modal.querySelector('input, textarea') || modal.querySelector('.modal-foot .btn-primary') || modal.querySelector('button'))?.focus(), 30);
  return { close, modal };
}

export const anyModalOpen = () => openCount > 0;

export function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      ref.close();
      resolve(value);
    };
    const ref = openModal({
      title,
      body: h('p', { class: 'muted', text: message }),
      footer: [
        h('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: () => finish(false) }),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, text: confirmText, onclick: () => finish(true) }),
      ],
      onClose: () => finish(false),
    });
  });
}

export function promptDialog({ title, label, value = '', placeholder = '', confirmText = 'Save', maxLength = 64 }) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { class: 'input', value, placeholder, maxlength: String(maxLength) });
    const finish = (val) => {
      if (done) return;
      done = true;
      ref.close();
      resolve(val);
    };
    const submit = () => {
      const text = input.value.trim();
      if (text) finish(text);
    };
    const ref = openModal({
      title,
      body: h('label', { class: 'field' }, h('span', { text: label }), input),
      footer: [
        h('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: () => finish(null) }),
        h('button', { class: 'btn btn-primary', text: confirmText, onclick: submit }),
      ],
      onClose: () => finish(null),
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    setTimeout(() => input.select(), 40);
  });
}

/** Searchable people picker: new chat, new group, add members. */
export function peoplePicker({ title, confirmText = 'Start chat', excludeIds = [], multi = false, initial = [] }) {
  return new Promise((resolve) => {
    const selected = new Map();
    const chips = h('div', { class: 'selected-chips hidden' });
    const results = h('div', { class: 'modal-list' });
    const search = h('input', { class: 'input', placeholder: 'Search by name or username', autocomplete: 'off' });
    const confirmBtn = h('button', { class: 'btn btn-primary', text: confirmText, disabled: true });
    let lastResults = [];
    let ref;

    const syncConfirm = () => {
      confirmBtn.disabled = selected.size === 0;
      confirmBtn.textContent = selected.size > 1 ? `${confirmText} (${selected.size})` : confirmText;
    };

    const renderChips = () => {
      chips.replaceChildren(
        ...[...selected.values()].map((user) =>
          h(
            'span',
            { class: 'selected-chip' },
            avatarEl({ id: user.id, name: user.displayName, avatarUrl: user.avatarUrl }),
            user.displayName,
            h('button', {
              type: 'button',
              'aria-label': `Remove ${user.displayName}`,
              html: icon('x'),
              onclick: () => {
                selected.delete(user.id);
                renderChips();
                syncConfirm();
                renderResults(lastResults);
              },
            }),
          ),
        ),
      );
      chips.classList.toggle('hidden', selected.size === 0);
    };

    const renderResults = (users) => {
      lastResults = users;
      const visible = users.filter((u) => !excludeIds.includes(u.id));
      if (!visible.length) {
        results.replaceChildren(h('p', { class: 'muted empty-list', text: 'No people found' }));
        return;
      }
      results.replaceChildren(
        ...visible.map((user) => {
          const isSelected = selected.has(user.id);
          return h(
            'button',
            {
              type: 'button',
              class: 'pick-row',
              dataset: { selected: String(isSelected) },
              onclick: () => {
                if (multi) {
                  if (isSelected) selected.delete(user.id);
                  else selected.set(user.id, user);
                } else {
                  selected.clear();
                  selected.set(user.id, user);
                }
                renderChips();
                syncConfirm();
                renderResults(lastResults);
              },
            },
            avatarEl({ id: user.id, name: user.displayName, avatarUrl: user.avatarUrl, online: user.online }, { showPresence: true }),
            h('span', { class: 'grow' }, h('span', { class: 'name', text: user.displayName }), h('span', { class: 'sub', text: `@${user.username}` })),
            h('span', { class: 'pick-check', html: isSelected ? icon('check') : '' }),
          );
        }),
      );
    };

    const doSearch = debounce(async (q) => {
      try {
        const data = await api.get(`/api/users/search?q=${encodeURIComponent(q)}&limit=20`);
        renderResults(data.users);
      } catch (err) {
        toastError(err);
      }
    }, 220);

    search.addEventListener('input', () => doSearch(search.value.trim()));

    const finish = (ids) => {
      ref?.close();
      resolve(ids);
    };

    confirmBtn.addEventListener('click', () => finish([...selected.keys()]));

    ref = openModal({
      title,
      body: [chips, h('div', { class: 'field' }, search), results],
      footer: [h('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: () => finish([]) }), confirmBtn],
      wide: true,
      onClose: () => resolve([]),
    });

    if (initial.length) {
      initial.forEach((u) => selected.set(u.id, u));
      renderChips();
      syncConfirm();
    }
    doSearch('');
  });
}

/**
 * Password prompt for a locked chat. The modal owns the async submit so a wrong
 * password keeps the dialog open with an inline error instead of closing it.
 * Resolves true when onSubmit succeeds, false when cancelled.
 */
export function unlockModal({ heading = 'Locked chat', title, message, onSubmit, confirmText = 'Unlock' }) {
  return new Promise((resolve) => {
    let done = false;
    let busy = false;
    const input = h('input', {
      class: 'input',
      type: 'password',
      placeholder: 'Your account password',
      autocomplete: 'current-password',
    });
    const error = h('span', { class: 'field-error' });
    const submitBtn = h('button', { class: 'btn btn-primary', text: confirmText });

    const finish = (value) => {
      if (done) return;
      done = true;
      ref.close();
      resolve(value);
    };

    const submit = async () => {
      if (busy) return;
      const password = input.value;
      if (!password) {
        error.textContent = 'Enter your password';
        return;
      }
      busy = true;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Checking…';
      error.textContent = '';
      try {
        await onSubmit(password);
        finish(true);
      } catch (err) {
        error.textContent = err?.message || 'That did not work';
        input.select();
      } finally {
        busy = false;
        submitBtn.disabled = false;
        submitBtn.textContent = confirmText;
      }
    };

    submitBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });

    const ref = openModal({
      title: heading,
      body: [
        h('p', { class: 'modal-lead muted', text: message || `“${title}” is locked. Enter your account password to open it.` }),
        h('label', { class: 'field' }, h('span', { text: 'Password' }), input),
        error,
      ],
      footer: [h('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: () => finish(false) }), submitBtn],
      onClose: () => finish(false),
    });
  });
}

export function lightbox(src) {
  const close = () => {
    box.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const box = h(
    'div',
    { class: 'lightbox', onclick: (e) => e.target === box && close() },
    h('button', { class: 'icon-btn', 'aria-label': 'Close image', html: icon('x'), onclick: close }),
    h('img', { src, alt: 'Shared image' }),
  );
  document.body.append(box);
  document.addEventListener('keydown', onKey);
}

/* ------------------------------ profile ------------------------------ */

export function profileModal({ state, onUpdated, onLogout, onNotifications, onSecurity, onAdmin, onTheme, themeLabel }) {
  const nameInput = h('input', { class: 'input', value: state.user.displayName, maxlength: '48' });
  const aboutInput = h('input', {
    class: 'input',
    value: state.user.about || '',
    maxlength: '140',
    placeholder: 'Hey there! I am using Speedy.',
  });
  const errorEl = h('span', { class: 'field-error' });
  const hero = h('div', { class: 'info-hero' });
  let ref;

  const renderHero = () => {
    const avatar = avatarEl({ id: state.user.id, name: state.user.displayName, avatarUrl: state.user.avatarUrl });
    avatar.classList.add('xl');
    const picker = h('input', {
      type: 'file',
      accept: 'image/png,image/jpeg,image/webp,image/gif',
      class: 'sr-only',
      onchange: async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          if (file.size > 10 * 1024 * 1024) throw new Error('Image must be under 10 MB');
          const attachment = await api.upload(file);
          const data = await api.put('/api/users/me/avatar', { attachmentId: attachment.id });
          state.user = { ...state.user, ...data.user };
          onUpdated?.(data.user);
          renderHero();
          toast('Photo updated');
        } catch (err) {
          toastError(err);
        }
      },
    });
    hero.replaceChildren(
      avatar,
      h('h4', { text: state.user.displayName }),
      h('p', { class: 'muted', text: `@${state.user.username}` }),
      h('label', { class: 'btn btn-sm btn-ghost' }, h('span', { html: icon('camera') }), 'Change photo', picker),
    );
  };
  renderHero();

  const save = async () => {
    errorEl.textContent = '';
    try {
      const data = await api.patch('/api/users/me', {
        displayName: nameInput.value.trim(),
        about: aboutInput.value.trim(),
      });
      state.user = { ...state.user, ...data.user };
      onUpdated?.(data.user);
      toast('Profile saved');
      ref.close();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  };

  ref = openModal({
    title: 'Your profile',
    wide: true,
    body: [
      hero,
      h('label', { class: 'field' }, h('span', { text: 'Display name' }), nameInput),
      h('label', { class: 'field' }, h('span', { text: 'About' }), aboutInput),
      errorEl,
      h(
        'div',
        { class: 'info-section' },
        h('h5', { text: 'Preferences' }),
        h(
          'div',
          { class: 'info-row' },
          h('span', { class: 'grow' },
            h('span', { class: 'name', text: 'Appearance' }),
            h('span', { class: 'sub', text: 'Light, dark, or follow your system' }),
          ),
          h('button', { class: 'btn btn-sm', text: themeLabel ? themeLabel() : 'System', onclick: () => { onTheme?.(); ref.close(); profileModal({ state, onUpdated, onLogout, onNotifications, onSecurity, onAdmin, onTheme, themeLabel }); } }),
        ),
      ),
      h(
        'div',
        { class: 'info-section' },
        h('h5', { text: 'Security' }),
        h(
          'div',
          { class: 'info-row' },
          h('span', { class: 'grow' },
            h('span', { class: 'name', text: 'Email' }),
            h('span', { class: 'sub', text: state.user.email ? `${state.user.email}${state.user.emailVerified ? ' · verified' : ' · unverified'}` : 'Not set — needed for password reset' }),
          ),
          h('button', {
            class: 'btn btn-sm',
            text: state.user.email ? 'Change' : 'Add',
            onclick: async () => {
              const email = await promptDialog({ title: 'Email address', label: 'We use it only for verification and password reset', value: state.user.email || '', placeholder: 'you@example.com', confirmText: 'Save', maxLength: 160 });
              if (!email) return;
              try {
                const data = await api.patch('/api/auth/email', { email });
                state.user = { ...state.user, ...data.user };
                onUpdated?.(data.user);
                toast('Email saved — check your inbox to confirm');
                ref.close();
                profileModal({ state, onUpdated, onLogout, onNotifications, onSecurity, onAdmin });
              } catch (err) { toastError(err); }
            },
          }),
        ),
        h(
          'div',
          { class: 'info-row' },
          h('span', { class: 'grow' },
            h('span', { class: 'name', text: 'Two-factor authentication' }),
            h('span', { class: 'sub', text: state.user.mfaEnabled ? 'Enabled' : 'Add a second step at sign-in' }),
          ),
          h('button', { class: 'btn btn-sm', text: state.user.mfaEnabled ? 'Manage' : 'Enable', onclick: () => onSecurity?.() }),
        ),
        h(
          'div',
          { class: 'info-row' },
          h('span', { class: 'grow' },
            h('span', { class: 'name', text: 'Notifications' }),
            h('span', { class: 'sub', text: 'Browser alerts when you are away' }),
          ),
          h('button', { class: 'btn btn-sm', text: 'Enable', onclick: () => onNotifications?.() }),
        ),
        state.user.role === 'admin'
          ? h(
              'div',
              { class: 'info-row' },
              h('span', { class: 'grow' },
                h('span', { class: 'name', text: 'Moderation' }),
                h('span', { class: 'sub', text: 'Reports and account controls' }),
              ),
              h('button', { class: 'btn btn-sm', text: 'Open', onclick: () => onAdmin?.() }),
            )
          : null,
        h(
          'button',
          {
            class: 'btn btn-sm',
            onclick: () => {
              ref.close();
              sessionsModal();
            },
          },
          h('span', { class: 'icon-slot', html: icon('key') }),
          ' Active sessions',
        ),
        h(
          'button',
          {
            class: 'btn btn-sm',
            style: null,
            onclick: async () => {
              try {
                await exportMyData();
                toast('Export downloaded');
              } catch (err) {
                toastError(err);
              }
            },
          },
          h('span', { class: 'icon-slot', html: icon('download') }),
          ' Export my data',
        ),
        h(
          'button',
          {
            class: 'btn btn-sm btn-danger',
            onclick: async () => {
              ref.close();
              const done = await unlockModal({
                heading: 'Delete account',
                message:
                  'This permanently deletes your profile, sessions, memberships and uploaded files. Messages you sent stay in other people\u2019s conversations, without your name. This cannot be undone.',
                confirmText: 'Delete my account',
                onSubmit: async (password) => {
                  await api.del('/api/users/me', { password });
                },
              });
              if (done) {
                toast('Account deleted');
                setTimeout(() => location.reload(), 900);
              }
            },
          },
          h('span', { class: 'icon-slot', html: icon('trash') }),
          ' Delete account',
        ),
      ),
    ],
    footer: [
      h('button', { class: 'btn btn-ghost', text: 'Sign out', onclick: onLogout }),
      h('button', { class: 'btn btn-primary', text: 'Save changes', onclick: save }),
    ],
  });
}

/** TOTP enrolment: secret, otpauth URI, confirmation code, backup codes. */
export function securityModal({ state, onChanged }) {
  const body = h('div', { class: 'modal-lead muted', text: 'Loading…' });
  const ref = openModal({
    title: 'Two-factor authentication',
    body,
    footer: [h('button', { class: 'btn btn-primary', text: 'Done', onclick: () => ref.close() })],
  });

  const renderState = async () => {
    try {
      const data = await api.get('/api/auth/mfa');
      const { mfa } = data;
      if (mfa.policy === 'off') {
        body.replaceChildren(h('p', { class: 'muted', text: 'Two-factor authentication is disabled on this instance.' }));
        return;
      }
      if (mfa.enabled) {
        const password = h('input', { class: 'input', type: 'password', placeholder: 'Account password' });
        const error = h('span', { class: 'field-error' });
        body.replaceChildren(
          h('p', { class: 'modal-lead muted', text: `Two-factor authentication is on. ${mfa.backupCodesRemaining} backup codes left.` }),
          h('label', { class: 'field' }, h('span', { text: 'Confirm with your password to turn it off' }), password),
          error,
          h('button', {
            class: 'btn btn-danger',
            text: 'Turn off two-factor',
            onclick: async () => {
              try {
                await api.post('/api/auth/mfa/disable', { password: password.value });
                toast('Two-factor disabled');
                onChanged?.();
                renderState();
              } catch (err) {
                error.textContent = err.message;
              }
            },
          }),
        );
        return;
      }

      const start = await api.post('/api/auth/mfa/setup', {});
      const code = h('input', { class: 'input', placeholder: '123456', inputmode: 'numeric', maxlength: '6' });
      const error = h('span', { class: 'field-error' });
      const codes = h('div');
      body.replaceChildren(
        h('p', { class: 'modal-lead muted', text: 'Add this secret to your authenticator app, then enter the 6-digit code it shows.' }),
        h('code', { class: 'secret-box', text: start.secret }),
        h('p', { class: 'muted small', text: start.uri }),
        h('label', { class: 'field' }, h('span', { text: 'Verification code' }), code),
        error,
        h('button', {
          class: 'btn btn-primary',
          text: 'Enable two-factor',
          onclick: async () => {
            try {
              const result = await api.post('/api/auth/mfa/enable', { code: code.value.trim() });
              codes.replaceChildren(
                h('h5', { class: 'muted', text: 'Save these backup codes — each works once' }),
                h('div', { class: 'backup-codes' }, ...result.backupCodes.map((c) => h('code', { text: c }))),
              );
              toast('Two-factor enabled');
              onChanged?.();
            } catch (err) {
              error.textContent = err.message;
            }
          },
        }),
        codes,
      );
    } catch (err) {
      body.replaceChildren(h('p', { class: 'muted', text: err.message }));
    }
  };

  renderState();
  return ref;
}

/** Moderation queue for administrators. */
export function adminModal({ state }) {
  const list = h('div', { class: 'modal-list' }, h('p', { class: 'muted', text: 'Loading…' }));
  const stats = h('div', { class: 'admin-stats' });
  const ref = openModal({
    title: 'Moderation',
    wide: true,
    body: [stats, list],
    footer: [h('button', { class: 'btn btn-primary', text: 'Close', onclick: () => ref.close() })],
  });

  const load = async () => {
    try {
      const [overview, reports] = await Promise.all([api.get('/api/admin/overview'), api.get('/api/admin/reports?status=open')]);
      stats.replaceChildren(
        ...[
          ['Open reports', overview.openReports],
          ['Users', overview.users],
          ['Messages', overview.messages],
        ].map(([label, value]) =>
          h('div', { class: 'admin-stat' }, h('span', { class: 'value', text: String(value) }), h('span', { class: 'label', text: label })),
        ),
      );

      if (!reports.reports.length) {
        list.replaceChildren(h('p', { class: 'muted empty-list', text: 'No open reports. Nothing to moderate.' }));
        return;
      }

      list.replaceChildren(
        ...reports.reports.map((report) =>
          h(
            'div',
            { class: 'report-card' },
            h('div', { class: 'report-head' },
              h('span', { class: 'role-tag', text: report.reason }),
              h('span', { class: 'muted small', text: `@${report.reporter || 'unknown'} · ${new Date(report.createdAt).toLocaleString()}` }),
            ),
            h('p', { class: 'report-body', text: report.messagePreview || '(no text)' }),
            h('div', { class: 'report-actions' },
              h('button', { class: 'btn btn-sm', text: 'Dismiss', onclick: () => resolve(report.id, 'dismiss') }),
              h('button', { class: 'btn btn-sm', text: 'Delete message', onclick: () => resolve(report.id, 'remove-message') }),
              h('button', { class: 'btn btn-sm btn-danger', text: 'Disable author', onclick: () => resolve(report.id, 'disable-user') }),
            ),
          ),
        ),
      );
    } catch (err) {
      list.replaceChildren(h('p', { class: 'muted', text: err.message }));
    }
  };

  const resolve = async (id, action) => {
    try {
      await api.post(`/api/admin/reports/${id}/resolve`, { action });
      toast('Report resolved');
      load();
    } catch (err) {
      toastError(err);
    }
  };

  load();
  return ref;
}

/** Shared media in a conversation: images as a grid, files as a list. */
export function galleryModal({ chat, onOpenImage, onDownload, unlockHeaders }) {
  let tab = 'image';
  const body = h('div');
  const tabs = h('div', { class: 'gallery-tabs' });
  const panel = h('div', { class: 'modal-lead muted', text: 'Loading…' });

  const ref = openModal({
    title: `Shared in ${chat.title}`,
    body: [tabs, panel],
    wide: true,
    footer: [h('button', { class: 'btn btn-primary', text: 'Done', onclick: () => ref.close() })],
  });

  const renderTabs = () => {
    tabs.replaceChildren(
      ...[
        ['image', 'Photos'],
        ['file', 'Files'],
      ].map(([value, label]) =>
        h('button', {
          class: 'chip',
          'aria-pressed': String(tab === value),
          text: label,
          onclick: () => {
            if (tab === value) return;
            tab = value;
            renderTabs();
            load();
          },
        }),
      ),
    );
  };

  const load = async () => {
    panel.replaceChildren(h('p', { class: 'muted', text: 'Loading…' }));
    try {
      const data = await api.get(`/api/chats/${chat.id}/media?type=${tab}&limit=60`, { headers: unlockHeaders });
      const items = data.items || [];
      if (!items.length) {
        panel.replaceChildren(
          h('p', { class: 'gallery-empty', text: tab === 'image' ? 'No photos shared yet' : 'No files shared yet' }),
        );
        return;
      }

      if (tab === 'image') {
        panel.replaceChildren(
          h(
            'div',
            { class: 'gallery' },
            ...items.map((item) =>
              h(
                'button',
                { class: 'gallery-item', title: item.attachment.name, onclick: () => onOpenImage(item.attachment.url) },
                h('img', { src: item.attachment.url, alt: item.attachment.name, loading: 'lazy' }),
              ),
            ),
          ),
        );
        return;
      }

      panel.replaceChildren(
        ...items.map((item) =>
          h(
            'button',
            { class: 'file-row', onclick: () => onDownload(item.attachment) },
            h('span', { class: 'file-icon', html: icon('file') }),
            h(
              'span',
              { class: 'meta' },
              h('span', { class: 'name', text: item.attachment.name }),
              h('span', { class: 'sub', text: `${fmtBytes(item.attachment.size)} · ${new Date(item.createdAt).toLocaleDateString()}` }),
            ),
            h('span', { class: 'file-dl', html: icon('download') }),
          ),
        ),
      );
    } catch (err) {
      panel.replaceChildren(h('p', { class: 'muted', text: err.message }));
    }
  };

  renderTabs();
  load();
  return ref;
}

/** Report a message to the moderation queue. */
export function reportModal({ message }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      ref.close();
      resolve(value);
    };
    const reasons = [
      ['spam', 'Spam or scam'],
      ['abuse', 'Abusive content'],
      ['harassment', 'Harassment'],
      ['illegal', 'Illegal content'],
      ['other', 'Something else'],
    ];
    const ref = openModal({
      title: 'Report message',
      body: [
        h('p', { class: 'modal-lead muted', text: 'Reports go to the moderators of this instance. The message author is not told.' }),
        h(
          'div',
          { class: 'report-reasons' },
          ...reasons.map(([value, label]) =>
            h('button', { class: 'btn btn-block', text: label, onclick: () => finish({ reason: value, message }) }),
          ),
        ),
      ],
      footer: [h('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: () => finish(null) })],
      onClose: () => finish(null),
    });
  });
}

export async function sessionsModal() {
  const list = h('div', { class: 'modal-list' }, h('p', { class: 'muted', text: 'Loading…' }));
  const ref = openModal({
    title: 'Active sessions',
    body: [h('p', { class: 'muted', text: 'Devices signed in to your account. Revoke anything you do not recognise.' }), list],
    footer: [h('button', { class: 'btn btn-primary', text: 'Done', onclick: () => ref.close() })],
  });

  const load = async () => {
    try {
      const data = await api.get('/api/auth/sessions');
      list.replaceChildren(
        ...data.sessions.map((s) =>
          h(
            'div',
            { class: 'info-row' },
            h(
              'span',
              { class: 'grow' },
              h('span', { class: 'name', text: s.current ? 'This device' : (s.userAgent || 'Unknown device').slice(0, 60) }),
              h('span', { class: 'sub', text: `${s.ip || 'unknown ip'} · active ${new Date(s.lastUsedAt).toLocaleString()}` }),
            ),
            s.current
              ? h('span', { class: 'role-tag', text: 'current' })
              : h('button', {
                  class: 'btn btn-sm btn-danger',
                  text: 'Revoke',
                  onclick: async () => {
                    await api.del(`/api/auth/sessions/${s.id}`).catch(toastError);
                    load();
                  },
                }),
          ),
        ),
      );
    } catch (err) {
      list.replaceChildren(h('p', { class: 'muted', text: err.message }));
    }
  };
  load();
}

/* ------------------------------ group ------------------------------ */

export function groupInfoModal({ chat, me, onChanged, onLeft }) {
  const body = h('div');
  let ref;

  const render = (detail) => {
    const isAdmin = ['owner', 'admin'].includes(detail.myRole);

    const memberRow = (m) => {
      const actions = [];
      if (isAdmin && m.id !== me.id) {
        actions.push(
          h('button', {
            class: 'icon-btn',
            'aria-label': `Remove ${m.displayName}`,
            html: icon('userMinus'),
            onclick: async () => {
              const ok = await confirmDialog({
                title: 'Remove member',
                message: `Remove ${m.displayName} from ${detail.title}?`,
                confirmText: 'Remove',
                danger: true,
              });
              if (!ok) return;
              try {
                const data = await api.del(`/api/chats/${detail.id}/members/${m.id}`);
                render(data.chat);
                onChanged?.();
              } catch (err) {
                toastError(err);
              }
            },
          }),
        );
      }
      if (detail.myRole === 'owner' && m.role !== 'owner' && m.id !== me.id) {
        actions.push(
          h('button', {
            class: 'icon-btn',
            'aria-label': 'Toggle admin',
            html: icon('crown'),
            onclick: async () => {
              try {
                const data = await api.patch(`/api/chats/${detail.id}/members/${m.id}`, {
                  role: m.role === 'admin' ? 'member' : 'admin',
                });
                render(data.chat);
              } catch (err) {
                toastError(err);
              }
            },
          }),
        );
      }
      return h(
        'div',
        { class: 'info-row' },
        avatarEl({ id: m.id, name: m.displayName, avatarUrl: m.avatarUrl, online: m.online }, { showPresence: true }),
        h('span', { class: 'grow' }, h('span', { class: 'name', text: m.displayName }), h('span', { class: 'sub', text: `@${m.username}` })),
        m.role !== 'member' ? h('span', { class: `role-tag ${m.role}`, text: m.role }) : null,
        ...actions,
      );
    };

    const groupAvatar = avatarEl({ id: detail.id, name: detail.title });
    groupAvatar.classList.add('xl');

    body.replaceChildren(
      h(
        'div',
        { class: 'info-hero' },
        groupAvatar,
        h('h4', { text: detail.title }),
        h('p', { class: 'muted', text: `${detail.members.length} members · created ${new Date(detail.createdAt).toLocaleDateString()}` }),
      ),
      h('div', { class: 'info-section' }, h('h5', { text: 'Members' }), ...detail.members.map(memberRow)),
      h(
        'div',
        { class: 'info-section' },
        h(
          'div',
          { class: 'composer-row' },
          isAdmin
            ? h(
                'button',
                {
                  class: 'btn btn-sm',
                  onclick: async () => {
                    const ids = await peoplePicker({
                      title: 'Add members',
                      confirmText: 'Add',
                      multi: true,
                      excludeIds: detail.members.map((m) => m.id),
                    });
                    if (!ids.length) return;
                    try {
                      const data = await api.post(`/api/chats/${detail.id}/members`, { memberIds: ids });
                      render(data.chat);
                      onChanged?.();
                      toast('Members added');
                    } catch (err) {
                      toastError(err);
                    }
                  },
                },
                h('span', { class: 'icon-slot', html: icon('userPlus') }),
                'Add',
              )
            : null,
          h('button', {
            class: 'btn btn-sm btn-danger',
            text: 'Leave group',
            onclick: async () => {
              const ok = await confirmDialog({
                title: 'Leave group',
                message: `Leave ${detail.title}? You will stop receiving its messages.`,
                confirmText: 'Leave',
                danger: true,
              });
              if (!ok) return;
              try {
                await api.post(`/api/chats/${detail.id}/leave`, {});
                ref.close();
                onLeft?.(detail.id);
              } catch (err) {
                toastError(err);
              }
            },
          }),
        ),
      ),
    );
  };

  render(chat);

  ref = openModal({
    title: 'Group info',
    body,
    footer: [
      h('button', {
        class: 'btn',
        text: 'Rename',
        onclick: async () => {
          const title = await promptDialog({ title: 'Rename group', label: 'Group name', value: chat.title });
          if (!title) return;
          try {
            const data = await api.patch(`/api/chats/${chat.id}`, { title });
            render(data.chat);
            onChanged?.();
          } catch (err) {
            toastError(err);
          }
        },
      }),
      h('button', { class: 'btn btn-primary', text: 'Done', onclick: () => ref.close() }),
    ],
  });
}
