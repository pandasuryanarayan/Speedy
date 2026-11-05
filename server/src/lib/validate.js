import { z } from 'zod';
import { unprocessable } from './errors.js';

/** Parse input with a zod schema, throwing a 422 AppError with field details. */
export function parse(schema, input) {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(root)',
      message: issue.message,
    }));
    throw unprocessable('Please check the highlighted fields', details);
  }
  return result.data;
}

const username = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(24, 'Username must be at most 24 characters')
  .regex(/^[a-zA-Z0-9._]+$/, 'Use letters, numbers, dots and underscores only')
  .transform((v) => v.toLowerCase());

const password = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((v) => v.trim().length > 0, 'Password cannot be blank');

export const schemas = {
  register: z.object({
    username,
    displayName: z.string().trim().min(1, 'Tell us your name').max(48),
    password,
  }),
  login: z.object({
    username: z.string().trim().min(1).max(64).transform((v) => v.toLowerCase()),
    password: z.string().min(1).max(128),
  }),
  updateProfile: z
    .object({
      displayName: z.string().trim().min(1).max(48).optional(),
      about: z.string().trim().max(140).nullable().optional(),
    })
    .refine((v) => v.displayName !== undefined || v.about !== undefined, 'Nothing to update'),
  createDirectChat: z.object({ userId: z.string().uuid() }),
  createGroupChat: z.object({
    title: z.string().trim().min(1, 'Name the group').max(64),
    memberIds: z.array(z.string().uuid()).min(1, 'Add at least one member').max(255),
  }),
  updateChat: z.object({ title: z.string().trim().min(1).max(64) }),
  addMembers: z.object({ memberIds: z.array(z.string().uuid()).min(1).max(255) }),
  sendMessage: z.object({
    chatId: z.string().uuid(),
    clientId: z.string().max(64).optional(),
    type: z.enum(['text', 'image', 'file']).default('text'),
    body: z.string().max(4000).optional(),
    attachmentId: z.string().uuid().optional(),
    replyToId: z.string().uuid().optional(),
    unlock: z.string().max(200).optional(),
  }),
  editMessage: z.object({ body: z.string().trim().min(1).max(4000) }),
  react: z.object({ emoji: z.string().min(1).max(16) }),
  listMessages: z.object({
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(40),
  }),
  searchUsers: z.object({ q: z.string().trim().max(48).default(''), limit: z.coerce.number().int().min(1).max(20).default(10) }),
  searchMessages: z.object({ q: z.string().trim().min(1).max(120) }),
  markRead: z.object({ messageId: z.string().uuid().optional(), seq: z.coerce.number().int().nonnegative().optional() }),
};
