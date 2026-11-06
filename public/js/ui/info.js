import { h, avatarEl, icon, fmtLastSeen, initials, hueFor } from '../dom.js';
import { api } from '../api.js';
import { confirmDialog } from './modals.js';
import { toast, toastError } from './toast.js';

export function createInfoPanel({ onClose, onChanged, onLeft, onBlocked, onUnblocked, onManage, onPin, onLock, onGallery }) {
  const body = h('div');
  const mediaCache = new Map();
  const el = h(
    'aside',
    { class: 'info-panel' },
    h(
      'div',
      { class: 'info-head' },
      h('h3', { text: 'Contact info' }),
      h('button', { class: 'icon-btn', 'aria-label': 'Close details', html: icon('x'), onclick: onClose }),
    ),
    body,
  );

  /** Three most recent shared photos, loaded once per conversation. */
  function renderMedia(chatId) {
    const strip = h('div', { class: 'media-strip' });
    const paint = (items) => {
      if (!items.length) {
        strip.replaceChildren(h('span', { class: 'media-empty', text: 'No photos yet' }));
        return;
      }
      strip.replaceChildren(
        ...items.map((item) =>
          h('button', {
            class: 'media-thumb',
            title: item.attachment.name,
            onclick: () => onGallery?.(),
          }, h('img', { src: item.attachment.url, alt: item.attachment.name, loading: 'lazy' })),
        ),
      );
    };

    if (mediaCache.has(chatId)) {
      paint(mediaCache.get(chatId));
    } else {
      strip.replaceChildren(h('span', { class: 'media-empty', text: 'Loading…' }));
      api.get(`/api/chats/${chatId}/media?type=image&limit=3`)
        .then((data) => {
          mediaCache.set(chatId, data.items || []);
          paint(data.items || []);
        })
        .catch(() => paint([]));
    }
    return strip;
  }

  function render(state) {
    const chat = state.chat;
    if (!chat) {
      body.replaceChildren(h('p', { class: 'empty-list', text: 'Select a conversation' }));
      return;
    }

    const isGroup = chat.type === 'group';
    const heroAvatar = isGroup
      ? h('div', { class: 'avatar xl', dataset: { hue: hueFor(chat.id) }, text: initials(chat.title) })
      : avatarEl({ id: chat.peer?.id, name: chat.title, avatarUrl: chat.avatarUrl, online: chat.peer?.online }, { showPresence: true });
    if (!isGroup) heroAvatar.classList.add('xl');

    const rows = [];

    if (isGroup) {
      rows.push(
        h('div', { class: 'info-section' }, h('h5', { text: `Members · ${chat.members.length}` }),
          ...chat.members.map((m) =>
            h(
              'div',
              { class: 'info-row' },
              avatarEl({ id: m.id, name: m.displayName, avatarUrl: m.avatarUrl, online: m.online }, { showPresence: true }),
              h('span', { class: 'grow' }, h('span', { class: 'name', text: m.displayName }), h('span', { class: 'sub', text: m.online ? 'online' : fmtLastSeen(m.lastSeenAt) })),
              m.role !== 'member' ? h('span', { class: `role-tag ${m.role}`, text: m.role }) : null,
            ),
          ),
        ),
      );
    } else {
      rows.push(
        h('div', { class: 'info-section' }, h('h5', { text: 'About' }),
          h('p', { class: 'muted', text: chat.peer?.about || 'No status set' }),
          h('div', { class: 'info-row' }, h('span', { class: 'grow' },
            h('span', { class: 'name', text: chat.peer?.online ? 'Online now' : 'Last seen' }),
            h('span', { class: 'sub', text: fmtLastSeen(chat.peer?.lastSeenAt) }),
          )),
        ),
      );
    }

    rows.push(
      h('div', { class: 'info-section' },
        h('h5', { text: 'Preferences' }),
        h('div', { class: 'info-row' },
          h('span', { class: 'grow' },
            h('span', { class: 'name', text: 'Pin chat' }),
            h('span', { class: 'sub', text: chat.pinned ? 'Pinned to the top of your list' : 'Keep this chat at the top' }),
          ),
          h('button', {
            class: 'btn btn-sm',
            text: chat.pinned ? 'Unpin' : 'Pin',
            onclick: () => onPin?.(chat),
          }),
        ),
        h('div', { class: 'info-row' },
          h('span', { class: 'grow' },
            h('span', { class: 'name', text: 'Lock chat' }),
            h('span', { class: 'sub', text: chat.locked ? 'Password required to open' : 'Hide behind your account password' }),
          ),
          h('button', {
            class: 'btn btn-sm',
            text: chat.locked ? 'Remove lock' : 'Lock',
            onclick: () => onLock?.(chat),
          }),
        ),
        h('div', { class: 'info-row' },
          h('span', { class: 'grow' }, h('span', { class: 'name', text: 'Mute notifications' }), h('span', { class: 'sub', text: 'Only affects your device' })),
          h('button', {
            class: 'btn btn-sm',
            text: chat.muted ? 'Unmute' : 'Mute',
            onclick: async () => {
              try {
                await api.patch(`/api/chats/${chat.id}/mute`, { muted: !chat.muted });
                toast(chat.muted ? 'Unmuted' : 'Muted');
                onChanged?.();
              } catch (err) { toastError(err); }
            },
          }),
        ),
        !isGroup
          ? h('div', { class: 'info-row' },
              h(
                'span',
                { class: 'grow' },
                h('span', { class: 'name', text: chat.blockedByMe ? 'Unblock contact' : 'Block contact' }),
                h('span', {
                  class: 'sub',
                  text: chat.blockedByMe
                    ? 'They cannot message you'
                    : 'They can no longer message you',
                }),
              ),
              chat.blockedByMe
                ? h('button', {
                    class: 'btn btn-sm',
                    text: 'Unblock',
                    onclick: async () => {
                      try {
                        await api.del(`/api/users/${chat.peer.id}/block`);
                        toast(`${chat.title} unblocked`);
                        onUnblocked?.(chat.id);
                      } catch (err) {
                        toastError(err);
                      }
                    },
                  })
                : h('button', {
                    class: 'btn btn-sm btn-danger',
                    text: 'Block',
                    onclick: async () => {
                      const ok = await confirmDialog({
                        title: 'Block contact',
                        message: `Block ${chat.title}? They will not be able to message you.`,
                        confirmText: 'Block',
                        danger: true,
                      });
                      if (!ok) return;
                      try {
                        await api.post(`/api/users/${chat.peer.id}/block`, {});
                        toast('Contact blocked');
                        onBlocked?.(chat.id);
                      } catch (err) {
                        toastError(err);
                      }
                    },
                  }),
            )
          : null,
      ),
    );

    if (isGroup) {
      rows.push(
        h('div', { class: 'info-section' },
          h('button', { class: 'btn btn-block', text: 'Manage members', onclick: () => onManage?.() }),
        ),
      );
      rows.push(
        h('div', { class: 'info-section' },
          h('button', {
            class: 'btn btn-danger btn-block',
            text: 'Leave group',
            onclick: async () => {
              const ok = await confirmDialog({ title: 'Leave group', message: `Leave ${chat.title}?`, confirmText: 'Leave', danger: true });
              if (!ok) return;
              try {
                await api.post(`/api/chats/${chat.id}/leave`, {});
                onLeft?.(chat.id);
              } catch (err) { toastError(err); }
            },
          }),
        ),
      );
    }

    body.replaceChildren(
      h('div', { class: 'info-hero' }, heroAvatar, h('h4', { text: chat.title }), h('p', { class: 'muted', text: isGroup ? `${chat.members.length} members` : `@${chat.peer?.username || ''}` })),
      h('div', { class: 'info-section media-section' },
        h('div', { class: 'section-head' },
          h('h5', { text: 'Shared media' }),
          h('button', { class: 'link-btn', text: 'See all', onclick: () => onGallery?.() }),
        ),
        renderMedia(chat.id),
      ),
      ...rows,
    );
  }

  return { el, render };
}
