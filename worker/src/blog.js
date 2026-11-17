// Blog routes. Same session, origin checks and GitHub token as the ledger;
// every publish is one commit made through the Git Data API.
const INDEX_PATH = "data/blog.json";
const POST_DIR = "data/blog";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_HTML = 400000;
const SITE = "https://mihirss.com";
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_IMAGES_TOTAL = 15 * 1024 * 1024;
// Uploaded images are recognised by their leading bytes, not by what the browser claims.
const IMAGE_TYPES = [
  ["png", b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ["jpg", b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["gif", b => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38],
  ["webp", b => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50],
];

// Elements whose contents are dropped with them.
const DROP = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math",
  "form", "input", "button", "textarea", "select", "option", "title", "head", "meta", "link", "base",
  "frame", "frameset", "applet", "audio", "video", "source", "track", "canvas", "dialog", "portal"]);
// Elements kept, with the attributes each may carry.
const ALLOWED = {
  p: ["class"], br: [], h2: ["class"], h3: ["class"], h4: ["class"], strong: [], em: [], u: [], s: [], sup: [], sub: [],
  a: ["href", "title"], blockquote: [], ul: [], ol: ["start"], li: ["class"], pre: [], code: [], hr: [],
  img: ["src", "alt", "title", "class"], figure: [], figcaption: [],
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
            && (name !== "start" || /^\d{1,6}$/.test(value))
            && (name !== "class" || /^align-(center|right|justify)$/.test(value));
          if (!ok) el.removeAttribute(name);
        }
        if (tag === "img" && !el.getAttribute("src")) el.remove();
      },
    })
    .transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
  return (await out.text()).trim();
}

// Point upload:<id> placeholders at the files committed alongside the post.
async function linkUploads(html, urls) {
  const out = new HTMLRewriter().on("img[src]", {
    element(el) {
      const m = el.getAttribute("src").match(/^upload:([a-z0-9]{1,32})$/);
      if (m && urls[m[1]]) el.setAttribute("src", urls[m[1]]);
    },
  }).transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
  return out.text();
}

