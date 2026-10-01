import api from "./index.js";
import admin from "../../instruments/map-of-reality-admin.html";

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/admin" && request.method === "GET") {
      return new Response(admin, { headers: {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "x-content-type-options": "nosniff", "x-frame-options": "DENY",
        "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src https://map-admin.mihirss.com; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      }});
    }
    return api.fetch(request, env);
  },
};
