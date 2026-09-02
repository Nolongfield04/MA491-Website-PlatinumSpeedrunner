import { getLeagueRosterAndSettings, getFreeAgents } from "./lib/espn.js";
import { getWeekOpponents } from "./lib/schedule.js";
import { getDefenseRankings } from "./lib/defense.js";
import { getUnitHealth } from "./lib/injuries.js";
import { getPlayerNews } from "./lib/news.js";
import { getAllWeeks } from "./lib/history.js";
import { getOpportunityTrend } from "./lib/trends.js";
import { getSnapShareTrend } from "./lib/snapshare.js";
import { getWeatherForTeams } from "./lib/weather.js";
import { buildAnalysis } from "./lib/lineup.js";
import { buildTradeAnalysis } from "./lib/tradeanalyzer.js";

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

export async function onRequestGet({ env }) {
  const cfg = {
    season: env.ESPN_SEASON || String(currentSeason()),
    leagueId: env.ESPN_LEAGUE_ID,
    teamId: env.ESPN_TEAM_ID,
    espnS2: env.ESPN_S2,
    swid: env.ESPN_SWID,
  };

  const missing = ["leagueId", "teamId", "espnS2", "swid"].filter((k) => !cfg[k]);
  if (missing.length) {
    return jsonResponse(500, {
      error: `Missing required environment variable(s): ${missing
        .map((k) => envVarName(k))
        .join(", ")}. Set these in the Cloudflare Pages project's environment variables.`,
    });
  }

  try {
    const { week, season, roster, rosterSlots, teamName, opponent, otherTeams } = await getLeagueRosterAndSettings(cfg);
    const [freeAgents, opponents, defense, unitHealth, news, weeksHistory, opportunityTrends] = await Promise.all([
      getFreeAgents(cfg, week),
      getWeekOpponents(week, season),
      getDefenseRankings(Number(season)),
      bestEffort(getUnitHealth(), {}, "unit injury health"),
      bestEffort(getPlayerNews(roster), [], "player news"),
      bestEffort(getAllWeeks(env.HISTORY_KV), [], "weekly history"),
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

    // Enrichment, not core — if the trade sweep throws, the rest of the page
    // should still render.
    let tradeAnalyzer;
    try {
      tradeAnalyzer = buildTradeAnalysis({
        roster,
        otherTeams,
        rosterSlots,
        opponents,
        rankings: defense.rankings,
        unitHealth,
        weeksHistory,
      });
    } catch (err) {
      console.error("optimize: trade analyzer failed, continuing without it:", err.message);
      tradeAnalyzer = { topTrades: [], allTrades: [] };
    }

    return jsonResponse(200, { teamName, ...analysis, tradeAnalyzer, generatedAt: new Date().toISOString() });
  } catch (err) {
    return jsonResponse(err.status === 401 || err.status === 403 ? 401 : 500, {
      error: err.message || "Unexpected error building fantasy analysis.",
    });
  }
}

function envVarName(key) {
  return {
    leagueId: "ESPN_LEAGUE_ID",
    teamId: "ESPN_TEAM_ID",
    espnS2: "ESPN_S2",
    swid: "ESPN_SWID",
  }[key];
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