// Fetch a picture for the editor from a link: either the image itself, or the
// preview image a page names in its og:image / twitter:image metadata.
const PUBLIC_HOST = /^(?!localhost$)(?!.*\.(local|internal|localhost)$)(?![\d.]+$)(?!\[)[a-z0-9.-]+\.[a-z]{2,}$/i;
async function fetchLimited(url, accept) {
  const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10000),
    headers: { "user-agent": "Mozilla/5.0 (compatible; mihirss-blog/1.0; +https://mihirss.com)", accept } });
  if (!r.ok || !r.body) throw new Error("status");
  const reader = r.body.getReader(), chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > MAX_IMAGE) { await reader.cancel(); throw new Error("big"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0; for (const c of chunks) { bytes.set(c, at); at += c.length; }
  return { bytes, type: (r.headers.get("content-type") || "").toLowerCase() };
}
function checkLink(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  return /^https?:$/.test(url.protocol) && PUBLIC_HOST.test(url.hostname) && !url.username && !url.password ? url : null;
}
export async function imageFromLink(raw) {
  let url = checkLink(raw);
  if (!url) return { error: "That doesn't look like a web link." };
  for (let hop = 0; hop < 2; hop++) {
    let got;
    try { got = await fetchLimited(url.href, "image/*,text/html;q=0.8"); } catch (e) {
      return { error: e.message === "big" ? "That image is over 5 MB." : "That site didn't hand over the image." };
    }
    const kind = IMAGE_TYPES.find(([, test]) => test(got.bytes))?.[0];
    if (kind) {
      let binary = "";
      for (let i = 0; i < got.bytes.length; i += 32768) binary += String.fromCharCode(...got.bytes.subarray(i, i + 32768));
      const mime = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[kind];
      return { data: `data:${mime};base64,${btoa(binary)}` };
    }
    if (hop || !got.type.includes("html")) break;
    let found = "";
    await new HTMLRewriter().on("meta", { element(el) {
      const key = (el.getAttribute("property") || el.getAttribute("name") || "").toLowerCase();
      if (!found && ["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"].includes(key)) found = el.getAttribute("content") || "";
    } }).transform(new Response(got.bytes, { headers: { "content-type": "text/html" } })).text();
    try { url = found && checkLink(new URL(found.replaceAll("&amp;", "&"), url).href); } catch { url = null; }
    if (!url) return { error: "That page doesn't name an image. Right-click the picture, copy the image address, and use that instead." };
  }
  return { error: "That link isn't a PNG, JPEG, GIF or WebP image." };
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
    for (const f of files) {
      if (f.base64 == null) continue;
      const blob = await call(env, "git/blobs", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: f.base64, encoding: "base64" }) });
      f.sha = blob.sha;
    }
    const base = await call(env, `git/commits/${parent}`);
    const tree = await call(env, "git/trees", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_tree: base.tree.sha, tree: files.map(f => ({ path: f.path, mode: "100644", type: "blob",
        ...(f.sha ? { sha: f.sha } : f.content == null ? { sha: null } : { content: f.content }) })) }) });
    const made = await call(env, "git/commits", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, tree: tree.sha, parents: [parent] }) });
    await call(env, `git/refs/heads/${encodeURIComponent(env.LEDGER_BRANCH)}`, { method: "PATCH",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ sha: made.sha, force: false }) });
    return made.sha;
  }

  const text = data => JSON.stringify(data, null, 2) + "\n";

  function readTitle(body) {
    const title = cleanText(body.title, 200);
    if (!title) throw new ApiError(400, "Title is required.");
    if (typeof body.html !== "string" || body.html.length > MAX_HTML) throw new ApiError(400, "The post body is missing or too long.");
    return title;
  }

  async function readImages(body, slug) {
    const images = body.images ?? {};
    if (!images || typeof images !== "object" || Array.isArray(images) || Object.keys(images).length > 30) {
      throw new ApiError(400, "Images must be at most 30 per publish.");
    }
    const files = [], urls = {};
    let total = 0;
    for (const [id, value] of Object.entries(images)) {
      const m = typeof value === "string" && value.match(/^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!/^[a-z0-9]{1,32}$/.test(id) || !m) throw new ApiError(400, "An image could not be read.");
      let bytes;
      try { bytes = Uint8Array.from(atob(m[1]), c => c.charCodeAt(0)); } catch { throw new ApiError(400, "An image could not be read."); }
      total += bytes.length;
      if (bytes.length > MAX_IMAGE || total > MAX_IMAGES_TOTAL) throw new ApiError(413, "Images must be under 5 MB each and 15 MB per publish.");
      const ext = IMAGE_TYPES.find(([, test]) => test(bytes))?.[0];
      if (!ext) throw new ApiError(400, "Only PNG, JPEG, GIF and WebP images can be uploaded.");
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const name = [...digest.slice(0, 8)].map(b => b.toString(16).padStart(2, "0")).join("") + "." + ext;
      const path = `assets/blog/${slug}/${name}`;
      urls[id] = `${SITE}/${path}`;
      if (!files.some(f => f.path === path)) files.push({ path, base64: m[1] });
    }
    return { files, urls };
  }

  async function readPost(body, slug) {
    const title = readTitle(body);
    const { files, urls } = await readImages(body, slug);
    const html = await sanitize(await linkUploads(body.html, urls));
    if (!html.replace(/<[^>]*>/g, "").trim() && !/<img\s/i.test(html)) throw new ApiError(400, "The post is empty.");
    return { title, html, files };
  }

  return async function blog(request, env, url, headers) {
    const path = url.pathname.slice("/api/blog".length);
    const one = path.match(/^\/posts\/([a-z0-9-]{1,80})$/);
    const del = path.match(/^\/posts\/([a-z0-9-]{1,80})\/delete$/);
    if (path === "/image-from-link") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405, { ...headers, allow: "POST" });
      const { url } = await readBody(request);
      const result = await imageFromLink(typeof url === "string" ? url.trim().slice(0, 2048) : "");
      return result.error ? json({ ok: false, error: result.error }, 422, headers) : json({ ok: true, data: result.data }, 200, headers);
    }
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

    const body = del ? {} : await readBody(request, 24 * 1024 * 1024);
    const parent = await head(env);
    const index = await readIndex(env, parent);
    const now = new Date().toISOString();

    if (path === "/posts") {
      const taken = new Set(index.posts.map(p => p.slug));
      const root = slugify(readTitle(body));
      let next = root;
      for (let n = 2; taken.has(next); n++) next = `${root}-${n}`;
      const { title, html, files } = await readPost(body, next);
      const post = { slug: next, title, date: now.slice(0, 10), created_timestamp: now, updated_timestamp: null, html };
      index.posts.unshift({ slug: next, title, date: post.date });
      const sha = await commit(env, parent, [
        ...files,
        { path: `${POST_DIR}/${next}.json`, content: text(post) },
        { path: INDEX_PATH, content: text(index) },
      ], `Blog: publish ${next}`);
      return json({ ok: true, slug: next, commit: sha }, 201, headers);
    }

    const at = index.posts.findIndex(p => p.slug === slug);
    if (at < 0) return json({ ok: false, error: "Post not found." }, 404, headers);

    if (del) {
      index.posts.splice(at, 1);
      // Remove the images this post uploaded; other links are left alone.
      const old = await readFile(env, `${POST_DIR}/${slug}.json`, parent);
      const prefix = `${SITE}/assets/blog/${slug}/`;
      const images = [...new Set([...(old?.html || "").matchAll(/src="([^"]+)"/g)].map(m => m[1])
        .filter(src => src.startsWith(prefix) && /^[a-f0-9]{16}\.(png|jpg|gif|webp)$/.test(src.slice(prefix.length))))];
      const sha = await commit(env, parent, [
        ...images.map(src => ({ path: src.slice(SITE.length + 1), content: null })),
        { path: `${POST_DIR}/${slug}.json`, content: null },
        { path: INDEX_PATH, content: text(index) },
      ], `Blog: delete ${slug}`);
      return json({ ok: true, commit: sha }, 200, headers);
    }

    const existing = await readFile(env, `${POST_DIR}/${slug}.json`, parent);
    if (!existing) throw new ApiError(502, "The post file is missing; repair it through GitHub.");
    const { title, html, files } = await readPost(body, slug);
    const post = { ...existing, title, html, updated_timestamp: now };
    index.posts[at] = { ...index.posts[at], title, updated: now.slice(0, 10) };
    const sha = await commit(env, parent, [
      ...files,
      { path: `${POST_DIR}/${slug}.json`, content: text(post) },
      { path: INDEX_PATH, content: text(index) },
    ], `Blog: update ${slug}`);
    return json({ ok: true, slug, commit: sha }, 200, headers);
  };
}
