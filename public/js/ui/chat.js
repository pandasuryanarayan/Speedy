import { h, avatarEl, icon, fmtTime, fmtDay, sameDay, fmtLastSeen, fmtBytes, initials, hueFor } from '../dom.js';
import { lightbox } from './modals.js';
import { fetchAttachmentBlob } from '../api.js';

// Images fall back to an authenticated fetch if their signed URL is stale.
const imageCache = new Map();

function imageNode(attachment) {
  const img = h('img', {
    src: attachment.url,
    alt: attachment.name,
    loading: 'lazy',
    onclick: () => lightbox(img.src),
  });
  img.addEventListener('error', async () => {
    if (img.dataset.recovered) return;
    img.dataset.recovered = '1';
    try {
      let url = imageCache.get(attachment.id);
      if (!url) {
        const blob = await fetchAttachmentBlob(attachment.id);
        url = URL.createObjectURL(blob);
        imageCache.set(attachment.id, url);
      }
      img.src = url;
    } catch {
      /* leave the alt text in place */
    }
  });
  return img;
}

const QUICK_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const EMOJI_PALETTE = ['😀', '😄', '😊', '😉', '😍', '😘', '😎', '🤩', '😅', '😢', '😭', '😡', '🤔', '🙃', '😴', '👍', '👎', '👏', '🙏', '💪', '🔥', '✨', '🎉', '❤️', '💜', '✅', '📌', '🚀'];

