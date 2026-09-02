// Scheduled Worker (see wrangler.toml) — runs weekly, after Monday Night
// Football, and finalizes the just-completed week's actual-vs-projected
// results into KV so fantasy.html can show trends over time.
//
// This is a standalone Worker, not a Pages Function, because Cloudflare
// Pages Functions don't support Cron Triggers — only Workers do. It shares
// its logic with the Pages Function via relative imports into ../functions/lib.

import { getLeagueRosterAndSettings, getStatsForWeek } from "../functions/lib/espn.js";
import { isWeekComplete } from "../functions/lib/schedule.js";
import { hasWeek, recordWeek } from "../functions/lib/history.js";

function currentSeason() {
  const now = new Date();
  return now.getUTCMonth() >= 2 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

async function run(env) {
  const cfg = {
    season: env.ESPN_SEASON || String(currentSeason()),
    leagueId: env.ESPN_LEAGUE_ID,
    teamId: env.ESPN_TEAM_ID,
    espnS2: env.ESPN_S2,
    swid: env.ESPN_SWID,
  };

  if (["leagueId", "teamId", "espnS2", "swid"].some((k) => !cfg[k])) {
    console.log("snapshot-week: missing ESPN env vars, skipping");
    return;
  }

  try {
    const { week: currentWeek, season, roster } = await getLeagueRosterAndSettings(cfg);
    const targetWeek = currentWeek - 1;

    if (targetWeek < 1) {
      console.log(`snapshot-week: week ${currentWeek} is the first week, nothing to finalize yet`);
      return;
    }

    if (await hasWeek(env.HISTORY_KV, targetWeek)) {
      console.log(`snapshot-week: week ${targetWeek} already recorded, skipping`);
      return;
    }

    const complete = await isWeekComplete(targetWeek, Number(season));
    if (!complete) {
      console.log(`snapshot-week: week ${targetWeek} not fully complete yet, skipping`);
      return;
    }

    const players = roster.map((p) => {
      const { projectedPoints, actualPoints } = getStatsForWeek(p.rawStats, targetWeek);
      return {
        id: p.id,
        name: p.name,
        position: p.position,
        proTeam: p.proTeam,
        projectedPoints,
        actualPoints,
      };
    });

    const wrote = await recordWeek(env.HISTORY_KV, targetWeek, players);
    console.log(
      wrote
        ? `snapshot-week: recorded week ${targetWeek} for ${players.length} players`
        : `snapshot-week: week ${targetWeek} was recorded concurrently, skipped`
    );
  } catch (err) {
    console.error("snapshot-week failed:", err.message);
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },
  // lets `wrangler dev --test-scheduled` (or a stray HTTP request) trigger a
  // manual run without waiting for Tuesday.
  async fetch(request, env) {
    await run(env);
    return new Response("snapshot-week ran\n");
  },
};
