// Scheduled function (see netlify.toml) — runs weekly, after Monday Night
// Football, and finalizes the just-completed week's actual-vs-projected
// results into Netlify Blobs so fantasy.html can show trends over time.

const { connectLambda } = require("@netlify/blobs");
const { getLeagueRosterAndSettings, getStatsForWeek } = require("./lib/espn.js");
const { isWeekComplete } = require("./lib/schedule.js");
const { hasWeek, recordWeek } = require("./lib/history.js");

function currentSeason() {
  const now = new Date();
  return now.getUTCMonth() >= 2 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

exports.handler = async (event) => {
  try {
    connectLambda(event);
  } catch (err) {
    console.error("snapshot-week: connectLambda failed:", err.message);
    return { statusCode: 500 };
  }

  const cfg = {
    season: process.env.ESPN_SEASON || String(currentSeason()),
    leagueId: process.env.ESPN_LEAGUE_ID,
    teamId: process.env.ESPN_TEAM_ID,
    espnS2: process.env.ESPN_S2,
    swid: process.env.ESPN_SWID,
  };

  if (["leagueId", "teamId", "espnS2", "swid"].some((k) => !cfg[k])) {
    console.log("snapshot-week: missing ESPN env vars, skipping");
    return { statusCode: 200 };
  }

  try {
    const { week: currentWeek, season, roster } = await getLeagueRosterAndSettings(cfg);
    const targetWeek = currentWeek - 1;

    if (targetWeek < 1) {
      console.log(`snapshot-week: week ${currentWeek} is the first week, nothing to finalize yet`);
      return { statusCode: 200 };
    }

    if (await hasWeek(targetWeek)) {
      console.log(`snapshot-week: week ${targetWeek} already recorded, skipping`);
      return { statusCode: 200 };
    }

    const complete = await isWeekComplete(targetWeek, Number(season));
    if (!complete) {
      console.log(`snapshot-week: week ${targetWeek} not fully complete yet, skipping`);
      return { statusCode: 200 };
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

    const wrote = await recordWeek(targetWeek, players);
    console.log(
      wrote
        ? `snapshot-week: recorded week ${targetWeek} for ${players.length} players`
        : `snapshot-week: week ${targetWeek} was recorded concurrently, skipped`
    );
    return { statusCode: 200 };
  } catch (err) {
    console.error("snapshot-week failed:", err.message);
    return { statusCode: 500 };
  }
};
