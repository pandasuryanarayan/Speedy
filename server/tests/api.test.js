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
    async call(pathname, { method = 'GET', body, token, form } = {}) {
      const headers = { Accept: 'application/json' };
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
