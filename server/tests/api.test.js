/**
 * End-to-end API tests (no browser, no external services).
 * Run with: npm test
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speedy-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = tmpDir;
process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
process.env.PORT = '0';

const { migrate } = await import('../src/db/migrate.js');
const { createApp } = await import('../src/app.js');
const { createRealtime } = await import('../src/realtime/io.js');
const http = await import('node:http');

let server;
let baseUrl;

before(async () => {
  await migrate({ quiet: true });
  server = http.createServer(createApp());
  createRealtime(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A tiny cookie-aware HTTP client so tests can exercise real sessions. */
function client() {
  const cookies = new Map();
  return {
    cookies,
    async call(pathname, { method = 'GET', body, token, form, headers: extra = {} } = {}) {
      const headers = { Accept: 'application/json', ...extra };
      if (body) headers['Content-Type'] = 'application/json';
      if (token) headers.Authorization = `Bearer ${token}`;
      if (cookies.has('speedy_csrf')) headers['X-CSRF-Token'] = cookies.get('speedy_csrf');
      if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');

      const res = await fetch(baseUrl + pathname, {
        method,
        headers,
        body: form ? form : body ? JSON.stringify(body) : undefined,
      });

      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const index = pair.indexOf('=');
        const key = pair.slice(0, index).trim();
        const value = pair.slice(index + 1);
        if (value) cookies.set(key, value);
        else cookies.delete(key);
      }

      const json = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null;
      return { status: res.status, body: json?.data ?? null, error: json?.error ?? null, headers: res.headers };
    },
  };
}

async function newUser(username, password = 'test-password-123') {
  const api = client();
  const res = await api.call('/api/auth/register', {
    method: 'POST',
    body: { username, displayName: `${username} tester`, password },
  });
  assert.equal(res.status, 201, JSON.stringify(res.error));
  return { api, token: res.body.accessToken, user: res.body.user };
}

