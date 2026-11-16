// Blog routes. Same session, origin checks and GitHub token as the ledger;
// every publish is one commit made through the Git Data API.
const INDEX_PATH = "data/blog.json";
const POST_DIR = "data/blog";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_HTML = 400000;

// Elements whose contents are dropped with them.
const DROP = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math",
  "form", "input", "button", "textarea", "select", "option", "title", "head", "meta", "link", "base",
  "frame", "frameset", "applet", "audio", "video", "source", "track", "canvas", "dialog", "portal"]);
// Elements kept, with the attributes each may carry.
const ALLOWED = {
  p: [], br: [], h2: [], h3: [], h4: [], strong: [], em: [], u: [], s: [], sup: [], sub: [],
  a: ["href", "title"], blockquote: [], ul: [], ol: ["start"], li: [], pre: [], code: [], hr: [],
  img: ["src", "alt", "title"], figure: [], figcaption: [],
};

export function safeUrl(value, image = false) {
  const v = String(value || "").trim();
  if (/^https:\/\/[^\s"'<>]+$/i.test(v)) return true;
  if (image) return /^\/(?!\/)[^\s"'<>]*$/.test(v);
  return /^http:\/\/[^\s"'<>]+$/i.test(v) || /^mailto:[^\s"'<>]+$/i.test(v)
    || /^#[\w-]*$/.test(v) || /^\/(?!\/)[^\s"'<>]*$/.test(v);
}

export async function sanitize(html) {
  const out = new HTMLRewriter()
    .onDocument({ comments(c) { c.remove(); }, doctype() {} })
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (DROP.has(tag)) { el.remove(); return; }
        const keep = ALLOWED[tag];
        if (!keep) { el.removeAndKeepContent(); return; }
        for (const [name, value] of [...el.attributes]) {
          const ok = keep.includes(name)
            && (name !== "href" || safeUrl(value))
            && (name !== "src" || safeUrl(value, true))
            && (name !== "start" || /^\d{1,6}$/.test(value));
          if (!ok) el.removeAttribute(name);
        }
        if (tag === "img" && !el.getAttribute("src")) el.remove();
      },
    })
    .transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
  return (await out.text()).trim();
}

export function slugify(title) {
  const s = title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70).replace(/-+$/, "");
  return s || "post";
}

function decode(file) {
  return new TextDecoder("utf-8", { fatal: true })
    .decode(Uint8Array.from(atob(file.content.replace(/\n/g, "")), c => c.charCodeAt(0)));
}

