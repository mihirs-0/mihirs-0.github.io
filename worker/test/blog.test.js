import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const origin = 'https://map-admin.mihirss.com';
const bindings = {
  ADMIN_USERNAME: 'fixture-admin', ADMIN_PASSWORD: 'fixture-password-for-tests-only',
  SESSION_SECRET: 'fixture-signing-key-for-tests-only-123456789', GITHUB_TOKEN: 'fixture-token',
  LEDGER_BRANCH: 'map-of-reality',
};
const REPO = '/repos/mihirs-0/mihirs-0.github.io/';

// A small in-memory stand-in for GitHub's contents and Git Data APIs.
function fakeGitHub() {
  const commits = { c0: { files: { 'data/blog.json': JSON.stringify({ version: 1, posts: [] }), 'data/map-of-reality.json': '{}' } } };
  const trees = {}, blobs = {};
  const state = { head: 'c0', n: 0, refUpdates: 0, raceOnce: false, commits };
  state.files = () => commits[state.head].files;
  state.blobs = blobs;
  state.service = async request => {
    const url = new URL(request.url);
    assert.equal(url.hostname, 'api.github.com');
    assert.ok(url.pathname.startsWith(REPO));
    const path = url.pathname.slice(REPO.length);
    const body = ['POST', 'PATCH'].includes(request.method) ? await request.json() : null;
    if (request.method === 'GET' && path === 'git/ref/heads/map-of-reality') return Response.json({ object: { sha: state.head } });
    if (request.method === 'GET' && path.startsWith('contents/')) {
      const files = commits[url.searchParams.get('ref')]?.files;
      const content = files?.[path.slice('contents/'.length)];
      if (content == null) return new Response('missing', { status: 404 });
      return Response.json({ sha: 'blob', content: Buffer.from(content).toString('base64') });
    }
    if (request.method === 'GET' && path.startsWith('git/commits/')) return Response.json({ tree: { sha: 'tree-' + path.slice(12) } });
    if (request.method === 'POST' && path === 'git/blobs') {
      assert.equal(body.encoding, 'base64');
      const id = 'b' + (++state.n); blobs[id] = body.content; return Response.json({ sha: id });
    }
    if (request.method === 'POST' && path === 'git/trees') {
      const files = { ...commits[body.base_tree.slice(5)].files };
      for (const f of body.tree) {
        assert.ok(f.path === 'data/blog.json' || /^data\/blog\/[a-z0-9-]+\.json$/.test(f.path)
          || /^assets\/blog\/[a-z0-9-]+\/[a-f0-9]{16}\.(png|jpg|gif|webp)$/.test(f.path), 'unexpected path ' + f.path);
        if (f.sha === null) delete files[f.path];
        else if (f.sha) { assert.ok(blobs[f.sha]); files[f.path] = 'blob:' + blobs[f.sha]; }
        else files[f.path] = f.content;
      }
      const id = 't' + (++state.n); trees[id] = files; return Response.json({ sha: id });
    }
    if (request.method === 'POST' && path === 'git/commits') {
      const id = 'c' + (++state.n); commits[id] = { files: trees[body.tree], parents: body.parents, message: body.message };
      return Response.json({ sha: id });
    }
    if (request.method === 'PATCH' && path === 'git/refs/heads/map-of-reality') {
      assert.equal(body.force, false);
      if (state.raceOnce) { state.raceOnce = false; return new Response('not a fast forward', { status: 422 }); }
      if (commits[body.sha].parents[0] !== state.head) return new Response('not a fast forward', { status: 422 });
      state.head = body.sha; state.refUpdates++; return Response.json({ object: { sha: body.sha } });
    }
    throw new Error('unexpected GitHub call ' + request.method + ' ' + path);
  };
  return state;
}