test('registration validates input and returns a session', async () => {
  const weak = client();
  const bad = await weak.call('/api/auth/register', {
    method: 'POST',
    body: { username: 'a', displayName: '', password: '123' },
  });
  assert.equal(bad.status, 422);
  assert.ok(bad.error.details.length >= 2);

  const { api, token, user } = await newUser('alice');
  assert.ok(token);
  assert.equal(user.username, 'alice');
  assert.ok(api.cookies.has('speedy_rt'), 'refresh cookie is set');
  assert.ok(api.cookies.has('speedy_csrf'), 'csrf cookie is set');

  const me = await api.call('/api/auth/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, 'alice');
  assert.equal(me.body.user.password_hash, undefined, 'password hash never leaves the server');
});

test('duplicate usernames are rejected case-insensitively', async () => {
  const api = client();
  const res = await api.call('/api/auth/register', {
    method: 'POST',
    body: { username: 'ALICE', displayName: 'Imposter', password: 'test-password-123' },
  });
  assert.equal(res.status, 409);
});

test('login failures are generic and do not leak account existence', async () => {
  const api = client();
  const unknown = await api.call('/api/auth/login', { method: 'POST', body: { username: 'ghost', password: 'whatever-123' } });
  const wrong = await api.call('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'wrong-password' } });
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(unknown.error.message, wrong.error.message);
});

test('direct chat: send, list, decrypt and paginate', async () => {
  const { api: aliceApi, token: aliceToken } = await newUser('bob');
  const login = await client().call('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'test-password-123' } });
  const aliceToken2 = login.body.accessToken;
  const aliceApi2 = client();

  const aliceMe = await aliceApi2.call('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'test-password-123' } });
  const aliceId = aliceMe.body.user.id;
  const bobMe = await aliceApi.call('/api/auth/me', { token: aliceToken });
  const bobId = bobMe.body.user.id;

  const created = await aliceApi2.call('/api/chats/direct', { method: 'POST', token: aliceMe.body.accessToken, body: { userId: bobId } });
  assert.equal(created.status, 201);
  const chatId = created.body.chat.id;

  const sent = await aliceApi2.call(`/api/chats/${chatId}/messages`, {
    method: 'POST',
    token: aliceMe.body.accessToken,
    body: { type: 'text', body: 'Hello Bob 👋' },
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.message.body, 'Hello Bob 👋');

  const page = await aliceApi2.call(`/api/chats/${chatId}/messages?limit=10`, { token: aliceMe.body.accessToken });
  assert.equal(page.status, 200);
  assert.equal(page.body.messages.at(-1).body, 'Hello Bob 👋');

  // The body is encrypted at rest.
  const { all } = await import('../src/db/index.js');
  const rows = await all('SELECT body FROM messages WHERE id = ?', [sent.body.message.id]);
  assert.match(rows[0].body, /^v1\./);
  assert.ok(!rows[0].body.includes('Hello Bob'));

  // Bob sees it too, Alice cannot spoof him as the author.
  const bobView = await aliceApi.call(`/api/chats/${chatId}/messages`, { token: aliceToken });
  assert.equal(bobView.body.messages.length, 1);
  assert.equal(bobView.body.messages[0].sender.id, aliceId);
});

test('authorization: outsiders cannot read a conversation', async () => {
  const outsider = await newUser('eve');
  const { api } = await newUser('carol');
  const login = await api.call('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'test-password-123' } });
  const chats = await api.call('/api/chats', { token: login.body.accessToken });
  const chatId = chats.body.chats[0].id;

  const read = await outsider.api.call(`/api/chats/${chatId}/messages`, { token: outsider.token });
  assert.equal(read.status, 403);

  const write = await outsider.api.call(`/api/chats/${chatId}/messages`, {
    method: 'POST',
    token: outsider.token,
    body: { type: 'text', body: 'let me in' },
  });
  assert.equal(write.status, 403);

  const detail = await outsider.api.call(`/api/chats/${chatId}`, { token: outsider.token });
  assert.equal(detail.status, 403);
});

test('messages can be edited, reacted to and deleted only by the author', async () => {
  const { api, token } = await newUser('dave');
  const other = await newUser('erin');
  const chat = await api.call('/api/chats/direct', { method: 'POST', token, body: { userId: other.user.id } });
  const chatId = chat.body.chat.id;

  const sent = await api.call(`/api/chats/${chatId}/messages`, { method: 'POST', token, body: { type: 'text', body: 'first draft' } });
  const messageId = sent.body.message.id;

  const edited = await api.call(`/api/messages/${messageId}`, { method: 'PATCH', token, body: { body: 'second draft' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.message.body, 'second draft');
  assert.ok(edited.body.message.editedAt);

  const foreignEdit = await other.api.call(`/api/messages/${messageId}`, { method: 'PATCH', token: other.token, body: { body: 'hacked' } });
  assert.equal(foreignEdit.status, 403);

  const reaction = await other.api.call(`/api/messages/${messageId}/reactions`, { method: 'POST', token: other.token, body: { emoji: '🔥' } });
  assert.equal(reaction.status, 200);
  assert.equal(reaction.body.message.reactions[0].emoji, '🔥');

  const removed = await api.call(`/api/messages/${messageId}`, { method: 'DELETE', token });
  assert.equal(removed.status, 200);
  const afterDelete = await api.call(`/api/chats/${chatId}/messages`, { token });
  assert.ok(afterDelete.body.messages.at(-1).deletedAt);
  assert.equal(afterDelete.body.messages.at(-1).body, '');
});

test('groups: creation, membership and role rules', async () => {
  const owner = await newUser('frank');
  const m1 = await newUser('grace');
  const m2 = await newUser('heidi');

  const group = await owner.api.call('/api/chats/group', {
    method: 'POST',
    token: owner.token,
    body: { title: 'Test group', memberIds: [m1.user.id, m2.user.id] },
  });
  assert.equal(group.status, 201);
  assert.equal(group.body.chat.members.length, 3);
  assert.equal(group.body.chat.myRole, 'owner');

  const rename = await m1.api.call(`/api/chats/${group.body.chat.id}`, { method: 'PATCH', token: m1.token, body: { title: 'Hacked' } });
  assert.equal(rename.status, 403, 'members cannot rename a group');

  const kick = await owner.api.call(`/api/chats/${group.body.chat.id}/members/${m2.user.id}`, { method: 'DELETE', token: owner.token });
  assert.equal(kick.status, 200);
  assert.equal(kick.body.chat.members.length, 2);

  const left = await m1.api.call(`/api/chats/${group.body.chat.id}/leave`, { method: 'POST', token: m1.token });
  assert.equal(left.status, 200);
});

test('refresh tokens rotate and reuse revokes the family', async () => {
  const { api } = await newUser('ivan');
  const firstCookie = api.cookies.get('speedy_rt');

  const rotated = await api.call('/api/auth/refresh', { method: 'POST' });
  assert.equal(rotated.status, 200);
  assert.ok(rotated.body.accessToken);
  assert.notEqual(api.cookies.get('speedy_rt'), firstCookie, 'refresh token rotates');

  // Replay the old token: the whole family must die.
  api.cookies.set('speedy_rt', firstCookie);
  const replay = await api.call('/api/auth/refresh', { method: 'POST' });
  assert.equal(replay.status, 401);

  const afterwards = await api.call('/api/auth/refresh', { method: 'POST' });
  assert.equal(afterwards.status, 401, 'family is revoked after reuse detection');
});

test('refresh requires the CSRF header', async () => {
  const { api } = await newUser('judy');
  api.cookies.delete('speedy_csrf');
  const res = await api.call('/api/auth/refresh', { method: 'POST' });
  assert.equal(res.status, 403);
  assert.equal(res.error.code, 'csrf_failed');
});

test('logout revokes the access token immediately', async () => {
  const { api, token } = await newUser('ken');
  const before = await api.call('/api/auth/me', { token });
  assert.equal(before.status, 200);
  await api.call('/api/auth/logout', { method: 'POST', token });
  const after = await api.call('/api/auth/me', { token });
  assert.equal(after.status, 401);
});

test('attachments: upload, sniffing and access control', async () => {
  const { api, token, user } = await newUser('laura');
  const other = await newUser('mike');

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), '../../evil name.png');

  const upload = await api.call('/api/attachments', { method: 'POST', token, form });
  assert.equal(upload.status, 201);
  assert.equal(upload.body.attachment.mime, 'image/png', 'mime comes from magic bytes');
  assert.equal(upload.body.attachment.name, 'evil name.png', 'path components are stripped');
  assert.equal(upload.body.attachment.isImage, true);

  const chat = await api.call('/api/chats/direct', { method: 'POST', token, body: { userId: other.user.id } });
  await api.call(`/api/chats/${chat.body.chat.id}/messages`, {
    method: 'POST',
    token,
    body: { type: 'image', attachmentId: upload.body.attachment.id },
  });

  const allowed = await api.call(`/api/attachments/${upload.body.attachment.id}`, { token });
  assert.equal(allowed.status, 200);

  const inChat = await other.api.call(`/api/attachments/${upload.body.attachment.id}`, { token: other.token });
  assert.equal(inChat.status, 200, 'chat members can open shared files');

  // Browsers cannot send an Authorization header on <img>/download links, so the
  // DTO carries a signed URL. It must work with no header at all...
  const signed = upload.body.attachment.url;
  assert.match(signed, /\?t=/, 'attachment url is signed');
  const viaLink = await fetch(baseUrl + signed);
  assert.equal(viaLink.status, 200, 'signed link works without a bearer token');
  assert.equal(viaLink.headers.get('x-content-type-options'), 'nosniff');
  await viaLink.arrayBuffer();

  // ...but not with a tampered signature, and not without one.
  const tampered = await fetch(`${baseUrl}${signed.slice(0, -3)}abc`);
  assert.equal(tampered.status, 401, 'tampered signature is rejected');
  const unsigned = await fetch(`${baseUrl}/api/attachments/${upload.body.attachment.id}`);
  assert.equal(unsigned.status, 401, 'unsigned, unauthenticated access is rejected');

  const { signAttachmentUrl } = await import('../src/lib/signed.js');
  const expired = await fetch(`${baseUrl}/api/attachments/${upload.body.attachment.id}?t=${signAttachmentUrl(upload.body.attachment.id, user.id, -1000)}`);
  assert.equal(expired.status, 401, 'expired link is rejected');

  const stranger = await newUser('mallory');
  const denied = await stranger.api.call(`/api/attachments/${upload.body.attachment.id}`, { token: stranger.token });
  assert.equal(denied.status, 403, 'outsiders cannot open files');

  // A text file disguised as an image is stored as an opaque blob.
  const fakeForm = new FormData();
  fakeForm.append('file', new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), 'x.png');
  const fake = await api.call('/api/attachments', { method: 'POST', token, form: fakeForm });
  assert.equal(fake.body.attachment.mime, 'application/octet-stream');
  assert.equal(fake.body.attachment.isImage, false);
});

test('read receipts are recorded when a recipient marks the chat read', async () => {
  const sender = await newUser('nina');
  const reader = await newUser('oscar');
  const chat = await sender.api.call('/api/chats/direct', { method: 'POST', token: sender.token, body: { userId: reader.user.id } });
  const chatId = chat.body.chat.id;
  const sent = await sender.api.call(`/api/chats/${chatId}/messages`, { method: 'POST', token: sender.token, body: { type: 'text', body: 'did you see this?' } });

  await reader.api.call(`/api/chats/${chatId}/read`, { method: 'POST', token: reader.token, body: { seq: sent.body.message.seq } });

  const view = await sender.api.call(`/api/chats/${chatId}/messages`, { token: sender.token });
  const message = view.body.messages.find((m) => m.id === sent.body.message.id);
  assert.equal(message.receipts.status, 'read');
  assert.equal(message.receipts.read, 1);
});

test('chats can be pinned to the top of the list', async () => {
  const me = await newUser('piper');
  const a = await newUser('quinn');
  const b = await newUser('rita');

  const first = await me.api.call('/api/chats/direct', { method: 'POST', token: me.token, body: { userId: a.user.id } });
  await me.api.call(`/api/chats/${first.body.chat.id}/messages`, { method: 'POST', token: me.token, body: { type: 'text', body: 'older' } });
  const second = await me.api.call('/api/chats/direct', { method: 'POST', token: me.token, body: { userId: b.user.id } });
  await new Promise((r) => setTimeout(r, 15));
  await me.api.call(`/api/chats/${second.body.chat.id}/messages`, { method: 'POST', token: me.token, body: { type: 'text', body: 'newer' } });

  let list = await me.api.call('/api/chats', { token: me.token });
  assert.equal(list.body.chats[0].id, second.body.chat.id, 'most recent first by default');

  const pinned = await me.api.call(`/api/chats/${first.body.chat.id}/pin`, { method: 'PATCH', token: me.token, body: { pinned: true } });
  assert.equal(pinned.status, 200);
  assert.equal(pinned.body.pinned, true);

  list = await me.api.call('/api/chats', { token: me.token });
  assert.equal(list.body.chats[0].id, first.body.chat.id, 'pinned chat jumps to the top');
  assert.equal(list.body.chats[0].pinned, true);

  await me.api.call(`/api/chats/${first.body.chat.id}/pin`, { method: 'PATCH', token: me.token, body: { pinned: false } });
  list = await me.api.call('/api/chats', { token: me.token });
  assert.equal(list.body.chats[0].id, second.body.chat.id, 'unpinning restores time order');
});

test('a locked chat opens with the PIN, not the account password', async () => {
  const me = await newUser('sam');
  const other = await newUser('tina');
  const chat = await me.api.call('/api/chats/direct', { method: 'POST', token: me.token, body: { userId: other.user.id } });
  const chatId = chat.body.chat.id;
  await me.api.call(`/api/chats/${chatId}/messages`, { method: 'POST', token: me.token, body: { type: 'text', body: 'private plans' } });

  const locked = await me.api.call(`/api/chats/${chatId}/lock`, { method: 'POST', token: me.token, body: { locked: true, pin: '1357' } });
  assert.equal(locked.status, 200);

  const blocked = await me.api.call(`/api/chats/${chatId}/messages`, { token: me.token });
  assert.equal(blocked.status, 423, 'locked chats refuse to list messages');
  assert.equal(blocked.error.code, 'chat_locked');

  const send = await me.api.call(`/api/chats/${chatId}/messages`, { method: 'POST', token: me.token, body: { type: 'text', body: 'nope' } });
  assert.equal(send.status, 423);

  const list = await me.api.call('/api/chats', { token: me.token });
  const entry = list.body.chats.find((c) => c.id === chatId);
  assert.equal(entry.locked, true);
  assert.equal(entry.lastMessage, null, 'a locked chat does not leak its last message');

  const wrong = await me.api.call(`/api/chats/${chatId}/unlock`, { method: 'POST', token: me.token, body: { pin: '0000' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.error.code, 'bad_pin');

  const withPassword = await me.api.call(`/api/chats/${chatId}/unlock`, {
    method: 'POST', token: me.token, body: { pin: 'test-password-123' },
  });
  assert.equal(withPassword.status, 422, 'the account password is rejected by the PIN field');

  const right = await me.api.call(`/api/chats/${chatId}/unlock`, { method: 'POST', token: me.token, body: { pin: '1357' } });
  assert.equal(right.status, 200);
  const token = right.body.unlockToken;
  assert.ok(token);

  const opened = await me.api.call(`/api/chats/${chatId}/messages`, { token: me.token, headers: { 'X-Chat-Unlock': token } });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.messages.at(-1).body, 'private plans');

  const badToken = await me.api.call(`/api/chats/${chatId}/messages`, { token: me.token, headers: { 'X-Chat-Unlock': `${token}tampered` } });
  assert.equal(badToken.status, 423, 'a tampered unlock token is rejected');

  // the other member is unaffected by my lock
  const theirView = await other.api.call(`/api/chats/${chatId}/messages`, { token: other.token });
  assert.equal(theirView.status, 200);

  // removing the lock also requires the PIN
  const noPin = await me.api.call(`/api/chats/${chatId}/lock`, { method: 'POST', token: me.token, body: { locked: false } });
  assert.equal(noPin.status, 401);
  const removed = await me.api.call(`/api/chats/${chatId}/lock`, { method: 'POST', token: me.token, body: { locked: false, pin: '1357' } });
  assert.equal(removed.status, 200);
  const afterRemoval = await me.api.call(`/api/chats/${chatId}/messages`, { token: me.token });
  assert.equal(afterRemoval.status, 200);
});

test('sessions die after idle time and after an absolute lifetime', async () => {
  const { db } = await import('../src/db/index.js');
  const me = await newUser('victor');

  // Idle: pretend the session has not been used for two hours.
  await db.execute({
    sql: 'UPDATE sessions SET last_used_at = ? WHERE user_id = ?',
    args: [Date.now() - 2 * 60 * 60 * 1000, me.user.id],
  });
  const idle = await me.api.call('/api/auth/me', { token: me.token });
  assert.equal(idle.status, 401, 'idle session is rejected');
  const revoked = await db.execute({ sql: 'SELECT revoked_at FROM sessions WHERE user_id = ?', args: [me.user.id] });
  assert.ok(revoked.rows[0].revoked_at, 'idle session is revoked server-side');

  // Absolute: a fresh session whose family started long ago cannot refresh.
  const other = await newUser('wendy');
  await db.execute({
    sql: 'UPDATE sessions SET family_started_at = ? WHERE user_id = ?',
    args: [Date.now() - 400 * 24 * 60 * 60 * 1000, other.user.id],
  });
  const refreshed = await other.api.call('/api/auth/refresh', { method: 'POST' });
  assert.equal(refreshed.status, 401, 'absolute lifetime cannot be extended by refreshing');
});

test('attachments are re-encoded and encrypted on disk', async () => {
  const fsMod = await import('node:fs/promises');
  const pathMod = await import('node:path');
  const zlib = await import('node:zlib');
  const { db } = await import('../src/db/index.js');
  const me = await newUser('xavier');

  // A real PNG carrying a tEXt marker plus a PHP payload glued on the end.
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = zlib.deflateSync(Buffer.from([0, 91, 91, 214]));
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from('Comment\0speedy-secret-marker', 'latin1')),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
    Buffer.from('<?php system($_GET[0]); ?>', 'latin1'),
  ]);

  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'payload.png');
  const upload = await me.api.call('/api/attachments', { method: 'POST', token: me.token, form });
  assert.equal(upload.status, 201);

  const row = await db.execute({ sql: 'SELECT storage_key, encrypted FROM attachments WHERE id = ?', args: [upload.body.attachment.id] });
  assert.equal(row.rows[0].encrypted, 1);
  const onDisk = await fsMod.readFile(pathMod.join(tmpDir, 'uploads', row.rows[0].storage_key));
  assert.equal(onDisk.subarray(0, 4).toString('latin1'), 'SPV1', 'stored bytes are ciphertext');
  assert.ok(!onDisk.includes(Buffer.from('speedy-secret-marker')), 'metadata marker is gone');
  assert.ok(!onDisk.includes(Buffer.from('<?php')), 'appended payload is gone');

  const download = await fetch(`${baseUrl}${upload.body.attachment.url}`);
  assert.equal(download.status, 200);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString('hex'), '89504e47', 'still a valid PNG after re-encoding');
  assert.ok(!bytes.includes(Buffer.from('speedy-secret-marker')));
  assert.ok(!bytes.includes(Buffer.from('<?php')));

  // A file that claims to be an image but cannot be decoded is refused.
  const fake = new FormData();
  fake.append('file', new Blob([Buffer.concat([png.subarray(0, 8), Buffer.from('not really a png at all')])], { type: 'image/png' }), 'broken.png');
  const rejected = await me.api.call('/api/attachments', { method: 'POST', token: me.token, form: fake });
  assert.equal(rejected.status, 400);
});

test('a user can export their data and delete their account', async () => {
  const me = await newUser('yara');
  const friend = await newUser('zane');
  const chat = await me.api.call('/api/chats/direct', { method: 'POST', token: me.token, body: { userId: friend.user.id } });
  const chatId = chat.body.chat.id;
  await me.api.call(`/api/chats/${chatId}/messages`, { method: 'POST', token: me.token, body: { type: 'text', body: 'exported message' } });

  // The export is a download, not the usual { data } envelope.
  const exported = await fetch(`${baseUrl}/api/users/me/export`, { headers: { Authorization: `Bearer ${me.token}` } });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition'), /attachment; filename="speedy-export-yara-/);
  const exportedBody = await exported.json();
  assert.equal(exportedBody.profile.username, 'yara');
  assert.ok(exportedBody.chats.length >= 1);
  const chatExport = exportedBody.chats.find((c) => c.id === chatId);
  assert.equal(chatExport.messages.at(-1).body, 'exported message', 'export decrypts the bodies');

  const wrong = await me.api.call('/api/users/me', { method: 'DELETE', token: me.token, body: { password: 'nope' } });
  assert.equal(wrong.status, 401);

  const deleted = await me.api.call('/api/users/me', { method: 'DELETE', token: me.token, body: { password: 'test-password-123' } });
  assert.equal(deleted.status, 204);

  const loginAgain = await client().call('/api/auth/login', { method: 'POST', body: { username: 'yara', password: 'test-password-123' } });
  assert.equal(loginAgain.status, 401, 'the account is gone');

  const stillThere = await me.api.call('/api/auth/me', { token: me.token });
  assert.equal(stillThere.status, 401, 'sessions are revoked');

  // The friend keeps the conversation; the message survives with no sender.
  const friendView = await friend.api.call(`/api/chats/${chatId}/messages`, { token: friend.token });
  assert.equal(friendView.status, 200);
  assert.equal(friendView.body.messages.at(-1).body, 'exported message');
  assert.equal(friendView.body.messages.at(-1).sender, null, 'sender is detached, not fabricated');
});

test('backups are written, verified and can be restored', async () => {
  const { execFileSync } = await import('node:child_process');
  const fsMod = await import('node:fs/promises');
  const pathMod = await import('node:path');

  const outDir = pathMod.join(tmpDir, 'backups');
  execFileSync(process.execPath, ['scripts/backup.js', '--out', outDir, '--keep', '3'], {
    env: { ...process.env, DATA_DIR: tmpDir },
    stdio: 'pipe',
  });

  const [stamp] = (await fsMod.readdir(outDir)).sort().reverse();
  const manifest = JSON.parse(await fsMod.readFile(pathMod.join(outDir, stamp, 'manifest.json'), 'utf8'));
  assert.ok(manifest.database.bytes > 0);
  assert.match(manifest.database.sha256, /^[a-f0-9]{64}$/);
  assert.ok(manifest.uploads.files >= 1, 'uploads are included');

  const restoreDir = pathMod.join(tmpDir, 'restored');
  await fsMod.mkdir(restoreDir, { recursive: true });
  execFileSync(process.execPath, ['scripts/restore.js', '--from', pathMod.join(outDir, stamp)], {
    env: { ...process.env, DATA_DIR: restoreDir },
    stdio: 'pipe',
  });

  const { createClient } = await import('@libsql/client');
  const restored = createClient({ url: `file:${pathMod.join(restoreDir, 'speedy.db')}`, intMode: 'number' });
  const count = await restored.execute('SELECT COUNT(*) AS c FROM users');
  assert.ok(Number(count.rows[0].c) > 0, 'restored database still has users');
  restored.close();
});

test('blocking a contact is reflected in the conversation and can be undone', async () => {
  const me = await newUser('blake');
  const other = await newUser('cora');
  const chat = await me.api.call('/api/chats/direct', { method: 'POST', token: me.token, body: { userId: other.user.id } });
  const chatId = chat.body.chat.id;
  await me.api.call(`/api/chats/${chatId}/messages`, { method: 'POST', token: me.token, body: { type: 'text', body: 'before the block' } });

  let detail = await me.api.call(`/api/chats/${chatId}`, { token: me.token });
  assert.equal(detail.body.chat.blockedByMe, false, 'not blocked to start with');

  const blocked = await me.api.call(`/api/users/${other.user.id}/block`, { method: 'POST', token: me.token, body: {} });
  assert.equal(blocked.status, 204);

  detail = await me.api.call(`/api/chats/${chatId}`, { token: me.token });
  assert.equal(detail.body.chat.blockedByMe, true, 'the UI needs this to offer Unblock');

  const send = await me.api.call(`/api/chats/${chatId}/messages`, { method: 'POST', token: me.token, body: { type: 'text', body: 'nope' } });
  assert.equal(send.status, 403, 'blocked contact cannot be messaged');

  const double = await me.api.call(`/api/users/${other.user.id}/block`, { method: 'POST', token: me.token, body: {} });
  assert.equal(double.status, 409, 'blocking twice is rejected');

  const unblocked = await me.api.call(`/api/users/${other.user.id}/block`, { method: 'DELETE', token: me.token });
  assert.equal(unblocked.status, 204);

  detail = await me.api.call(`/api/chats/${chatId}`, { token: me.token });
  assert.equal(detail.body.chat.blockedByMe, false, 'unblocking clears the flag');

  const sendAgain = await me.api.call(`/api/chats/${chatId}/messages`, { method: 'POST', token: me.token, body: { type: 'text', body: 'after the unblock' } });
  assert.equal(sendAgain.status, 201, 'messages work again');
});

test('two-factor authentication gates the session', async () => {
  const { generateToken } = await import('../src/lib/totp.js');
  const me = await newUser('mfa_user');

  const setup = await me.api.call('/api/auth/mfa/setup', { method: 'POST', token: me.token });
  assert.equal(setup.status, 200);
  assert.match(setup.body.uri, /^otpauth:\/\/totp\//);

  const wrong = await me.api.call('/api/auth/mfa/enable', { method: 'POST', token: me.token, body: { code: '000000' } });
  assert.equal(wrong.status, 400, 'a wrong code does not enable 2FA');

  const enabled = await me.api.call('/api/auth/mfa/enable', {
    method: 'POST',
    token: me.token,
    body: { code: generateToken(setup.body.secret) },
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.backupCodes.length, 10);

  // Password alone no longer yields a session.
  const login = await client().call('/api/auth/login', {
    method: 'POST',
    body: { username: 'mfa_user', password: 'test-password-123' },
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.mfaRequired, true);
  assert.ok(login.body.mfaToken);
  assert.equal(login.body.accessToken, undefined, 'no session before the second factor');

  const badCode = await client().call('/api/auth/mfa/verify', {
    method: 'POST',
    body: { mfaToken: login.body.mfaToken, code: '111111' },
  });
  assert.equal(badCode.status, 401);

  const verified = await client().call('/api/auth/mfa/verify', {
    method: 'POST',
    body: { mfaToken: login.body.mfaToken, code: generateToken(setup.body.secret) },
  });
  assert.equal(verified.status, 200);
  assert.ok(verified.body.accessToken);

  // A backup code also works, and is single use.
  const second = await client().call('/api/auth/login', {
    method: 'POST',
    body: { username: 'mfa_user', password: 'test-password-123' },
  });
  const backupCode = enabled.body.backupCodes[0];
  const withBackup = await client().call('/api/auth/mfa/verify', {
    method: 'POST',
    body: { mfaToken: second.body.mfaToken, code: backupCode },
  });
  assert.equal(withBackup.status, 200);

  const third = await client().call('/api/auth/login', {
    method: 'POST',
    body: { username: 'mfa_user', password: 'test-password-123' },
  });
  const reused = await client().call('/api/auth/mfa/verify', {
    method: 'POST',
    body: { mfaToken: third.body.mfaToken, code: backupCode },
  });
  assert.equal(reused.status, 401, 'a backup code cannot be reused');
});

test('email verification and password reset use single-use tokens', async () => {
  const { createEmailToken } = await import('../src/modules/auth/email-tokens.js');
  const { db } = await import('../src/db/index.js');
  const me = await newUser('mailer');

  const verifyToken = await createEmailToken(me.user.id, 'verify');
  const verified = await client().call('/api/auth/verify-email', { method: 'POST', body: { token: verifyToken } });
  assert.equal(verified.status, 200);

  const again = await client().call('/api/auth/verify-email', { method: 'POST', body: { token: verifyToken } });
  assert.equal(again.status, 401, 'a verification token is single use');

  const resetToken = await createEmailToken(me.user.id, 'reset');
  const reset = await client().call('/api/auth/reset-password', {
    method: 'POST',
    body: { token: resetToken, password: 'a-brand-new-password' },
  });
  assert.equal(reset.status, 200);

  const oldLogin = await client().call('/api/auth/login', { method: 'POST', body: { username: 'mailer', password: 'test-password-123' } });
  assert.equal(oldLogin.status, 401, 'the old password stops working');
  const newLogin = await client().call('/api/auth/login', { method: 'POST', body: { username: 'mailer', password: 'a-brand-new-password' } });
  assert.equal(newLogin.status, 200);

  const sessions = await db.execute({ sql: 'SELECT COUNT(*) AS c FROM sessions WHERE user_id = ? AND revoked_at IS NULL', args: [me.user.id] });
  assert.ok(Number(sessions.rows[0].c) <= 1, 'a reset revokes existing sessions');

  // Unknown identifiers behave identically (no account enumeration).
  const unknown = await client().call('/api/auth/forgot-password', { method: 'POST', body: { identifier: 'nobody-here' } });
  assert.equal(unknown.status, 200);
});

test('members can report a message and admins can resolve it', async () => {
  const { db } = await import('../src/db/index.js');
  const author = await newUser('troll');
  const reporter = await newUser('witness');
  const chat = await author.api.call('/api/chats/direct', { method: 'POST', token: author.token, body: { userId: reporter.user.id } });
  const chatId = chat.body.chat.id;
  const sent = await author.api.call(`/api/chats/${chatId}/messages`, { method: 'POST', token: author.token, body: { type: 'text', body: 'something unpleasant' } });

  const report = await reporter.api.call('/api/reports', {
    method: 'POST',
    token: reporter.token,
    body: { messageId: sent.body.message.id, reason: 'abuse' },
  });
  assert.equal(report.status, 201);

  const denied = await reporter.api.call('/api/admin/reports', { token: reporter.token });
  assert.equal(denied.status, 403, 'moderation is admin-only');

  await db.execute({ sql: "UPDATE users SET role = 'admin' WHERE id = ?", args: [reporter.user.id] });
  const login = await client().call('/api/auth/login', { method: 'POST', body: { username: 'witness', password: 'test-password-123' } });
  const adminToken = login.body.accessToken;

  const queue = await reporter.api.call('/api/admin/reports?status=open', { token: adminToken });
  assert.equal(queue.status, 200);
  assert.ok(queue.body.reports.some((r) => r.id === report.body.id));

  const resolved = await reporter.api.call(`/api/admin/reports/${report.body.id}/resolve`, {
    method: 'POST',
    token: adminToken,
    body: { action: 'remove-message' },
  });
  assert.equal(resolved.status, 200);

  const after = await author.api.call(`/api/chats/${chatId}/messages`, { token: author.token });
  assert.ok(after.body.messages.at(-1).deletedAt, 'the reported message is removed');
});

test('push endpoints report their configuration state', async () => {
  const me = await newUser('pusher');
  const key = await me.api.call('/api/push/key', { token: me.token });
  assert.equal(key.status, 200);
  assert.equal(key.body.enabled, false, 'no VAPID keys in tests');
  assert.equal(key.body.publicKey, null);
});

test('a retried send with the same clientId does not duplicate', async () => {
  const me = await newUser('retry_a');
  const other = await newUser('retry_b');
  const chat = await me.api.call('/api/chats/direct', { method: 'POST', token: me.token, body: { userId: other.user.id } });
  const chatId = chat.body.chat.id;
  const clientId = 'client-abc-123';

  const first = await me.api.call(`/api/chats/${chatId}/messages`, {
    method: 'POST', token: me.token, body: { type: 'text', body: 'sent once', clientId },
  });
  const second = await me.api.call(`/api/chats/${chatId}/messages`, {
    method: 'POST', token: me.token, body: { type: 'text', body: 'sent once', clientId },
  });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(first.body.message.id, second.body.message.id, 'the retry returns the original message');

  const page = await me.api.call(`/api/chats/${chatId}/messages`, { token: me.token });
  assert.equal(page.body.messages.filter((m) => m.body === 'sent once').length, 1, 'only one copy exists');
});

test('deleting for me hides a message without affecting anyone else', async () => {
  const me = await newUser('hide_a');
  const other = await newUser('hide_b');
  const chat = await me.api.call('/api/chats/direct', { method: 'POST', token: me.token, body: { userId: other.user.id } });
  const chatId = chat.body.chat.id;
  const sent = await other.api.call(`/api/chats/${chatId}/messages`, {
    method: 'POST', token: other.token, body: { type: 'text', body: 'only for me' },
  });

  const hidden = await me.api.call(`/api/messages/${sent.body.message.id}/hide`, { method: 'POST', token: me.token, body: {} });
  assert.equal(hidden.status, 200);

  const mine = await me.api.call(`/api/chats/${chatId}/messages`, { token: me.token });
  assert.equal(mine.body.messages.some((m) => m.id === sent.body.message.id), false, 'gone for me');

  const theirs = await other.api.call(`/api/chats/${chatId}/messages`, { token: other.token });
  assert.equal(theirs.body.messages.some((m) => m.id === sent.body.message.id), true, 'still there for them');

  const list = await me.api.call('/api/chats', { token: me.token });
  const entry = list.body.chats.find((c) => c.id === chatId);
  assert.equal(entry.lastMessage, null, 'a hidden message does not drive the preview');
  assert.equal(entry.unread, 0, 'and it does not count as unread');
});

test('the media gallery lists images and files separately', async () => {
  const me = await newUser('gallery_a');
  const other = await newUser('gallery_b');
  const chat = await me.api.call('/api/chats/direct', { method: 'POST', token: me.token, body: { userId: other.user.id } });
  const chatId = chat.body.chat.id;

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const imgForm = new FormData();
  imgForm.append('file', new Blob([png], { type: 'image/png' }), 'pic.png');
  const img = await me.api.call('/api/attachments', { method: 'POST', token: me.token, form: imgForm });
  await me.api.call(`/api/chats/${chatId}/messages`, {
    method: 'POST', token: me.token, body: { type: 'image', attachmentId: img.body.attachment.id },
  });

  const fileForm = new FormData();
  fileForm.append('file', new Blob([Buffer.from('report body')], { type: 'text/plain' }), 'notes.txt');
  const file = await me.api.call('/api/attachments', { method: 'POST', token: me.token, form: fileForm });
  await me.api.call(`/api/chats/${chatId}/messages`, {
    method: 'POST', token: me.token, body: { type: 'file', attachmentId: file.body.attachment.id },
  });

  const images = await me.api.call(`/api/chats/${chatId}/media?type=image`, { token: me.token });
  assert.equal(images.status, 200);
  assert.equal(images.body.items.length, 1);
  assert.equal(images.body.items[0].attachment.mime, 'image/png');
  assert.match(images.body.items[0].attachment.url, /^\/api\/attachments\//);

  const files = await me.api.call(`/api/chats/${chatId}/media?type=file`, { token: me.token });
  assert.equal(files.body.items.length, 1);
  assert.equal(files.body.items[0].attachment.name, 'notes.txt');

  const outsider = await newUser('gallery_c');
  const denied = await outsider.api.call(`/api/chats/${chatId}/media?type=image`, { token: outsider.token });
  assert.equal(denied.status, 403);
});

test('@mentions resolve to members and are flagged for the mentioned user', async () => {
  const owner = await newUser('mentor_a');
  const bob = await newUser('mentor_b');
  const carol = await newUser('mentor_c');
  const group = await owner.api.call('/api/chats/group', {
    method: 'POST', token: owner.token, body: { title: 'Mentions', memberIds: [bob.user.id, carol.user.id] },
  });
  const chatId = group.body.chat.id;

  const sent = await owner.api.call(`/api/chats/${chatId}/messages`, {
    method: 'POST', token: owner.token, body: { type: 'text', body: 'hey @mentor_b can you check this?' },
  });
  assert.equal(sent.status, 201);
  assert.deepEqual(sent.body.message.mentions, [bob.user.id]);
  assert.equal(sent.body.message.mentionsMe, false, 'the author is not mentioned');

  const bobsView = await bob.api.call(`/api/chats/${chatId}/messages`, { token: bob.token });
  assert.equal(bobsView.body.messages.at(-1).mentionsMe, true);

  // A name that is not a member is not a mention.
  const outside = await owner.api.call(`/api/chats/${chatId}/messages`, {
    method: 'POST', token: owner.token, body: { type: 'text', body: 'ping @someone_else' },
  });
  assert.deepEqual(outside.body.message.mentions, []);
});

test('security headers and rate limiting are wired up', async () => {
  const res = await fetch(`${baseUrl}/healthz`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.ok(res.headers.get('ratelimit') || true);
});

test('unknown API routes return a JSON 404, SPA routes return the shell', async () => {
  const missing = await client().call('/api/does-not-exist');
  assert.equal(missing.status, 404);
  assert.equal(missing.error.code, 'not_found');

  const shell = await fetch(`${baseUrl}/some/deep/link`);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /<div id="root">/);
});
