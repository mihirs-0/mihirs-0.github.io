import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const origin = 'https://map-admin.mihirss.com';
const bindings = {
  ADMIN_USERNAME: 'fixture-admin', ADMIN_PASSWORD: 'fixture-password-for-tests-only',
  SESSION_SECRET: 'fixture-signing-key-for-tests-only-123456789', GITHUB_TOKEN: 'site-token',
  NOTEBOOK_GITHUB_TOKEN: 'notebook-token', LEDGER_BRANCH: 'map-of-reality',
};
const REPO = '/repos/mihirs-0/research-notebook/';

// In-memory stand-in for the private repository.
function fakeGitHub() {
  const commits = { c0: { files: { 'README.md': '# notebook' } } };
  const trees = {};
  const state = { head: 'c0', n: 0, raceOnce: false, commits, calls: [] };
  state.files = () => commits[state.head].files;
  state.service = async request => {
    const url = new URL(request.url);
    assert.ok(url.pathname.startsWith(REPO), 'only the notebook repo: ' + url.pathname);
    assert.equal(request.headers.get('authorization'), 'Bearer notebook-token');
    const path = url.pathname.slice(REPO.length);
    state.calls.push(request.method + ' ' + path);
    const body = ['POST', 'PATCH'].includes(request.method) ? await request.json() : null;
    if (request.method === 'GET' && path === 'git/ref/heads/main') return Response.json({ object: { sha: state.head } });
    if (request.method === 'GET' && path.startsWith('contents/')) {
      const content = commits[url.searchParams.get('ref')]?.files[path.slice(9)];
      return content == null ? new Response('missing', { status: 404 }) : new Response(content);
    }
    if (request.method === 'GET' && path.startsWith('git/commits/')) return Response.json({ tree: { sha: 'tree-' + path.slice(12) } });
    if (request.method === 'POST' && path === 'git/trees') {
      const files = { ...commits[body.base_tree.slice(5)].files };
      for (const f of body.tree) {
        assert.ok(f.path === 'index.json' || /^projects\/[a-z0-9-]+\.json$/.test(f.path), 'unexpected path ' + f.path);
        if (f.sha === null) delete files[f.path]; else files[f.path] = f.content;
      }
      const id = 't' + (++state.n); trees[id] = files; return Response.json({ sha: id });
    }
    if (request.method === 'POST' && path === 'git/commits') {
      const id = 'c' + (++state.n); commits[id] = { files: trees[body.tree], parents: body.parents, message: body.message };
      return Response.json({ sha: id });
    }
    if (request.method === 'PATCH' && path === 'git/refs/heads/main') {
      assert.equal(body.force, false);
      if (state.raceOnce) { state.raceOnce = false; return new Response('not a fast forward', { status: 422 }); }
      if (commits[body.sha].parents[0] !== state.head) return new Response('not a fast forward', { status: 422 });
      state.head = body.sha; return Response.json({ object: { sha: body.sha } });
    }
    throw new Error('unexpected GitHub call ' + request.method + ' ' + path);
  };
  return state;
}

