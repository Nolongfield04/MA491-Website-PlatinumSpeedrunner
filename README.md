# platinumspeedrunner.dev

Personal website — About, Resume, Math Projects, and a fantasy football
lineup optimizer. Plain HTML/CSS/JS, no build step. Deployed via Cloudflare
Pages from this GitHub repo.

## Structure

- `index.html` — About page
- `resume.html` — Resume / accomplishments
- `projects.html` — Math projects
- `fantasy.html` — Fantasy football lineup optimizer (calls `/optimize`)
- `style.css` — shared styles
- `functions/optimize.js` + `functions/lib/` — Cloudflare Pages Function
  backing `fantasy.html`: pulls the ESPN league roster, layers on matchup/
  injury/weather/trend signals, and returns an optimized lineup, waiver
  targets, and trade suggestions.
- `worker/` — a separate Cloudflare Worker (Pages Functions don't support
  Cron Triggers) that runs weekly to record each week's actual-vs-projected
  results into KV, so `fantasy.html` can show player trend history.

## Local preview

Open `index.html` directly in a browser, or serve the folder with any static
file server. `functions/optimize.js` needs Cloudflare's runtime (KV binding,
env vars) to run — use `npx wrangler pages dev .` for a local preview of the
API, or just work on the static pages directly.

## Deploy

- **Static site + `/optimize` API**: pushes to `main` auto-deploy via the
  Cloudflare Pages project connected to this repo. Requires a `HISTORY_KV`
  KV namespace bound in the Pages project settings, and the `ESPN_LEAGUE_ID`,
  `ESPN_TEAM_ID`, `ESPN_S2`, `ESPN_SWID` (and optional `ESPN_SEASON`)
  environment variables set there.
- **Weekly snapshot job**: deployed separately from `worker/`, since it
  changes rarely — `cd worker && npx wrangler deploy`, after setting the
  same env vars as Worker secrets (`npx wrangler secret put ESPN_LEAGUE_ID`,
  etc.) and pointing `wrangler.toml`'s KV namespace `id` at the same
  namespace bound to the Pages project.