export function createChatPane(handlers) {
  const head = h('div', { class: 'chat-head hidden' });
  const messagesEl = h('div', { class: 'messages', role: 'log', 'aria-live': 'polite' });
  const emptyEl = h('div', { class: 'chat-empty' });
  const composerEl = h('form', { class: 'composer hidden' });
  const pane = h('main', { class: 'chat-pane' }, head, messagesEl, emptyEl, composerEl);

  let currentChatId = null;
  let typingFlag = false;
  let typingTimer = null;

  /* ------------------------------- header ------------------------------- */
  function renderHead(state) {
    const chat = state.chat;
    if (!chat) {
      head.classList.add('hidden');
      return;
    }
    head.classList.remove('hidden');
    const avatar = chat.type === 'group'
      ? h('div', { class: 'avatar', dataset: { hue: hueFor(chat.id) }, text: initials(chat.title) })
      : avatarEl({ id: chat.peer?.id, name: chat.title, avatarUrl: chat.avatarUrl, online: chat.peer?.online }, { showPresence: true });

    const typingUsers = [...(state.typing.get(chat.id) || [])].filter((id) => id !== state.user.id);
    const sub = typingUsers.length
      ? 'typing…'
      : chat.type === 'group'
        ? `${chat.members.length} members`
        : chat.peer?.online
          ? 'online'
          : fmtLastSeen(chat.peer?.lastSeenAt);

    head.replaceChildren(
      h('button', { class: 'icon-btn mobile-only', 'aria-label': 'Back', html: icon('back'), onclick: handlers.onBack }),
      avatar,
      h(
        'div',
        { class: 'who', onclick: handlers.onOpenInfo },
        h('div', { class: 'who-name', text: chat.title }),
        h('div', { class: `who-sub ${typingUsers.length ? 'typing' : ''}`.trim(), text: sub }),
      ),
      h('button', { class: 'icon-btn', 'aria-label': 'Shared media', title: 'Shared media', html: icon('image'), onclick: handlers.onGallery }),
      h('button', { class: 'icon-btn', 'aria-label': 'Chat info', html: icon('info'), onclick: handlers.onOpenInfo }),
    );
  }

  /* ------------------------------ messages ------------------------------ */
  function tickNode(message, state) {
    if (message.failed) {
      return h('span', { class: 'tick failed', html: icon('alert'), title: 'Not sent' });
    }
    if (message.pending) {
      return h('span', { class: 'tick pending', html: icon('clock'), title: 'Waiting to send' });
    }
    if (message.sender?.id !== state.user.id) return null;
    const status = message.receipts?.status || 'sent';
    if (status === 'sent') return h('span', { class: 'tick', html: icon('check'), title: 'Sent' });
    return h('span', { class: `tick ${status === 'read' ? 'read' : ''}`.trim(), html: icon('checks'), title: status === 'read' ? 'Read' : 'Delivered' });
  }

  /**
   * Renders message text with @mentions highlighted. Built from text nodes and
   * spans - never innerHTML - so message content can never inject markup.
   */
  function textWithMentions(message, state) {
    const members = state.chat?.members || [];
    const byUsername = new Map(members.map((m) => [m.username.toLowerCase(), m]));
    const text = message.body || '';
    if (!text.includes('@') || !byUsername.size) return h('span', { text });

    const fragment = document.createDocumentFragment();
    const pattern = /@([a-zA-Z0-9._]{3,24})/g;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const member = byUsername.get(match[1].toLowerCase());
      if (!member) continue;
      if (match.index > cursor) fragment.append(document.createTextNode(text.slice(cursor, match.index)));
      const mine = member.id === state.user.id;
      fragment.append(h('span', { class: `mention ${mine ? 'mention-me' : ''}`.trim(), text: match[0] }));
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
    return fragment;
  }

  function bubbleContent(message, state) {
    const parts = [];

    if (message.replyTo) {
      parts.push(
        h(
          'span',
          { class: 'reply-quote' },
          h('span', { class: 'rq-name', text: message.replyTo.senderName }),
          h('span', { class: 'rq-text', text: message.replyTo.preview }),
        ),
      );
    }

    if (message.deletedAt) {
      parts.push(h('span', { class: 'deleted', text: 'This message was deleted' }));
    } else if (message.type === 'image' && message.attachment) {
      parts.push(h('span', { class: 'bubble-image' }, imageNode(message.attachment)));
      if (message.body) parts.push(h('span', { text: message.body }));
    } else if (message.type === 'file' && message.attachment) {
      parts.push(
        h(
          'button',
          {
            type: 'button',
            class: 'bubble-file',
            title: `Download ${message.attachment.name}`,
            onclick: () => handlers.onDownload(message.attachment),
          },
          h('span', { class: 'file-icon', html: icon('file') }),
          h(
            'span',
            { class: 'file-meta' },
            h('span', { class: 'file-name', text: message.attachment.name }),
            h('span', { class: 'file-size', text: fmtBytes(message.attachment.size) }),
          ),
          h('span', { class: 'file-dl', html: icon('download') }),
        ),
      );
      if (message.body) parts.push(h('span', { text: message.body }));
    } else {
      parts.push(textWithMentions(message, state));
    }

    const meta = h(
      'span',
      { class: 'bubble-meta' },
      message.editedAt ? h('span', { class: 'bubble-edited', text: 'edited' }) : null,
      h('span', { text: fmtTime(message.createdAt) }),
      tickNode(message, state),
    );
    parts.push(meta);
    return parts;
  }

  function messageNode(message, state) {
    if (message.type === 'system') {
      return h('div', { class: 'msg-system', text: message.seq === 1 ? 'Group created' : 'Conversation updated' });
    }

    const mine = message.sender?.id === state.user.id;
    const isGroup = state.chat?.type === 'group';
    const node = h('div', { class: `msg ${mine ? 'out' : 'in'}`.trim(), dataset: { id: message.id } });

    if (!mine && isGroup) {
      node.append(h('div', { class: 'msg-avatar' }, avatarEl({ id: message.sender?.id, name: message.sender?.displayName || '?', avatarUrl: message.sender?.avatarUrl })));
    }

    const bubble = h('div', { class: `bubble ${message.deletedAt ? 'deleted' : ''} ${message.type === 'image' ? 'bubble-image-wrap' : ''}`.trim() });
    if (!mine && isGroup && !message.deletedAt) bubble.append(h('div', { class: 'msg-sender', text: message.sender?.displayName || 'Unknown' }));
    for (const part of bubbleContent(message, state)) bubble.append(part);

    const group = h('div', { class: 'msg-group' }, bubble);

    if (message.reactions?.length) {
      group.append(
        h(
          'div',
          { class: 'reactions' },
          ...message.reactions.map((r) =>
            h(
              'button',
              {
                class: 'reaction',
                dataset: { mine: String(r.mine) },
                title: r.mine ? 'Remove your reaction' : 'React',
                onclick: () => handlers.onReact(message, r.emoji),
              },
              h('span', { text: r.emoji }),
              r.count > 1 ? h('span', { text: String(r.count) }) : null,
            ),
          ),
        ),
      );
    }

    if (!message.deletedAt) {
      const metaEl = bubble.querySelector('.bubble-meta');
      metaEl?.append(
        h('button', {
          type: 'button',
          class: 'bubble-menu-btn',
          'aria-label': 'Message actions',
          title: 'Message actions',
          html: icon('more'),
          onclick: (event) => {
            event.stopPropagation();
            openMessageMenu(event.currentTarget, message, mine);
          },
        }),
      );
    }

    node.append(group);
    return node;
  }

  function renderMessages(state) {
    const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 140;
    const prevHeight = messagesEl.scrollHeight;
    const prevTop = messagesEl.scrollTop;

    const nodes = [];
    if (state.hasMore) {
      nodes.push(
        h(
          'button',
          {
            class: 'btn btn-sm btn-ghost load-more',
            text: 'Load earlier messages',
            onclick: () => handlers.onLoadMore(),
          },
        ),
      );
    }

    let lastDay = null;
    for (const message of state.messages) {
      if (message.type !== 'system') {
        if (!lastDay || !sameDay(lastDay, message.createdAt)) {
          nodes.push(h('div', { class: 'day-sep', text: fmtDay(message.createdAt) }));
          lastDay = message.createdAt;
        }
      }
      nodes.push(messageNode(message, state));
    }

    messagesEl.replaceChildren(...nodes);

    if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
    else messagesEl.scrollTop = prevTop + (messagesEl.scrollHeight - prevHeight);
  }

  /* ------------------------------ composer ------------------------------ */
  function renderComposer(state) {
    const chat = state.chat;
    if (!chat) {
      composerEl.classList.add('hidden');
      return;
    }
    composerEl.classList.remove('hidden');

    if (chat.blockedByMe || chat.blockedMe) {
      composerEl.replaceChildren(
        h(
          'div',
          { class: 'composer-blocked' },
          h('span', {
            class: 'grow',
            text: chat.blockedByMe
              ? `You blocked ${chat.title}. Unblock to send messages.`
              : `${chat.title} has blocked you, so you cannot send messages.`,
          }),
          chat.blockedByMe
            ? h('button', { type: 'button', class: 'btn btn-sm', text: 'Unblock', onclick: () => handlers.onUnblock?.() })
            : null,
        ),
      );
      composerEl.onsubmit = null;
      return;
    }

    const fileInput = h('input', {
      type: 'file',
      class: 'sr-only',
      onchange: (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) handlers.onAttach(file);
      },
    });

    // A long chat name would wrap the placeholder and clip it, so fall back to "Message".
    const placeholder = chat.title.length > 22 ? 'Message' : `Message ${chat.title}`;
    const textarea = h('textarea', {
      class: 'composer-input',
      placeholder,
      rows: '1',
      maxlength: '4000',
      'aria-label': `Message ${chat.title}`,
    });

    const picker = h('div', { class: 'mention-picker hidden' });
    let pickerQuery = null;

    const closePicker = () => {
      pickerQuery = null;
      picker.classList.add('hidden');
      picker.replaceChildren();
    };

    const insertMention = (member) => {
      const value = textarea.value;
      const caret = textarea.selectionStart ?? value.length;
      const before = value.slice(0, caret).replace(/@([a-zA-Z0-9._]*)$/, '');
      const after = value.slice(caret);
      const token = `@${member.username} `;
      textarea.value = before + token + after;
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = (before + token).length;
      closePicker();
      textarea.dispatchEvent(new Event('input'));
    };

    const updatePicker = () => {
      if (!state.chat || state.chat.type !== 'group') return closePicker();
      const caret = textarea.selectionStart ?? 0;
      const before = textarea.value.slice(0, caret);
      const match = /(?:^|\s)@([a-zA-Z0-9._]{0,24})$/.exec(before);
      if (!match) return closePicker();

      pickerQuery = match[1].toLowerCase();
      const candidates = state.chat.members
        .filter((m) => m.id !== state.user.id)
        .filter((m) => !pickerQuery || m.username.toLowerCase().includes(pickerQuery) || m.displayName.toLowerCase().includes(pickerQuery))
        .slice(0, 6);

      if (!candidates.length) return closePicker();

      picker.replaceChildren(
        ...candidates.map((member) =>
          h(
            'button',
            { type: 'button', 'aria-selected': 'false', onmousedown: (e) => { e.preventDefault(); insertMention(member); } },
            h('span', { class: 'name', text: member.displayName }),
            h('span', { class: 'handle', text: `@${member.username}` }),
          ),
        ),
      );
      picker.classList.remove('hidden');
    };

    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
      updatePicker();
      if (!typingFlag) {
        typingFlag = true;
        handlers.onTyping(true);
      }
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
        typingFlag = false;
        handlers.onTyping(false);
      }, 1800);
    });

    textarea.addEventListener('keydown', (e) => {
      if (pickerQuery !== null && !picker.classList.contains('hidden')) {
        if (e.key === 'Escape') {
          e.preventDefault();
          return closePicker();
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const first = picker.querySelector('button');
          if (first) first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          return undefined;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });

    const submit = () => {
      const text = textarea.value.trim();
      if (!text && !state.pendingAttachment) return;
      handlers.onSend({ text, attachment: state.pendingAttachment });
      textarea.value = '';
      textarea.style.height = 'auto';
      clearTimeout(typingTimer);
      typingFlag = false;
      handlers.onTyping(false);
      textarea.focus();
    };

    const emojiBar = h('div', { class: 'emoji-bar hidden' });
    emojiBar.replaceChildren(
      ...EMOJI_PALETTE.map((emoji) =>
        h('button', {
          type: 'button',
          text: emoji,
          onclick: () => {
            const start = textarea.selectionStart ?? textarea.value.length;
            textarea.value = `${textarea.value.slice(0, start)}${emoji}${textarea.value.slice(textarea.selectionEnd ?? start)}`;
            textarea.focus();
            textarea.selectionStart = textarea.selectionEnd = start + emoji.length;
            textarea.dispatchEvent(new Event('input'));
          },
        }),
      ),
    );

    const rows = [];

    if (state.replyTo) {
      rows.push(
        h(
          'div',
          { class: 'composer-reply' },
          h(
            'span',
            { class: 'grow' },
            h('span', { class: 'rq-name', text: `Replying to ${state.replyTo.sender?.displayName || 'message'}` }),
            h('span', { class: 'rq-text', text: state.replyTo.deletedAt ? 'This message was deleted' : state.replyTo.type === 'text' ? state.replyTo.body : state.replyTo.type === 'image' ? 'Photo' : 'Attachment' }),
          ),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Cancel reply', html: icon('x'), onclick: handlers.onCancelReply }),
        ),
      );
    }

    if (state.pendingAttachment) {
      const att = state.pendingAttachment;
      rows.push(
        h(
          'div',
          { class: 'attach-preview' },
          att.isImage ? h('img', { src: att.url, alt: att.name }) : h('span', { class: 'file-icon', html: icon('file') }),
          h('span', { class: 'grow' }, h('span', { class: 'file-name', text: att.name }), h('span', { class: 'file-size', text: fmtBytes(att.size) })),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove attachment', html: icon('x'), onclick: handlers.onCancelAttachment }),
        ),
      );
    }

    rows.push(picker);
    rows.push(emojiBar);
    rows.push(
      h(
        'div',
        { class: 'composer-row' },
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Attach a file', title: 'Attach', html: icon('clip'), onclick: () => fileInput.click() }),
        textarea,
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Emoji', title: 'Emoji', html: icon('smile'), onclick: () => emojiBar.classList.toggle('hidden') }),
        h('button', { type: 'submit', class: 'send-btn', 'aria-label': 'Send message', html: icon('send') }),
        fileInput,
      ),
    );

    composerEl.replaceChildren(...rows);
    composerEl.onsubmit = (e) => {
      e.preventDefault();
      submit();
    };
    setTimeout(() => textarea.focus(), 20);
  }

  /* ------------------------------ menus ------------------------------ */
  function closeMenus() {
    document.querySelectorAll('.menu').forEach((m) => m.remove());
  }
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (target instanceof Element && (target.closest('.menu') || target.closest('.bubble-menu-btn'))) return;
    closeMenus();
  });
  document.addEventListener('scroll', closeMenus, true);

  function openMenu(anchor, items) {
    closeMenus();
    const rect = anchor.getBoundingClientRect();
    const menu = h('div', { class: 'menu', role: 'menu' }, ...items);
    document.body.append(menu);
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.min(Math.max(8, rect.left - width / 2), window.innerWidth - width - 8);
    const top = rect.top - height - 8 < 8 ? rect.bottom + 8 : rect.top - height - 8;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    return menu;
  }

  function openMessageMenu(anchor, message, mine) {
    const items = [];

    if (!message.deletedAt) {
      items.push(
        h(
          'div',
          { class: 'menu-emoji' },
          ...QUICK_EMOJI.map((emoji) =>
            h('button', {
              type: 'button',
              text: emoji,
              title: `React with ${emoji}`,
              onclick: () => {
                closeMenus();
                handlers.onReact(message, emoji);
              },
            }),
          ),
        ),
        h('div', { class: 'menu-sep' }),
      );
    }

    items.push(
      h('button', {
        type: 'button',
        html: `${icon('reply')}<span>Reply</span>`,
        onclick: () => {
          closeMenus();
          handlers.onReply(message);
        },
      }),
    );
    if (message.type === 'text' && !message.deletedAt) {
      items.push(
        h('button', {
          type: 'button',
          html: `${icon('edit')}<span>Copy text</span>`,
          onclick: async () => {
            closeMenus();
            try {
              await navigator.clipboard.writeText(message.body || '');
              handlers.onNotify?.('Copied to clipboard');
            } catch {
              handlers.onNotify?.('Could not copy', 'error');
            }
          },
        }),
      );
    }
    if (!mine && !message.deletedAt) {
      items.push(h('div', { class: 'menu-sep' }));
      items.push(
        h('button', {
          type: 'button',
          class: 'danger',
          html: `${icon('flag')}<span>Report message</span>`,
          onclick: () => {
            closeMenus();
            handlers.onReport?.(message);
          },
        }),
      );
    }
    if (!message.deletedAt) {
      items.push(
        h('button', {
          type: 'button',
          class: 'danger',
          html: `${icon('trash')}<span>Delete for me</span>`,
          onclick: () => {
            closeMenus();
            handlers.onHide(message);
          },
        }),
      );
    }
    if (mine && !message.deletedAt) {
      items.push(h('div', { class: 'menu-sep' }));
      if (message.type === 'text') {
        items.push(
          h('button', {
            type: 'button',
            html: `${icon('edit')}<span>Edit message</span>`,
            onclick: () => {
              closeMenus();
              handlers.onEdit(message);
            },
          }),
        );
      }
      items.push(
        h('button', {
          type: 'button',
          class: 'danger',
          html: `${icon('trash')}<span>Delete for everyone</span>`,
          onclick: () => {
            closeMenus();
            handlers.onDelete(message);
          },
        }),
      );
    }
    openMenu(anchor, items);
  }

  /* ------------------------------ public ------------------------------ */
  function renderEmpty(state) {
    const chat = state.chat;
    if (chat) {
      emptyEl.classList.add('hidden');
      messagesEl.classList.remove('hidden');
      return;
    }
    messagesEl.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    emptyEl.replaceChildren(
      h('div', { class: 'art', html: icon('chat') }),
      h('h3', { text: 'Your messages, instantly' }),
      h('p', { text: 'Pick a conversation on the left, or start a new one. Everything is delivered in real time and encrypted at rest.' }),
      h('button', { class: 'btn btn-primary', text: 'Start a chat', onclick: handlers.onNewChat }),
    );
  }

  function update(state) {
    const chatChanged = state.chat?.id !== currentChatId;
    currentChatId = state.chat?.id || null;
    renderEmpty(state);
    renderHead(state);
    renderComposer(state);
    if (state.chat) renderMessages(state);
    if (chatChanged) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  return {
    el: pane,
    update,
    scrollToBottom: () => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    },
    isNearBottom: () => messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 140,
    focusComposer: () => composerEl.querySelector('textarea')?.focus(),
  };
}