test('Cloudflare runtime: private notebook', async t => {
  const gh = fakeGitHub();
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: ['index.js', 'blog.js', 'notebook.js'].map(f => ({ type: 'ESModule', path: fileURLToPath(new URL('../src/' + f, import.meta.url)) })),
    modulesRoot: fileURLToPath(new URL('../', import.meta.url)),
    compatibilityDate: '2026-10-01', bindings,
    ratelimits: { LOGIN_LIMITER: { namespace_id: '1044266898', simple: { limit: 5, period: 60 } } },
    outboundService: gh.service,
  }));
  t.after(() => mf.dispose());
  let cookie = '';
  async function call(path, { method = 'POST', data = {}, headers = {}, auth = true } = {}) {
    return mf.dispatchFetch(origin + path, { method,
      headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.7', ...(auth ? { cookie } : {}), ...headers },
      ...(method === 'GET' ? {} : { body: JSON.stringify(data) }),
    });
  }
  const file = p => JSON.parse(gh.files()[p]);
  async function save(project) {
    const r = await call('/api/notebook/projects/' + project.slug, { data: { project } });
    return { status: r.status, body: await r.json() };
  }

  await t.test('needs a session and the admin page origin', async () => {
    assert.equal((await call('/api/notebook/projects', { method: 'GET', auth: false })).status, 401);
    const r = await call('/api/login', { auth: false, data: { username: bindings.ADMIN_USERNAME, password: bindings.ADMIN_PASSWORD } });
    cookie = r.headers.get('set-cookie').split(';')[0];
    // The public site is allowed for other admin routes, but not for the notebook.
    assert.equal((await call('/api/notebook/projects', { method: 'GET', headers: { origin: 'https://mihirss.com' } })).status, 403);
    assert.equal(gh.calls.length, 0);
  });

  let p;
  await t.test('create, list and read a project', async () => {
    const r = await call('/api/notebook/projects', { data: { title: 'Subliminal learning', question: 'Does it transfer?' } });
    assert.equal(r.status, 201);
    p = (await r.json()).project;
    assert.equal(p.slug, 'subliminal-learning');
    assert.equal(p.rev, 1);
    assert.equal(file('index.json').projects[0].title, 'Subliminal learning');
    const again = await (await call('/api/notebook/projects', { data: { title: 'Subliminal Learning!' } })).json();
    assert.equal(again.project.slug, 'subliminal-learning-2');
    const list = await (await call('/api/notebook/projects', { method: 'GET', headers: { origin: '' } })).json();
    assert.deepEqual(list.projects.map(x => x.slug), ['subliminal-learning-2', 'subliminal-learning']);
    const read = await (await call('/api/notebook/projects/subliminal-learning', { method: 'GET' })).json();
    assert.equal(read.project.question, 'Does it transfer?');
  });

  await t.test('board, pins and focus save; stale revisions are refused', async () => {
    const at = new Date().toISOString();
    p.focus = { text: 'Replicating the owl result', at };
    p.board.cards = [
      { id: 'belief0001', kind: 'belief', x: 0, y: 0, w: 240, text: 'Traits ride on number sequences', conf: 60, pinned_at: at, superseded_at: at, superseded_by: 'belief0002' },
      { id: 'belief0002', kind: 'belief', x: 300, y: 0, w: 240, text: 'Only with a shared base model', conf: 75, pinned_at: at },
      { id: 'note000001', kind: 'note', x: 0, y: 200, text: '<script>x</script> stays text', evil: 1 },
    ];
    p.board.links = [{ id: 'link000001', from: 'belief0001', to: 'belief0002', kind: 'replaces' }, { id: 'link000002', from: 'belief0001', to: 'gone000000' }];
    p.board.strokes = [{ id: 'ink0000001', color: '#8C3B2E', w: 3, pts: [0, 0, 10.26, 20] }];
    let r = await save(p);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const saved = r.body.project;
    assert.equal(saved.rev, 2);
    assert.equal(saved.board.links.length, 1, 'dangling link dropped');
    assert.equal(saved.board.cards[2].evil, undefined);
    assert.equal(saved.board.strokes[0].pts[2], 10.3);
    assert.equal(file('index.json').projects[0].slug, 'subliminal-learning');
    assert.deepEqual(file('index.json').projects[0].beliefs, [{ text: 'Only with a shared base model', conf: 75 }]);
    assert.equal(file('index.json').projects[0].focus, 'Replicating the owl result');
    r = await save(p); // still rev 1
    assert.equal(r.status, 409);
    assert.equal(r.body.stale, true);
    p = saved;
    p.board.strokes[0].color = 'red';
    assert.equal((await save(p)).status, 400);
    p.board.strokes[0].color = '#8C3B2E';
  });

  await t.test('preregistration locks the plan, hashes it, and only moves forward', async () => {
    const exp = { id: 'exp0000001', title: 'Owl transfer across bases', status: 'draft',
      plan: { hypothesis: 'Needs a shared base', prediction: 'No transfer from Qwen to Llama', design: '', falsify: '' }, results: '', deviations: '', outcome: 'survived' };
    p.experiments = [exp];
    let r = await save(p);
    assert.equal(r.status, 200);
    assert.equal(r.body.project.experiments[0].outcome, '', 'no outcome before concluding');
    p = r.body.project;
    p.experiments[0].status = 'preregistered';
    r = await save(p);
    assert.equal(r.status, 400, 'falsify target is required');
    assert.match(r.body.error, /falsify/);
    p.experiments[0].plan.falsify = 'A student on a different base picks up the owl preference';
    r = await save(p);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    p = r.body.project;
    const e = p.experiments[0];
    assert.match(e.registered_at, /^\d{4}-/);
    assert.match(e.registered_hash, /^[a-f0-9]{64}$/);
    assert.match(gh.commits[gh.head].message, /^Preregister: Owl transfer/);

    const edited = structuredClone(p);
    edited.experiments[0].plan.prediction = 'Some transfer';
    r = await save(edited);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /locked/);
    const removed = structuredClone(p); removed.experiments = [];
    assert.equal((await save(removed)).status, 409);
    const forged = structuredClone(p); forged.experiments[0].registered_at = '2020-01-01T00:00:00Z';
    r = await save(forged);
    assert.equal(r.status, 200);
    assert.equal(r.body.project.experiments[0].registered_at, e.registered_at, 'server keeps the original lock time');
    p = r.body.project;

    p.experiments[0].status = 'concluded'; p.experiments[0].outcome = 'falsified';
    p.experiments[0].results = 'Transfer happened.'; p.experiments[0].deviations = 'Used 3 seeds, not 5.';
    r = await save(p);
    assert.equal(r.status, 200);
    p = r.body.project;
    assert.equal(p.experiments[0].outcome, 'falsified');
    p.experiments[0].status = 'running';
    assert.equal((await save(p)).status, 400);
    p.experiments[0].status = 'concluded';

    const del = await call('/api/notebook/projects/subliminal-learning/delete');
    assert.equal(del.status, 409, 'projects with preregistrations cannot be deleted');
  });

  await t.test('a draft-only project can be deleted; branch races are retried', async () => {
    gh.raceOnce = true;
    const r = await call('/api/notebook/projects/subliminal-learning-2/delete');
    assert.equal(r.status, 200);
    assert.equal(gh.files()['projects/subliminal-learning-2.json'], undefined);
    assert.deepEqual(file('index.json').projects.map(x => x.slug), ['subliminal-learning']);
  });

  await t.test('bad input is refused without writing', async () => {
    const before = gh.head;
    assert.equal((await call('/api/notebook/projects', { data: { title: '' } })).status, 400);
    assert.equal((await call('/api/notebook/projects/../index', { method: 'GET' })).status, 404);
    assert.equal((await call('/api/notebook/projects/nope', { method: 'GET' })).status, 404);
    const x = structuredClone(p); x.board.cards.push({ id: 'BAD', kind: 'note', x: 0, y: 0, text: '' });
    assert.equal((await save(x)).status, 400);
    assert.equal(gh.head, before);
  });
});

test('notebook reports a missing token instead of touching GitHub', async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: ['index.js', 'blog.js', 'notebook.js'].map(f => ({ type: 'ESModule', path: fileURLToPath(new URL('../src/' + f, import.meta.url)) })),
    modulesRoot: fileURLToPath(new URL('../', import.meta.url)),
    compatibilityDate: '2026-10-01', bindings: { ...bindings, NOTEBOOK_GITHUB_TOKEN: '' },
    ratelimits: { LOGIN_LIMITER: { namespace_id: '1044266898', simple: { limit: 5, period: 60 } } },
    outboundService: () => { throw new Error('no network expected'); },
  }));
  t.after(() => mf.dispose());
  const login = await mf.dispatchFetch(origin + '/api/login', { method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.8' },
    body: JSON.stringify({ username: bindings.ADMIN_USERNAME, password: bindings.ADMIN_PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const r = await mf.dispatchFetch(origin + '/api/notebook/projects', { headers: { cookie } });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /NOTEBOOK_GITHUB_TOKEN/);
});
