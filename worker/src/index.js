const REPO = "mihirs-0/mihirs-0.github.io";
const BRANCHES = new Set(["map-of-reality", "main"]);
const DATA_PATH = "data/map-of-reality.json";
const ALLOWED_ORIGINS = new Set(["https://mihirss.com", "https://map-admin.mihirss.com"]);
const COOKIE = "__Host-mor_session";
const TTL = 8 * 60 * 60 * 1000;
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
}

function cors(request) {
  const origin = request.headers.get("Origin");
  if (!ALLOWED_ORIGINS.has(origin)) return { vary: "Origin" };
  return {
    "access-control-allow-origin": origin,
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
  const expires = Date.now() + TTL;
  const payload = `${expires}`;
  const sig = await hmac(env.SESSION_SECRET, sessionPayload(env, payload));
  return `${payload}.${sig}`;
}

function sessionPayload(env, expires) {
  // Credential rotation invalidates all existing sessions.
  return JSON.stringify(["mor-v1", env.ADMIN_USERNAME, env.ADMIN_PASSWORD, expires]);
}
async function verify(secret, payload, sig) {
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const bytes = Uint8Array.from(atob(sig.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
    return await crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(payload));
  } catch { return false; }
}
async function validSession(request, env) {
  const cookie = (request.headers.get("Cookie") || "").split(/;\s*/)
    .find(c => c.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
  if (!cookie) return false;
  const parts = cookie.split(".");
  if (parts.length !== 2 || !/^\d{13}$/.test(parts[0])) return false;
  const expires = Number(parts[0]);
  if (!Number.isSafeInteger(expires) || expires <= Date.now() || expires > Date.now() + TTL) return false;
  return verify(env.SESSION_SECRET, sessionPayload(env, parts[0]), parts[1]);
}
async function readBody(request) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new ApiError(415, "JSON is required.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "A JSON object is required.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, content = "";
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 32768) { await reader.cancel(); throw new ApiError(413, "Request is too large."); }
    content += decoder.decode(value, { stream: true });
  }
  content += decoder.decode();
  let data;
  try { data = JSON.parse(content); } catch { throw new ApiError(400, "Invalid JSON."); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new ApiError(400, "A JSON object is required.");
  return data;
}

async function github(env, path, options = {}) {
  return fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    ...options,
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
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
  const r = await github(env, `contents/${DATA_PATH}?ref=${encodeURIComponent(env.LEDGER_BRANCH)}`);
  if (!r.ok) throw new ApiError(502, "The ledger could not be read from GitHub.");
  const file = await r.json();
  const content = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(file.content.replace(/\n/g, "")), c => c.charCodeAt(0)));
  const data = JSON.parse(content);
  if (data.version !== 1 || !Array.isArray(data.entries) || typeof file.sha !== "string"
      || data.entries.some(e => !e || typeof e.id !== "string" || !Array.isArray(e.updates))) {
    throw new ApiError(502, "The ledger format needs repair through GitHub.");
  }
  return { sha: file.sha, data };
}