export function blogRoutes({ json, readBody, github, ApiError, cleanText }) {
  async function call(env, path, options) {
    const r = await github(env, path, options);
    if (r.ok) return r.json();
    if (r.status === 401) throw new ApiError(502, "GitHub rejected the token. Check its expiry and replace the Cloudflare GITHUB_TOKEN secret if needed.");
    if (r.status === 403) throw new ApiError(502, "GitHub denied publication (HTTP 403). Check the token has Contents read and write for mihirs-0.github.io.");
    if (r.status === 409 || r.status === 422) throw new ApiError(409, "The blog changed while publishing. Reload and try again.");
    throw new ApiError(502, "GitHub could not complete the request. Check the blog before retrying.");
  }

  async function head(env) {
    const ref = await call(env, `git/ref/heads/${encodeURIComponent(env.LEDGER_BRANCH)}`);
    return ref.object.sha;
  }

  async function readFile(env, path, ref) {
    const r = await github(env, `contents/${path}?ref=${encodeURIComponent(ref)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new ApiError(502, "The blog could not be read from GitHub.");
    return JSON.parse(decode(await r.json()));
  }

  async function readIndex(env, ref) {
    const data = (await readFile(env, INDEX_PATH, ref)) || { version: 1, posts: [] };
    if (data.version !== 1 || !Array.isArray(data.posts)
        || data.posts.some(p => !p || typeof p.slug !== "string" || !SLUG.test(p.slug))) {
      throw new ApiError(502, "The blog index needs repair through GitHub.");
    }
    return data;
  }

  // One commit for the whole change; the ref update refuses anything but a fast-forward.
  async function commit(env, parent, files, message) {
    const base = await call(env, `git/commits/${parent}`);
    const tree = await call(env, "git/trees", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_tree: base.tree.sha, tree: files.map(f => ({ path: f.path, mode: "100644", type: "blob",
        ...(f.content == null ? { sha: null } : { content: f.content }) })) }) });
    const made = await call(env, "git/commits", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, tree: tree.sha, parents: [parent] }) });
    await call(env, `git/refs/heads/${encodeURIComponent(env.LEDGER_BRANCH)}`, { method: "PATCH",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ sha: made.sha, force: false }) });
    return made.sha;
  }

  const text = data => JSON.stringify(data, null, 2) + "\n";

  async function readPost(body) {
    const title = cleanText(body.title, 200);
    if (!title) throw new ApiError(400, "Title is required.");
    if (typeof body.html !== "string" || body.html.length > MAX_HTML) throw new ApiError(400, "The post body is missing or too long.");
    const html = await sanitize(body.html);
    if (!html.replace(/<[^>]*>/g, "").trim() && !/<img\s/i.test(html)) throw new ApiError(400, "The post is empty.");
    return { title, html };
  }

  return async function blog(request, env, url, headers) {
    const path = url.pathname.slice("/api/blog".length);
    const one = path.match(/^\/posts\/([a-z0-9-]{1,80})$/);
    const del = path.match(/^\/posts\/([a-z0-9-]{1,80})\/delete$/);
    const allowed = path === "/posts" ? ["GET", "POST"] : one ? ["GET", "POST"] : del ? ["POST"] : null;
    if (!allowed) return json({ ok: false, error: "Not found." }, 404, headers);
    if (!allowed.includes(request.method)) return json({ ok: false, error: "Method not allowed." }, 405, { ...headers, allow: allowed.join(", ") });
    const slug = (one || del)?.[1];
    if (slug && !SLUG.test(slug)) return json({ ok: false, error: "Not found." }, 404, headers);

    if (request.method === "GET") {
      const ref = await head(env);
      if (!slug) return json({ ok: true, posts: (await readIndex(env, ref)).posts }, 200, headers);
      const post = await readFile(env, `${POST_DIR}/${slug}.json`, ref);
      if (!post) return json({ ok: false, error: "Post not found." }, 404, headers);
      return json({ ok: true, post }, 200, headers);
    }

    const body = del ? {} : await readBody(request, 512 * 1024);
    const parent = await head(env);
    const index = await readIndex(env, parent);
    const now = new Date().toISOString();

    if (path === "/posts") {
      const { title, html } = await readPost(body);
      const taken = new Set(index.posts.map(p => p.slug));
      const root = slugify(title);
      let next = root;
      for (let n = 2; taken.has(next); n++) next = `${root}-${n}`;
      const post = { slug: next, title, date: now.slice(0, 10), created_timestamp: now, updated_timestamp: null, html };
      index.posts.unshift({ slug: next, title, date: post.date });
      const sha = await commit(env, parent, [
        { path: `${POST_DIR}/${next}.json`, content: text(post) },
        { path: INDEX_PATH, content: text(index) },
      ], `Blog: publish ${next}`);
      return json({ ok: true, slug: next, commit: sha }, 201, headers);
    }

    const at = index.posts.findIndex(p => p.slug === slug);
    if (at < 0) return json({ ok: false, error: "Post not found." }, 404, headers);

    if (del) {
      index.posts.splice(at, 1);
      const sha = await commit(env, parent, [
        { path: `${POST_DIR}/${slug}.json`, content: null },
        { path: INDEX_PATH, content: text(index) },
      ], `Blog: delete ${slug}`);
      return json({ ok: true, commit: sha }, 200, headers);
    }

    const existing = await readFile(env, `${POST_DIR}/${slug}.json`, parent);
    if (!existing) throw new ApiError(502, "The post file is missing; repair it through GitHub.");
    const { title, html } = await readPost(body);
    const post = { ...existing, title, html, updated_timestamp: now };
    index.posts[at] = { ...index.posts[at], title, updated: now.slice(0, 10) };
    const sha = await commit(env, parent, [
      { path: `${POST_DIR}/${slug}.json`, content: text(post) },
      { path: INDEX_PATH, content: text(index) },
    ], `Blog: update ${slug}`);
    return json({ ok: true, slug, commit: sha }, 200, headers);
  };
}
