# platinumspeedrunner.dev

Personal website — About, Resume, and Math Projects. Plain HTML/CSS/JS, no
build step. Deployed via Cloudflare Pages from this GitHub repo.

The Math Projects page links out to a few tools that are self-hosted on a
home Raspberry Pi instead of living in this repo — a weather station, a
golf tee-time advisor, and a fantasy football lineup optimizer (moved here
from a Cloudflare Pages Function; see below).

## Structure

- `index.html` — About page
- `resume.html` — Resume / accomplishments
- `projects.html` — Math projects, including links to the Pi-hosted tools
- `style.css` — shared styles
- `worker.js` — trivial Worker that just serves static assets (no custom
  routes anymore)

## Local preview

Open `index.html` directly in a browser, or serve the folder with any
static file server.

## Deploy

Pushes to `main` auto-deploy via the Cloudflare Pages project connected to
this repo (Workers Builds — no GitHub Actions workflow involved).

## Fantasy football lineup optimizer moved to the Pi

This used to run here as `fantasy.html` + `functions/optimize.js` +
`functions/lib/` (a Cloudflare Pages Function) with a separate `worker/`
Cron Trigger for weekly trend snapshots, backed by a `HISTORY_KV`
namespace. All of that was retired in favor of a self-hosted version at
`~/fantasy_pi` on the Pi (same analysis code, ported almost unchanged —
see that project's README for why and how). If you're looking for the old
Cloudflare-hosted version, check git history before this migration.