async function writeLedger(env, sha, data, message) {
  const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2) + "\n");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  const content = btoa(binary);
  const r = await github(env, `contents/${DATA_PATH}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, content, sha, branch: env.LEDGER_BRANCH }),
  });
  if (!r.ok) {
    if (r.status === 409 || r.status === 422) throw new ApiError(409, "The ledger changed. Review it and try again.");
    // Do not expose upstream bodies or credential details.
    throw new ApiError(502, "GitHub could not confirm publication. Check the ledger before retrying.");
  }
  return r.json();
}

function cleanText(value, max) {
  if (value == null) return "";
  if (typeof value !== "string" || value.trim().length > max) throw new ApiError(400, `Text must be at most ${max} characters.`);
  return value.trim();
}

function validConfidence(value) {
  if (value === null || value === "" || value === undefined) return null;
  if (!["string", "number"].includes(typeof value) || (typeof value === "string" && !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

const api = {
  async fetch(request, env) {
    const headers = cors(request);
    const url = new URL(request.url);
    const updateRoute = /^\/api\/entries\/[a-f0-9-]{36}\/updates$/.test(url.pathname);
    const method = url.pathname === "/api/me" ? "GET"
      : ["/api/login", "/api/logout", "/api/entries"].includes(url.pathname) || updateRoute ? "POST" : null;
    if (!method) return json({ ok: false, error: "Not found." }, 404, headers);
    if (request.method !== method && request.method !== "OPTIONS") return json({ ok: false, error: "Method not allowed." }, 405, { ...headers, allow: method });
    const origin = request.headers.get("Origin");
    // SameSite cookies alone do not protect against a hostile sibling subdomain.
    if ((request.method !== "GET" || origin) && !ALLOWED_ORIGINS.has(origin)) return json({ ok: false, error: "Origin is not allowed." }, 403, headers);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (!["ADMIN_USERNAME", "ADMIN_PASSWORD", "SESSION_SECRET", "GITHUB_TOKEN"].every(name => typeof env[name] === "string" && env[name].trim())
        || env.ADMIN_PASSWORD.length < 16 || env.SESSION_SECRET.length < 32
        || !BRANCHES.has(env.LEDGER_BRANCH) || typeof env.LOGIN_LIMITER?.limit !== "function") {
      return json({ ok: false, error: "Admin service is not configured." }, 503, headers);
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      const { success } = await env.LOGIN_LIMITER.limit({ key: `mor-login:${request.headers.get("cf-connecting-ip") || "unknown"}` });
      if (!success) return json({ ok: false, error: "Too many login attempts. Try again shortly." }, 429, { ...headers, "retry-after": "60" });
      const body = await readBody(request);
      const validTypes = typeof body.username === "string" && body.username.length <= 256
        && typeof body.password === "string" && body.password.length <= 1024;
      const expected = await hmac(env.SESSION_SECRET, JSON.stringify([env.ADMIN_USERNAME, env.ADMIN_PASSWORD]));
      if (!validTypes || !await verify(env.SESSION_SECRET, JSON.stringify([body.username, body.password]), expected)) {
        return json({ ok: false, error: "Invalid credentials." }, 401, headers);
      }
      const session = await makeSession(env);
      return json({ ok: true }, 200, {
        ...headers,
        "set-cookie": `${COOKIE}=${session}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`,
      });
    }

    if (url.pathname === "/api/logout" && request.method === "POST") {
      return json({ ok: true }, 200, {
        ...headers,
        "set-cookie": `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
      });
    }

    if (url.pathname === "/api/me" && request.method === "GET") {
      return json({ authenticated: await validSession(request, env) }, 200, headers);
    }

    if (!(await validSession(request, env))) {
      return json({ ok: false, error: "Authentication required." }, 401, headers);
    }

    if (url.pathname === "/api/entries" && request.method === "POST") {
      const body = await readBody(request);
      const claim = cleanText(body.claim, 800);
      if (!["map", "forecast"].includes(body.kind)) return json({ ok: false, error: "Kind must be map or forecast." }, 400, headers);
      const kind = body.kind;
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
      const result = await writeLedger(env, ledger.sha, ledger.data, `Map of Reality: add ${id}`);
      return json({ ok: true, id, commit: result.commit.sha }, 201, headers);
    }

    const updateMatch = url.pathname.match(/^\/api\/entries\/([^/]+)\/updates$/);
    if (updateMatch && request.method === "POST") {
      const body = await readBody(request);
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
      entry.updates.push({
        date: now.slice(0, 10),
        timestamp: now,
        confidence,
        note,
      });
      const result = await writeLedger(env, ledger.sha, ledger.data, `Map of Reality: update ${entry.id}`);
      return json({ ok: true, commit: result.commit.sha }, 201, headers);
    }

    return json({ ok: false, error: "Not found." }, 404, headers);
  },
};

export default {
  async fetch(request, env) {
    try { return await api.fetch(request, env); }
    catch (error) {
      return json({ ok: false, error: error instanceof ApiError ? error.message : "Request could not be completed. Check the ledger before retrying." },
        error instanceof ApiError ? error.status : 502, cors(request));
    }
  },
};
