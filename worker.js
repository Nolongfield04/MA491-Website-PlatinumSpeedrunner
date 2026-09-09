// Static assets (index.html, style.css, images, ...) are served directly
// by the assets binding. No custom routes anymore - the fantasy football
// feature that used to live at /optimize moved to a self-hosted Node app
// on the Raspberry Pi (see ~/fantasy_pi), linked from projects.html.
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
