import { onRequestGet as optimizeHandler } from "./functions/optimize.js";

// Static assets (index.html, fantasy.html, style.css, images, ...) are
// served directly by the assets binding and never reach this fetch handler
// unless the path doesn't match a file — that's how /optimize gets here.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/optimize" && request.method === "GET") {
      return optimizeHandler({ request, env, ctx });
    }

    return env.ASSETS.fetch(request);
  },
};
