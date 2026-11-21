import api from "./index.js";
import admin from "../../instruments/map-of-reality-admin.html";
import blogAdmin from "../../blog/admin.html";
import notebook from "./notebook.html";

const PAGES = { "/admin": admin, "/blog": blogAdmin, "/notebook": notebook };

export default {
  async fetch(request, env) {
    const page = PAGES[new URL(request.url).pathname];
    if (page && request.method === "GET") {
      return new Response(page, { headers: {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "x-content-type-options": "nosniff", "x-frame-options": "DENY",
        "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src https: data:; connect-src https://map-admin.mihirss.com; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      }});
    }
    return api.fetch(request, env);
  },
};
