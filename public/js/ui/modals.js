import { h, avatarEl, icon, debounce } from '../dom.js';
import { api } from '../api.js';
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

export function profileModal({ state, onUpdated, onLogout }) {
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
        h('h5', { text: 'Security' }),
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
      ),
    ],
    footer: [
      h('button', { class: 'btn btn-ghost', text: 'Sign out', onclick: onLogout }),
      h('button', { class: 'btn btn-primary', text: 'Save changes', onclick: save }),
    ],
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
