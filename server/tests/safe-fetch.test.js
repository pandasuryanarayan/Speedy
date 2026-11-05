import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, assertPublicUrl } from '../src/lib/safe-fetch.js';

test('private, loopback and metadata addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.3.4', '192.168.1.1', '169.254.169.254', '100.64.1.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be blocked`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be allowed`);
  }
  assert.equal(isPrivateAddress('not-an-ip'), true, 'garbage is treated as unsafe');
});

test('dangerous URLs are refused before any connection is made', async () => {
  const blocked = [
    'file:///etc/passwd',
    'ftp://example.com/x',
    'gopher://example.com/',
    'http://localhost:3000/',
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://[::1]/',
    'http://user:password@example.com/',
    'http://10.0.0.1/admin',
  ];
  for (const url of blocked) {
    await assert.rejects(() => assertPublicUrl(url), `should block ${url}`);
  }
});

// DNS is not always available (CI sandboxes), so the resolver is injected.
const lookupReturning = (addresses) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

test('a public URL passes the guard', async () => {
  const url = await assertPublicUrl('https://example.com/article', { lookup: lookupReturning(['93.184.216.34']) });
  assert.equal(url.hostname, 'example.com');
});

test('a hostname that resolves to a private address is refused (DNS rebinding)', async () => {
  await assert.rejects(
    () => assertPublicUrl('https://evil.example.com/', { lookup: lookupReturning(['10.0.0.7']) }),
    'a name pointing at 10.0.0.7 must be blocked',
  );
  await assert.rejects(
    () => assertPublicUrl('https://mixed.example.com/', { lookup: lookupReturning(['93.184.216.34', '127.0.0.1']) }),
    'one private record among many is enough to refuse',
  );
});
