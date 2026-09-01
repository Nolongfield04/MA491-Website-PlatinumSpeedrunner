const { getLeagueRosterAndSettings, getFreeAgents } = require("./lib/espn.js");
const { getWeekOpponents } = require("./lib/schedule.js");
const { getDefenseRankings } = require("./lib/defense.js");
const { buildAnalysis } = require("./lib/lineup.js");

function currentSeason() {
  const now = new Date();
  // NFL season year is the year it kicks off in (Sept); Jan-Feb belong to
  // the season that started the previous fall.
  return now.getUTCMonth() >= 2 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

exports.handler = async () => {
  const cfg = {
    season: process.env.ESPN_SEASON || String(currentSeason()),
    leagueId: process.env.ESPN_LEAGUE_ID,
    teamId: process.env.ESPN_TEAM_ID,
    espnS2: process.env.ESPN_S2,
    swid: process.env.ESPN_SWID,
  };

  const missing = ["leagueId", "teamId", "espnS2", "swid"].filter((k) => !cfg[k]);
  if (missing.length) {
    return jsonResponse(500, {
      error: `Missing required environment variable(s): ${missing
        .map((k) => envVarName(k))
        .join(", ")}. Set these in the Netlify site's environment variables.`,
    });
  }

  try {
    const { week, season, roster, rosterSlots, teamName } = await getLeagueRosterAndSettings(cfg);
    const [freeAgents, opponents, defense] = await Promise.all([
      getFreeAgents(cfg, week),
      getWeekOpponents(week, season),
      getDefenseRankings(Number(season)),
    ]);

    const analysis = buildAnalysis({
      roster,
      freeAgents,
      rosterSlots,
      opponents,
      rankings: defense.rankings,
      week,
      defenseSource: defense.source,
    });

    return jsonResponse(200, { teamName, ...analysis, generatedAt: new Date().toISOString() });
  } catch (err) {
    return jsonResponse(err.status === 401 || err.status === 403 ? 401 : 500, {
      error: err.message || "Unexpected error building fantasy analysis.",
    });
  }
};

function envVarName(key) {
  return {
    leagueId: "ESPN_LEAGUE_ID",
    teamId: "ESPN_TEAM_ID",
    espnS2: "ESPN_S2",
    swid: "ESPN_SWID",
  }[key];
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}
