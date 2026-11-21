// Private research notebook. Everything is stored in a private repository
// (mihirs-0/research-notebook), reached with its own token, never the site's.
const REPO = "mihirs-0/research-notebook";
const BRANCH = "main";
const INDEX_PATH = "index.json";
const PAGE_ORIGIN = "https://map-admin.mihirss.com";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID = /^[a-z0-9]{6,24}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const KINDS = new Set(["note", "question", "evidence", "belief", "experiment"]);
const LINK_KINDS = new Set(["", "replaces"]);
const INKS = new Set(["#23201C", "#8C3B2E", "#2F5D8A", "#4F7A3A"]);
const STATUSES = ["draft", "preregistered", "running", "concluded"];
const OUTCOMES = new Set(["", "falsified", "survived", "inconclusive"]);
// The plan is what preregistration freezes; results and deviations stay writable.
export const PLAN_FIELDS = ["belief", "hypothesis", "prediction", "design", "variables", "sample", "analysis", "confounds", "falsify"];
const MAX_BODY = 3_000_000;
const MAX_POINTS = 300_000;

export function notebookRoutes({ json, readBody, ApiError }) {
  const bad = message => new ApiError(400, message);

  function gh(env, path, options = {}) {
    return fetch(`https://api.github.com/repos/${REPO}/${path}`, {
      ...options,
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      headers: {
        "accept": "application/vnd.github+json",
        "authorization": `Bearer ${env.NOTEBOOK_GITHUB_TOKEN}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "research-notebook-worker",
        ...(options.headers || {}),
      },
    });
  }
  class Race extends Error {}
  async function call(env, path, options) {
    const r = await gh(env, path, options);
    if (r.ok) return r.json();
    if (r.status === 401) throw new ApiError(502, "GitHub rejected the notebook token. Replace the NOTEBOOK_GITHUB_TOKEN secret.");
    if (r.status === 403 || r.status === 404) throw new ApiError(502, "GitHub refused access to research-notebook. Check NOTEBOOK_GITHUB_TOKEN has Contents read and write for that repository.");
    if (r.status === 409 || r.status === 422) throw new Race();
    throw new ApiError(502, "GitHub could not complete the request. Try again.");
  }
  async function head(env) {
    return (await call(env, `git/ref/heads/${BRANCH}`)).object.sha;
  }
  async function readFile(env, path, ref) {
    const r = await gh(env, `contents/${path}?ref=${encodeURIComponent(ref)}`, { headers: { accept: "application/vnd.github.raw+json" } });
    if (r.status === 404) return null;
    if (!r.ok) throw new ApiError(502, "The notebook could not be read from GitHub.");
    try { return JSON.parse(await r.text()); } catch { throw new ApiError(502, `${path} in research-notebook is not valid JSON.`); }
  }
  async function readIndex(env, ref) {
    const data = (await readFile(env, INDEX_PATH, ref)) || { version: 1, projects: [] };
    if (data.version !== 1 || !Array.isArray(data.projects)) throw new ApiError(502, "index.json in research-notebook needs repair.");
    return data;
  }
  async function commit(env, parent, files, message) {
    const base = await call(env, `git/commits/${parent}`);
    const tree = await call(env, "git/trees", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_tree: base.tree.sha, tree: files.map(f => ({ path: f.path, mode: "100644", type: "blob",
        ...(f.content == null ? { sha: null } : { content: f.content }) })) }) });
    const made = await call(env, "git/commits", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, tree: tree.sha, parents: [parent] }) });
    await call(env, `git/refs/heads/${BRANCH}`, { method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha: made.sha, force: false }) });
    return made.sha;
  }
  // Re-run the whole read-check-write when another save moved the branch first.
  async function withRetry(fn) {
    for (let i = 0; ; i++) {
      try { return await fn(); }
      catch (e) { if (!(e instanceof Race)) throw e; if (i === 2) throw new ApiError(409, "The notebook was busy. Try again."); }
    }
  }
  const text = data => JSON.stringify(data, null, 2) + "\n";
  const path = slug => `projects/${slug}.json`;

  /* ---------- validation ---------- */
  function str(v, max, label) {
    if (v == null) return "";
    if (typeof v !== "string") throw bad(`${label} must be text.`);
    v = v.trim();
    if (v.length > max) throw bad(`${label} must be at most ${max} characters.`);
    return v;
  }
  function num(v, lo, hi, label) {
    const n = Number(v);
    if (typeof v !== "number" || !Number.isFinite(n) || n < lo || n > hi) throw bad(`${label} is out of range.`);
    return Math.round(n * 10) / 10;
  }
  const time = v => (typeof v === "string" && TIME.test(v) ? v : "");
  const id = (v, label) => { if (typeof v !== "string" || !ID.test(v)) throw bad(`${label} has a bad id.`); return v; };
  const list = (v, max, label) => {
    if (v == null) return [];
    if (!Array.isArray(v) || v.length > max) throw bad(`At most ${max} ${label}.`);
    return v;
  };
  const obj = v => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

  function cleanBoard(b) {
    b = obj(b);
    const seen = new Set();
    const cards = list(b.cards, 600, "cards").map(c => {
      c = obj(c);
      const card = { id: id(c.id, "A card"), kind: c.kind, x: num(c.x, -1e6, 1e6, "Card position"), y: num(c.y, -1e6, 1e6, "Card position"),
        w: num(c.w ?? 220, 120, 640, "Card width"), text: str(c.text, 4000, "Card text") };
      if (!KINDS.has(card.kind)) throw bad("Unknown card kind.");
      if (seen.has(card.id)) throw bad("Duplicate card id."); seen.add(card.id);
      if (card.kind === "belief") {
        card.conf = c.conf == null || c.conf === "" ? null : num(c.conf, 0, 100, "Confidence");
        card.pinned_at = time(c.pinned_at);
        card.superseded_at = time(c.superseded_at);
        card.superseded_by = typeof c.superseded_by === "string" && ID.test(c.superseded_by) ? c.superseded_by : "";
      }
      if (card.kind === "experiment") card.exp = id(c.exp, "An experiment card");
      return card;
    });
    const links = list(b.links, 1500, "links").map(l => {
      l = obj(l);
      const link = { id: id(l.id, "A link"), from: id(l.from, "A link"), to: id(l.to, "A link"), kind: l.kind || "" };
      if (!LINK_KINDS.has(link.kind)) throw bad("Unknown link kind.");
      return link;
    }).filter(l => seen.has(l.from) && seen.has(l.to) && l.from !== l.to);
    let points = 0;
    const strokes = list(b.strokes, 3000, "strokes").map(s => {
      s = obj(s);
      if (!INKS.has(s.color)) throw bad("Unknown ink.");
      const pts = list(s.pts, 8000, "points in a stroke");
      if (pts.length < 2 || pts.length % 2) throw bad("A stroke needs x,y pairs.");
      points += pts.length;
      return { id: id(s.id, "A stroke"), color: s.color, w: num(s.w ?? 3, 1, 16, "Stroke width"), pts: pts.map(p => num(p, -1e6, 1e6, "Stroke point")) };
    });
    if (points > MAX_POINTS) throw bad("The drawing is too large. Erase some ink.");
    const v = obj(b.view);
    const view = { x: num(v.x ?? 0, -1e7, 1e7, "View"), y: num(v.y ?? 0, -1e7, 1e7, "View"), z: num(v.z ?? 1, 0.1, 4, "Zoom") };
    return { cards, links, strokes, view };
  }

  async function sha256(value) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
  }

  async function cleanExperiments(input, stored, now) {
    const before = new Map((stored || []).map(e => [e.id, e]));
    const seen = new Set();
    const out = [];
    for (let e of list(input, 300, "experiments")) {
      e = obj(e);
      const exp = { id: id(e.id, "An experiment"), title: str(e.title, 200, "Experiment title") };
      if (seen.has(exp.id)) throw bad("Duplicate experiment id."); seen.add(exp.id);
      if (!STATUSES.includes(e.status)) throw bad("Unknown experiment status.");
      exp.status = e.status;
      const plan = obj(e.plan);
      exp.plan = {};
      for (const f of PLAN_FIELDS) exp.plan[f] = str(plan[f], 8000, "A plan field");
      exp.results = str(e.results, 30000, "Results");
      exp.deviations = str(e.deviations, 15000, "Deviations");
      exp.outcome = OUTCOMES.has(e.outcome) ? e.outcome : "";
      if (exp.status !== "concluded") exp.outcome = "";
      const old = before.get(exp.id);
      exp.created = old?.created || now;
      const sig = x => JSON.stringify([x.title, x.status, x.plan, x.results, x.deviations, x.outcome]);
      exp.updated = old && sig(old) === sig(exp) ? old.updated : now;
      if (old && old.status !== "draft") {
        // Locked: the title and plan must match what was registered, and status only moves forward.
        const changed = old.title !== exp.title || PLAN_FIELDS.some(f => (old.plan?.[f] || "") !== exp.plan[f]);
        if (changed) throw new ApiError(409, `“${old.title}” was preregistered and its plan is locked. Note changes under Deviations.`);
        if (STATUSES.indexOf(exp.status) < STATUSES.indexOf(old.status)) throw bad("A preregistered experiment can't go back to draft.");
        exp.registered_at = old.registered_at; exp.registered_hash = old.registered_hash;
      } else if (exp.status !== "draft") {
        if (exp.status !== "preregistered") throw bad("Preregister an experiment before running it.");
        if (!exp.title || !exp.plan.hypothesis || !exp.plan.prediction || !exp.plan.falsify) {
          throw bad("To preregister, fill in the title, hypothesis, prediction and the one thing you're trying to falsify.");
        }
        exp.registered_at = now;
        exp.registered_hash = await sha256(JSON.stringify([exp.title, PLAN_FIELDS.map(f => exp.plan[f]), now]));
      } else { exp.registered_at = ""; exp.registered_hash = ""; }
      out.push(exp);
    }
    for (const old of before.values()) {
      if (old.status !== "draft" && !seen.has(old.id)) throw new ApiError(409, `“${old.title}” was preregistered and can't be deleted.`);
    }
    return out;
  }

  function cleanFocus(f) {
    f = obj(f);
    return { text: str(f.text, 600, "Working on"), at: time(f.at) };
  }

  async function cleanProject(input, stored, now) {
    input = obj(input);
    const title = str(input.title, 120, "Project title");
    if (!title) throw bad("A project needs a title.");
    const board = cleanBoard(input.board);
    const experiments = await cleanExperiments(input.experiments, stored?.experiments, now);
    const expIds = new Set(experiments.map(e => e.id));
    board.cards = board.cards.filter(c => c.kind !== "experiment" || expIds.has(c.exp));
    const cardIds = new Set(board.cards.map(c => c.id));
    board.links = board.links.filter(l => cardIds.has(l.from) && cardIds.has(l.to));
    return {
      version: 1, slug: stored.slug, rev: (stored.rev || 0) + 1,
      title, question: str(input.question, 1500, "Question"), archived: input.archived === true,
      created: stored.created || now, updated: now,
      focus: cleanFocus(input.focus),
      focus_history: list(input.focus_history, 300, "earlier focus pins").map(cleanFocus).filter(f => f.text),
      board, experiments,
    };
  }

  function summary(p) {
    const beliefs = p.board.cards.filter(c => c.kind === "belief" && !c.superseded_at)
      .sort((a, b) => (a.pinned_at < b.pinned_at ? 1 : -1)).slice(0, 3).map(c => ({ text: c.text.slice(0, 300), conf: c.conf }));
    const experiments = Object.fromEntries(STATUSES.map(s => [s, p.experiments.filter(e => e.status === s).length]));
    return { slug: p.slug, title: p.title, question: p.question.slice(0, 400), archived: p.archived, updated: p.updated,
      focus: p.focus.text.slice(0, 300), beliefs, experiments };
  }
  function slugify(title) {
    const s = title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
    return s || "project";
  }
  function emptyProject(slug, title, question, now) {
    return { version: 1, slug, rev: 1, title, question, archived: false, created: now, updated: now,
      focus: { text: "", at: "" }, focus_history: [], board: { cards: [], links: [], strokes: [], view: { x: 0, y: 0, z: 1 } }, experiments: [] };
  }

  /* ---------- routes ---------- */
  return async function notebook(request, env, url, headers) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== PAGE_ORIGIN) return json({ ok: false, error: "Origin is not allowed." }, 403, headers);
    if (typeof env.NOTEBOOK_GITHUB_TOKEN !== "string" || !env.NOTEBOOK_GITHUB_TOKEN.trim()) {
      return json({ ok: false, error: "The notebook isn't connected to its private repository yet (NOTEBOOK_GITHUB_TOKEN is not set)." }, 503, headers);
    }
    const parts = url.pathname.slice("/api/notebook/".length).split("/");
    const now = new Date().toISOString();

    if (parts[0] === "projects" && parts.length === 1) {
      if (request.method === "GET") {
        const ref = await head(env);
        return json({ ok: true, projects: (await readIndex(env, ref)).projects }, 200, headers);
      }
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405, headers);
      const body = await readBody(request);
      const title = str(body.title, 120, "Project title");
      if (!title) throw bad("A project needs a title.");
      const question = str(body.question, 1500, "Question");
      return withRetry(async () => {
        const ref = await head(env);
        const index = await readIndex(env, ref);
        const taken = new Set(index.projects.map(p => p.slug));
        const base = slugify(title);
        let slug = base;
        for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
        const project = emptyProject(slug, title, question, now);
        index.projects.unshift(summary(project));
        await commit(env, ref, [{ path: path(slug), content: text(project) }, { path: INDEX_PATH, content: text(index) }], `New project: ${title}`);
        return json({ ok: true, project }, 201, headers);
      });
    }

    const slug = parts[1];
    if (parts[0] !== "projects" || !slug || !SLUG.test(slug) || parts.length > 3 || (parts.length === 3 && parts[2] !== "delete")) {
      return json({ ok: false, error: "Not found." }, 404, headers);
    }

    if (parts.length === 2 && request.method === "GET") {
      const project = await readFile(env, path(slug), await head(env));
      if (!project) return json({ ok: false, error: "Project not found." }, 404, headers);
      return json({ ok: true, project }, 200, headers);
    }
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405, headers);

    if (parts.length === 3) {
      return withRetry(async () => {
        const ref = await head(env);
        const project = await readFile(env, path(slug), ref);
        if (!project) return json({ ok: false, error: "Project not found." }, 404, headers);
        if (project.experiments.some(e => e.status !== "draft")) {
          return json({ ok: false, error: "This project has preregistered experiments, so it can be archived but not deleted." }, 409, headers);
        }
        const index = await readIndex(env, ref);
        index.projects = index.projects.filter(p => p.slug !== slug);
        await commit(env, ref, [{ path: path(slug), content: null }, { path: INDEX_PATH, content: text(index) }], `Delete project: ${project.title}`);
        return json({ ok: true }, 200, headers);
      });
    }

    const body = await readBody(request, MAX_BODY);
    const incoming = obj(body.project);
    if (!Number.isSafeInteger(incoming.rev)) throw bad("The project revision is missing.");
    return withRetry(async () => {
      const ref = await head(env);
      const stored = await readFile(env, path(slug), ref);
      if (!stored) return json({ ok: false, error: "Project not found." }, 404, headers);
      if (stored.rev !== incoming.rev) {
        return json({ ok: false, stale: true, error: "This project was changed somewhere else. Reload to get the latest version." }, 409, headers);
      }
      const project = await cleanProject(incoming, stored, now);
      const index = await readIndex(env, ref);
      const at = index.projects.findIndex(p => p.slug === slug);
      if (at >= 0) index.projects.splice(at, 1);
      index.projects.unshift(summary(project));
      const registered = project.experiments.filter(e => e.registered_at === now).map(e => e.title);
      const message = registered.length ? `Preregister: ${registered.join("; ")}` : `${project.title}: update`;
      await commit(env, ref, [{ path: path(slug), content: text(project) }, { path: INDEX_PATH, content: text(index) }], message);
      return json({ ok: true, project }, 200, headers);
    });
  };
}
