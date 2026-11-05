import { h, avatarEl, icon, fmtListTime, initials, hueFor } from '../dom.js';
import { activeChat } from '../store.js';

export function createSidebar({ onSelectChat, onNewChat, onNewGroup, onProfile, onFilter, onSearch }) {
  const meSlot = h('div', { class: 'me-avatar' });
  const meName = h('div', { class: 'me-name truncate' });
  const meSub = h('div', { class: 'me-sub truncate' });
  const list = h('div', { class: 'chat-list' });
  const searchInput = h('input', {
    class: 'search-input',
    type: 'search',
    placeholder: 'Search chats',
    'aria-label': 'Search chats',
    oninput: (e) => onSearch(e.target.value),
  });

  const chips = ['all', 'unread', 'groups'].map((key) =>
    h('button', {
      class: 'chip',
      text: key === 'all' ? 'All' : key === 'unread' ? 'Unread' : 'Groups',
      'aria-pressed': String(key === 'all'),
      dataset: { filter: key },
      onclick: () => onFilter(key),
    }),
  );

  const el = h(
    'aside',
    { class: 'sidebar' },
    h(
      'div',
      { class: 'sidebar-head' },
      h('button', { class: 'me', onclick: onProfile, 'aria-label': 'Open your profile' }, meSlot, h('div', { class: 'grow' }, meName, meSub)),
      h('button', { class: 'icon-btn', 'aria-label': 'New group', title: 'New group', html: icon('users'), onclick: onNewGroup }),
      h('button', { class: 'icon-btn', 'aria-label': 'New chat', title: 'New chat', html: icon('plus'), onclick: onNewChat }),
    ),
    h('div', { class: 'search-wrap' }, h('span', { html: icon('search') }), searchInput),
    h('div', { class: 'filters' }, ...chips),
    list,
  );

  function chatItem(chat, isActive) {
    const typing = chat.id === activeChat()?.id ? chat._typing : null;
    const preview = chat.locked
      ? 'Locked chat — password required'
      : typing
        ? 'typing…'
        : chat.lastMessage?.preview || 'No messages yet';
    const sender = !typing && chat.lastMessage && chat.type === 'group' ? `${chat.lastMessage.senderName}: ` : '';
    const avatar = chat.type === 'group'
      ? h('div', { class: 'avatar', dataset: { hue: hueFor(chat.id) }, text: initials(chat.title) })
      : avatarEl({ id: chat.peer?.id, name: chat.title, avatarUrl: chat.avatarUrl, online: chat.peer?.online }, { showPresence: true });

    return h(
      'button',
      {
        class: 'chat-item',
        'aria-current': String(isActive),
        onclick: () => onSelectChat(chat.id),
      },
      avatar,
      h(
        'span',
        { class: 'chat-item-body' },
        h(
          'span',
          { class: 'chat-item-top' },
          h('span', { class: 'chat-item-name', text: chat.title }),
          chat.pinned ? h('span', { class: 'chat-flag', title: 'Pinned', html: icon('pin') }) : null,
          chat.locked ? h('span', { class: 'chat-flag', title: 'Locked', html: icon('lock') }) : null,
          h('span', { class: 'chat-item-time', text: chat.lastMessage ? fmtListTime(chat.lastMessage.createdAt) : '' }),
        ),
        h(
          'span',
          { class: 'chat-item-bottom' },
          h('span', { class: `chat-item-preview ${typing ? 'typing' : ''}`.trim(), text: `${sender}${preview}` }),
          chat.unread > 0 && !isActive ? h('span', { class: 'badge', text: chat.unread > 99 ? '99+' : String(chat.unread) }) : null,
        ),
      ),
    );
  }

  function update(state) {
    if (state.user) {
      meSlot.replaceChildren(avatarEl({ id: state.user.id, name: state.user.displayName, avatarUrl: state.user.avatarUrl }));
      meName.textContent = state.user.displayName;
      meSub.textContent = `@${state.user.username}`;
    }

    for (const chip of chips) {
      chip.setAttribute('aria-pressed', String(chip.dataset.filter === state.filter));
    }
    if (document.activeElement !== searchInput && searchInput.value !== state.query) searchInput.value = state.query;

    const query = state.query.trim().toLowerCase();
    let chats = state.chats.filter((c) => {
      if (state.filter === 'unread' && !c.unread) return false;
      if (state.filter === 'groups' && c.type !== 'group') return false;
      if (!query) return true;
      return c.title.toLowerCase().includes(query) || (c.lastMessage?.preview || '').toLowerCase().includes(query);
    });

    if (!chats.length) {
      list.replaceChildren(
        h('div', { class: 'empty-list', text: query ? 'No chats match your search' : state.filter === 'all' ? 'No chats yet — start one with the + button' : 'Nothing here yet' }),
      );
      return;
    }

    list.replaceChildren(...chats.map((chat) => chatItem(chat, chat.id === state.activeChatId)));
  }

  return { el, update };
}