test('Cloudflare runtime: blog publishing', async t => {
  const gh = fakeGitHub();
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: ['index.js', 'blog.js'].map(f => ({ type: 'ESModule', path: fileURLToPath(new URL('../src/' + f, import.meta.url)) })),
    modulesRoot: fileURLToPath(new URL('../', import.meta.url)),
    compatibilityDate: '2026-10-01', bindings,
    ratelimits: { LOGIN_LIMITER: { namespace_id: '1044266898', simple: { limit: 5, period: 60 } } },
    outboundService: gh.service,
  }));
  t.after(() => mf.dispose());
  let cookie = '';
  async function call(path, { method = 'POST', data = {}, raw, headers = {}, auth = true } = {}) {
    return mf.dispatchFetch(origin + path, { method,
      headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.9', ...(auth ? { cookie } : {}), ...headers },
      ...(['GET', 'HEAD'].includes(method) ? {} : { body: raw ?? JSON.stringify(data) }),
    });
  }
  const index = () => JSON.parse(gh.files()['data/blog.json']);
  const post = slug => JSON.parse(gh.files()[`data/blog/${slug}.json`]);

  await t.test('blog routes need the same admin session', async () => {
    assert.equal((await call('/api/blog/posts', { method: 'GET', auth: false })).status, 401);
    assert.equal((await call('/api/blog/posts', { auth: false, data: { title: 'x', html: '<p>x</p>' } })).status, 401);
    const r = await call('/api/login', { auth: false, data: { username: bindings.ADMIN_USERNAME, password: bindings.ADMIN_PASSWORD } });
    cookie = r.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('/api/blog/posts', { headers: { origin: 'https://evil.mihirss.com' }, data: { title: 'x', html: '<p>x</p>' } })).status, 403);
  });

  await t.test('publishing sanitizes HTML and writes post and index in one commit', async () => {
    const html = '<h1>Big</h1><p onclick="x()">Hello <strong>world</strong> <a href="javascript:alert(1)">bad</a> <a href="https://example.com" target="_top">good</a></p>'
      + '<script>alert(1)</script><style>p{}</style><!-- note --><img src="x" onerror="alert(1)"><img src="https://example.com/a.png" alt="A">'
      + '<div><span style="color:red">kept text</span></div><iframe src="https://evil.example"></iframe><blockquote><p>q</p></blockquote>';
    const r = await call('/api/blog/posts', { data: { title: '  Hello, Wörld!  ', html } });
    assert.equal(r.status, 201);
    const result = await r.json();
    assert.equal(result.slug, 'hello-world');
    assert.equal(gh.refUpdates, 1);
    assert.equal(gh.commits[gh.head].message, 'Blog: publish hello-world');
    const p = post('hello-world');
    assert.equal(p.title, 'Hello, Wörld!');
    assert.equal(p.date, new Date().toISOString().slice(0, 10));
    for (const bad of ['<script', '<style', 'onclick', 'onerror', 'javascript:', '<iframe', '<!--', 'target=', 'style=', '<h1', '<div', '<span', 'src="x"']) {
      assert.ok(!p.html.includes(bad), bad + ' survived: ' + p.html);
    }
    for (const good of ['<strong>world</strong>', 'href="https://example.com"', '<img src="https://example.com/a.png" alt="A">', 'kept text', '<blockquote><p>q</p></blockquote>', 'Big']) {
      assert.ok(p.html.includes(good), good + ' missing: ' + p.html);
    }
    assert.deepEqual(index().posts, [{ slug: 'hello-world', title: 'Hello, Wörld!', date: p.date }]);
  });

  await t.test('same title gets a distinct slug; newest first', async () => {
    const r = await call('/api/blog/posts', { data: { title: 'Hello world', html: '<p>Second</p>' } });
    assert.equal((await r.json()).slug, 'hello-world-2');
    assert.deepEqual(index().posts.map(p => p.slug), ['hello-world-2', 'hello-world']);
    const r3 = await call('/api/blog/posts', { data: { title: '東京', html: '<p>Unicode</p>' } });
    assert.equal((await r3.json()).slug, 'post');
  });

  await t.test('list and read return what was published', async () => {
    const list = await (await call('/api/blog/posts', { method: 'GET' })).json();
    assert.equal(list.posts.length, 3);
    const one = await (await call('/api/blog/posts/hello-world', { method: 'GET' })).json();
    assert.equal(one.post.title, 'Hello, Wörld!');
    assert.equal((await call('/api/blog/posts/nope', { method: 'GET' })).status, 404);
  });

  await t.test('editing keeps slug and date, records the update', async () => {
    const before = post('hello-world');
    const r = await call('/api/blog/posts/hello-world', { data: { title: 'Hello again', html: '<p>Edited <em>text</em></p>', slug: 'hijack', date: '1999-01-01' } });
    assert.equal(r.status, 200);
    const p = post('hello-world');
    assert.equal(p.title, 'Hello again'); assert.equal(p.html, '<p>Edited <em>text</em></p>');
    assert.equal(p.date, before.date); assert.equal(p.slug, 'hello-world'); assert.ok(p.updated_timestamp);
    assert.equal(index().posts.find(x => x.slug === 'hello-world').title, 'Hello again');
    assert.equal(gh.files()['data/blog/hijack.json'], undefined);
  });

  await t.test('deleting removes the post file and index entry together', async () => {
    const commitsBefore = gh.refUpdates;
    assert.equal((await call('/api/blog/posts/post/delete', { data: {} })).status, 200);
    assert.equal(gh.refUpdates, commitsBefore + 1);
    assert.equal(gh.files()['data/blog/post.json'], undefined);
    assert.ok(!index().posts.some(p => p.slug === 'post'));
    assert.equal((await call('/api/blog/posts/post/delete', { data: {} })).status, 404);
  });

  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await t.test('uploaded images are committed with the post and linked from it', async () => {
    const before = gh.refUpdates;
    const r = await call('/api/blog/posts', { data: { title: 'With pictures',
      html: '<p>Look:</p><img src="upload:a1" alt="dot"><img src="upload:zz9"><img src="upload:a1">',
      images: { a1: png } } });
    assert.equal(r.status, 201);
    assert.equal(gh.refUpdates, before + 1);
    const files = Object.keys(gh.files()).filter(f => f.startsWith('assets/blog/with-pictures/'));
    assert.equal(files.length, 1);
    assert.ok(/\.png$/.test(files[0]));
    assert.equal(gh.files()[files[0]], 'blob:' + png.split(',')[1]);
    const html = post('with-pictures').html;
    assert.equal(html.split('https://mihirss.com/' + files[0]).length - 1, 2, html);
    assert.ok(!html.includes('upload:'), 'unresolved placeholder kept: ' + html);
  });

  await t.test('images that are not really images are refused', async () => {
    const head = gh.head;
    const fake = 'data:image/png;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64');
    assert.equal((await call('/api/blog/posts', { data: { title: 'Fake', html: '<img src="upload:x">', images: { x: fake } } })).status, 400);
    assert.equal((await call('/api/blog/posts', { data: { title: 'Bad id', html: '<p>x</p>', images: { '../x': png } } })).status, 400);
    assert.equal((await call('/api/blog/posts', { data: { title: 'Not data', html: '<p>x</p>', images: { x: 'https://example.com/a.png' } } })).status, 400);
    const big = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(6 * 1024 * 1024)]).toString('base64');
    assert.equal((await call('/api/blog/posts', { data: { title: 'Big', html: '<p>x</p>', images: { x: big } } })).status, 413);
    assert.equal(gh.head, head);
  });

  await t.test('deleting a post removes its uploaded images', async () => {
    assert.equal((await call('/api/blog/posts/with-pictures/delete', { data: {} })).status, 200);
    assert.equal(Object.keys(gh.files()).filter(f => f.startsWith('assets/blog/with-pictures/')).length, 0);
  });

  await t.test('a concurrent change is a conflict, not an overwrite', async () => {
    const head = gh.head; gh.raceOnce = true;
    const r = await call('/api/blog/posts', { data: { title: 'Racing', html: '<p>x</p>' } });
    assert.equal(r.status, 409);
    assert.equal(gh.head, head);
  });

  await t.test('invalid input and methods are rejected without writing', async () => {
    const head = gh.head;
    assert.equal((await call('/api/blog/posts', { data: { title: '', html: '<p>x</p>' } })).status, 400);
    assert.equal((await call('/api/blog/posts', { data: { title: 'x'.repeat(201), html: '<p>x</p>' } })).status, 400);
    assert.equal((await call('/api/blog/posts', { data: { title: 'Empty', html: '<p> </p><script>x</script>' } })).status, 400);
    assert.equal((await call('/api/blog/posts', { data: { title: 'Huge', html: 'x'.repeat(600000) } })).status, 400);
    assert.equal((await call('/api/blog/posts', { headers: { 'content-type': 'text/plain' }, data: { title: 'x', html: 'x' } })).status, 415);
    for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal((await call('/api/blog/posts/hello-world', { method })).status, 405);
    for (const path of ['/api/blog/posts/..%2Fmap-of-reality', '/api/blog/posts/Hello', '/api/blog/other', '/api/blog/posts/a/b']) {
      assert.equal((await call(path, { method: 'GET' })).status, 404, path);
    }
    assert.equal(gh.head, head);
  });
});
