import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const origin = 'https://map-admin.mihirss.com';
// Deliberately fake fixtures: no deployment credentials enter tests.
const bindings = {
  ADMIN_USERNAME: 'fixture-admin', ADMIN_PASSWORD: 'fixture-password-for-tests-only',
  SESSION_SECRET: 'fixture-signing-key-for-tests-only-123456789', GITHUB_TOKEN: 'fixture-token',
  LEDGER_BRANCH: 'map-of-reality',
};
const seed = { version: 1, title: 'Map of Reality', entries: [] };

test('Cloudflare runtime: login, append-only publication, and security boundaries', async t => {
  let ledger = structuredClone(seed), sha = 'initial', calls = [], failStatus = 0;
  let options = {
    modules: true, script: await readFile(new URL('../src/index.js', import.meta.url), 'utf8'),
    compatibilityDate: '2026-10-01', bindings,
    ratelimits: { LOGIN_LIMITER: { namespace_id: '1044266898', simple: { limit: 5, period: 60 } } },
    outboundService: async request => {
      const url = new URL(request.url); calls.push([request.method, url.pathname, url.search]);
      assert.equal(url.hostname, 'api.github.com');
      assert.equal(url.pathname, '/repos/mihirs-0/mihirs-0.github.io/contents/data/map-of-reality.json');
      if (failStatus) return new Response('sensitive-upstream-body', { status: failStatus });
      if (request.method === 'GET') {
        assert.equal(url.searchParams.get('ref'), 'map-of-reality');
        return Response.json({ sha, content: Buffer.from(JSON.stringify(ledger)).toString('base64') });
      }
      assert.equal(request.method, 'PUT');
      const data = await request.json();
      assert.equal(data.branch, 'map-of-reality'); assert.equal(data.sha, sha);
      ledger = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
      sha += '-next'; return Response.json({ commit: { sha } });
    },
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  async function configure(changes) { options = { ...options, ...changes }; await mf.setOptions(convertV4MiniflareOptions(options)); }
  t.after(() => mf.dispose());
  let cookie = '';
  async function call(path, { method = 'POST', data = {}, headers = {}, raw, auth = false } = {}) {
    return mf.dispatchFetch(origin + path, { method,
      headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1', ...(auth ? { cookie } : {}), ...headers },
      ...(method === 'GET' ? {} : { body: raw ?? JSON.stringify(data) }),
    });
  }
  await t.test('invalid credentials rejected without issuing cookie', async () => {
    const r = await call('/api/login', { data: { username: bindings.ADMIN_USERNAME, password: 'wrong' } });
    assert.equal(r.status, 401); assert.equal(r.headers.get('set-cookie'), null);
  });
  await t.test('successful login issues host-only secure HttpOnly session', async () => {
    const r = await call('/api/login', { data: { username: bindings.ADMIN_USERNAME, password: bindings.ADMIN_PASSWORD } });
    assert.equal(r.status, 200); const c = r.headers.get('set-cookie');
    for (const flag of ['__Host-mor_session=', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=28800']) assert.ok(c.includes(flag));
    assert.ok(!c.includes('Domain=')); cookie = c.split(';')[0];
    assert.equal((await (await call('/api/me', { method: 'GET', auth: true })).json()).authenticated, true);
  });
  await t.test('missing, tampered and malformed sessions rejected', async () => {
    assert.equal((await call('/api/entries')).status, 401);
    for (const value of [cookie + 'x', '__Host-mor_session=NaN.sig', '__Host-mor_session=0.sig', cookie + '.extra']) {
      assert.equal((await (await call('/api/me', { method: 'GET', headers: { cookie: value } })).json()).authenticated, false);
    }
  });
  await t.test('origin and JSON guards stop CSRF including sibling subdomains', async () => {
    for (const bad of ['https://evil.example', 'https://evil.mihirss.com', 'null', '']) {
      assert.equal((await call('/api/entries', { auth: true, headers: { origin: bad } })).status, 403);
    }
    assert.equal((await call('/api/login', { headers: { 'content-type': 'text/plain' } })).status, 415);
    const preflight = await call('/api/entries', { method: 'OPTIONS' });
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  });
  await t.test('invalid bodies and confidence cannot mutate ledger', async () => {
    for (const raw of ['null', '[]', '{', '"' + 'x'.repeat(33000) + '"']) {
      const r = await call('/api/entries', { auth: true, raw }); assert.ok([400, 413].includes(r.status));
    }
    for (const confidence of [true, [], {}, ' ', -1, 101, 'no']) {
      assert.equal((await call('/api/entries', { auth: true, data: { kind: 'map', claim: 'Claim', confidence } })).status, 400);
    }
    assert.equal((await call('/api/entries', { auth: true, data: { kind: 'map', claim: 'x'.repeat(801) } })).status, 400);
    assert.equal(calls.length, 0);
  });
  let id;
  await t.test('publish commits only the fixed ledger path on isolated branch', async () => {
    const r = await call('/api/entries', { auth: true, data: { kind: 'forecast', claim: 'Temporary test — 東京 <script>alert(1)</script>', confidence: 65, horizon: '2030', reasoning: 'First line\nSecond line' } });
    assert.equal(r.status, 201); const result = await r.json(); id = result.id;
    assert.equal(result.commit, sha); assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].claim, 'Temporary test — 東京 <script>alert(1)</script>');
    assert.deepEqual(ledger.entries[0].updates, []);
  });
  await t.test('updates preserve original claim and all historical records', async () => {
    const before = structuredClone(ledger.entries[0]);
    for (const note of ['New evidence', 'Second historical update']) {
      const r = await call(`/api/entries/${id}/updates`, { auth: true, data: { note, confidence: 80, claim: 'Attempted rewrite', updates: [] } });
      assert.equal(r.status, 201);
    }
    const { updates, ...rest } = ledger.entries[0]; const { updates: ignored, ...original } = before;
    assert.deepEqual(rest, original); assert.equal(updates.length, 2);
    assert.equal(updates[0].note, 'New evidence'); assert.equal(updates[1].note, 'Second historical update');
  });
  await t.test('delete, overwrite, and arbitrary GitHub proxy routes are unavailable', async () => {
    const count = calls.length;
    for (const method of ['DELETE', 'PUT', 'PATCH']) {
      assert.equal((await call('/api/entries', { method, auth: true })).status, 405);
      assert.equal((await call(`/api/entries/${id}/updates`, { method, auth: true })).status, 405);
      assert.equal((await call(`/api/entries/${id}`, { method, auth: true })).status, 404);
    }
    for (const path of ['/api/delete', '/api/github', '/api/entries/delete']) assert.equal((await call(path, { auth: true })).status, 404);
    assert.equal(calls.length, count);
  });
  await t.test('GitHub failures are sanitized and concurrency conflicts preserved', async () => {
    for (const status of [401, 403, 404, 409, 422, 500]) {
      // Fail only PUT so reads succeed.
      await configure({ outboundService: async request => {
        if (request.method === 'GET') return Response.json({ sha, content: Buffer.from(JSON.stringify(ledger)).toString('base64') });
        return new Response('sensitive-upstream-body', { status });
      }});
      const r = await call(`/api/entries/${id}/updates`, { auth: true, data: { note: 'Failure test' } });
      assert.equal(r.status, [409, 422].includes(status) ? 409 : 502);
      const message = await r.text();
      assert.ok(!message.includes('sensitive-upstream-body'));
      if (status === 403) assert.ok(message.includes('HTTP 403'));
      if (status === 401) assert.ok(message.includes('rejected the token'));
    }
  });
  await t.test('login throttling rejects excessive attempts', async () => {
    let limited = false;
    for (let i = 0; i < 7; i++) {
      const r = await call('/api/login', { data: { username: 'wrong', password: 'wrong' } });
      if (r.status === 429) { limited = true; assert.equal(r.headers.get('retry-after'), '60'); }
    }
    assert.ok(limited);
  });
  await t.test('credential rotation invalidates sessions; missing setup fails closed', async () => {
    await configure({ bindings: { ...bindings, ADMIN_PASSWORD: 'rotated-fixture-password' } });
    assert.equal((await (await call('/api/me', { method: 'GET', auth: true })).json()).authenticated, false);
    for (const changed of [{ ADMIN_USERNAME: '' }, { ADMIN_PASSWORD: '' }, { SESSION_SECRET: 'short' }, { GITHUB_TOKEN: '' }, { LEDGER_BRANCH: 'unexpected' }]) {
      await configure({ bindings: { ...bindings, ...changed } });
      assert.equal((await call('/api/login', { data: {} })).status, 503);
    }
  });
});
