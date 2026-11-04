import { EventEmitter } from 'node:events';

/**
 * Internal event bus. HTTP and socket handlers publish domain events here and
 * the realtime layer fans them out, so business logic never imports socket.io.
 */
export const bus = new EventEmitter();
bus.setMaxListeners(50);

export const EVENTS = Object.freeze({
  MESSAGE_NEW: 'message:new',
  MESSAGE_UPDATED: 'message:updated',
  MESSAGE_DELETED: 'message:deleted',
  RECEIPT_UPDATE: 'receipt:update',
  CHAT_NEW: 'chat:new',
  CHAT_UPDATED: 'chat:updated',
  PRESENCE: 'presence',
  TYPING: 'typing',
});
