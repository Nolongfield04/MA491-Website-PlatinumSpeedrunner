const { connectLambda } = require("@netlify/blobs");
const { getLeagueRosterAndSettings, getFreeAgents } = require("./lib/espn.js");
const { getWeekOpponents } = require("./lib/schedule.js");
const { getDefenseRankings } = require("./lib/defense.js");
const { getUnitHealth } = require("./lib/injuries.js");
const { getPlayerNews } = require("./lib/news.js");
const { getAllWeeks } = require("./lib/history.js");
const { getOpportunityTrend } = require("./lib/trends.js");
const { getSnapShareTrend } = require("./lib/snapshare.js");
const { getWeatherForTeams } = require("./lib/weather.js");
const { buildAnalysis } = require("./lib/lineup.js");

// News/injuries/history are enrichments layered on top of the core roster +
// lineup logic — if any of them hiccup, the page should still work with
// whatever it has rather than failing the whole request.
async function bestEffort(promise, fallback, label) {
  try {
    return await promise;
  } catch (err) {
    console.error(`optimize: ${label} failed, continuing without it:`, err.message);
    return fallback;
  }
}

function currentSeason() {
  const now = new Date();
  // NFL season year is the year it kicks off in (Sept); Jan-Feb belong to
  // the season that started the previous fall.
  return now.getUTCMonth() >= 2 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

exports.handler = async (event) => {
  try {
    connectLambda(event);
  } catch (err) {
    console.error("optimize: connectLambda failed, history will be unavailable:", err.message);
  }

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
    const { week, season, roster, rosterSlots, teamName, opponent } = await getLeagueRosterAndSettings(cfg);
    const [freeAgents, opponents, defense, unitHealth, news, weeksHistory, opportunityTrends] = await Promise.all([
      getFreeAgents(cfg, week),
      getWeekOpponents(week, season),
      getDefenseRankings(Number(season)),
      bestEffort(getUnitHealth(), {}, "unit injury health"),
      bestEffort(getPlayerNews(roster), [], "player news"),
      bestEffort(getAllWeeks(), [], "weekly history"),
      bestEffort(getOpportunityTrend(roster, Number(season)), {}, "opportunity trend"),
    ]);

    // weather depends on `opponents` already being resolved (need kickoff
    // times + who's playing whom), so it's a second wave rather than folded
    // into the batch above.
    const teamsInPlay = [...new Set(roster.map((p) => p.proTeam))].flatMap((t) => [t, opponents[t]?.opponent]).filter(Boolean);
    const [snapShareTrends, weather] = await Promise.all([
      bestEffort(getSnapShareTrend(roster, Number(season)), {}, "snap share trend"),
      bestEffort(getWeatherForTeams(teamsInPlay, opponents), {}, "weather"),
    ]);

    const analysis = buildAnalysis({
      roster,
      freeAgents,
      rosterSlots,
      opponents,
      rankings: defense.rankings,
      week,
      defenseSource: defense.source,
      unitHealth,
      weeksHistory,
      news,
      opponent,
      opportunityTrends,
      snapShareTrends,
      weather,
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
