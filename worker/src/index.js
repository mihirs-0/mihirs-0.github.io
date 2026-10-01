const REPO = "mihirs-0/mihirs-0.github.io";
const BRANCH = "main";
const DATA_PATH = "data/map-of-reality.json";
const ALLOWED_ORIGIN = "https://mihirss.com";

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

function cors(request) {
  const origin = request.headers.get("Origin");
  if (origin !== ALLOWED_ORIGIN) return {};
  return {
    "access-control-allow-origin": ALLOWED_ORIGIN,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "vary": "Origin",
  };
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function makeSession(env) {
  const expires = Date.now() + 1000 * 60 * 60 * 24 * 7;
  const payload = `${expires}`;
  const sig = await hmac(env.SESSION_SECRET, payload);
  return `${payload}.${sig}`;
}

async function validSession(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|; )mor_session=([^;]+)/);
  if (!match) return false;
  const [expires, sig] = match[1].split(".");
  if (!expires || !sig || Number(expires) < Date.now()) return false;
  return sig === await hmac(env.SESSION_SECRET, expires);
}

async function github(env, path, options = {}) {
  return fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    ...options,
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "map-of-reality-worker",
      ...(options.headers || {}),
    },
  });
}

async function readLedger(env) {
  const r = await github(env, `contents/${DATA_PATH}?ref=${encodeURIComponent(BRANCH)}`);
  if (!r.ok) throw new Error(`GitHub read failed: ${r.status}`);
  const file = await r.json();
  const content = decodeURIComponent(escape(atob(file.content.replace(/\n/g, ""))));
  return { sha: file.sha, data: JSON.parse(content) };
}

async function writeLedger(env, sha, data, message) {
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2) + "\n")));
  const r = await github(env, `contents/${DATA_PATH}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, content, sha, branch: BRANCH }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`GitHub write failed: ${r.status} ${body}`);
  }
  return r.json();
}

function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function validConfidence(value) {
  if (value === null || value === "" || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

export default {
  async fetch(request, env) {
    const headers = cors(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    const url = new URL(request.url);

    if (url.pathname === "/api/login" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (body.username !== env.ADMIN_USERNAME || body.password !== env.ADMIN_PASSWORD) {
        return json({ ok: false, error: "Invalid credentials." }, 401, headers);
      }
      const session = await makeSession(env);
      return json({ ok: true }, 200, {
        ...headers,
        "set-cookie": `mor_session=${session}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`,
      });
    }

    if (url.pathname === "/api/logout" && request.method === "POST") {
      return json({ ok: true }, 200, {
        ...headers,
        "set-cookie": "mor_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
      });
    }

    if (url.pathname === "/api/me" && request.method === "GET") {
      return json({ authenticated: await validSession(request, env) }, 200, headers);
    }

    if (!(await validSession(request, env))) {
      return json({ ok: false, error: "Authentication required." }, 401, headers);
    }

    if (url.pathname === "/api/entries" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const claim = cleanText(body.claim, 800);
      const kind = body.kind === "forecast" ? "forecast" : "map";
      const reasoning = cleanText(body.reasoning, 4000);
      const horizon = cleanText(body.horizon, 120);
      const confidence = validConfidence(body.confidence);
      if (!claim) return json({ ok: false, error: "Claim is required." }, 400, headers);
      if (body.confidence !== "" && body.confidence != null && confidence == null) {
        return json({ ok: false, error: "Confidence must be between 0 and 100." }, 400, headers);
      }

      const ledger = await readLedger(env);
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      ledger.data.entries.push({
        id,
        kind,
        claim,
        confidence,
        horizon,
        reasoning,
        created_at: now.slice(0, 10),
        created_timestamp: now,
        updates: [],
      });
      await writeLedger(env, ledger.sha, ledger.data, `Map of Reality: add ${id}`);
      return json({ ok: true, id }, 201, headers);
    }

    const updateMatch = url.pathname.match(/^\/api\/entries\/([^/]+)\/updates$/);
    if (updateMatch && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const note = cleanText(body.note, 4000);
      const confidence = validConfidence(body.confidence);
      if (!note) return json({ ok: false, error: "Update note is required." }, 400, headers);
      if (body.confidence !== "" && body.confidence != null && confidence == null) {
        return json({ ok: false, error: "Confidence must be between 0 and 100." }, 400, headers);
      }

      const ledger = await readLedger(env);
      const entry = ledger.data.entries.find(e => e.id === updateMatch[1]);
      if (!entry) return json({ ok: false, error: "Entry not found." }, 404, headers);
      const now = new Date().toISOString();
      entry.updates = Array.isArray(entry.updates) ? entry.updates : [];
      entry.updates.push({
        date: now.slice(0, 10),
        timestamp: now,
        confidence,
        note,
      });
      await writeLedger(env, ledger.sha, ledger.data, `Map of Reality: update ${entry.id}`);
      return json({ ok: true }, 201, headers);
    }

    return json({ ok: false, error: "Not found." }, 404, headers);
  },
};
