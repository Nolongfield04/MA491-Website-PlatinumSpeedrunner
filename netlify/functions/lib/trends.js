// Opportunity trend: is a player's workload (targets/carries/attempts)
// trending up or down over their last 3 games vs. their season average?
// Reuses defense.js's nflverse CSV fetch/parse (own fetch call, kept
// decoupled rather than sharing rows across modules).

const { fetchSeasonStats } = require("./defense.js");

const ESPN_TO_NFLVERSE = { LAR: "LA", WSH: "WAS" };
function toNflverseAbbr(espnAbbr) {
  return ESPN_TO_NFLVERSE[espnAbbr] || espnAbbr;
}

function lastName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1].toLowerCase();
}

// the workload metric that best signals role for each position
function usageFor(row, position) {
  const carries = parseFloat(row.carries) || 0;
  const targets = parseFloat(row.targets) || 0;
  const attempts = parseFloat(row.attempts) || 0;
  if (position === "QB") return attempts;
  if (position === "RB") return carries + targets;
  if (position === "WR" || position === "TE") return targets;
  return null;
}

async function getOpportunityTrend(rosterPlayers, season) {
  let rows;
  try {
    rows = await fetchSeasonStats(season);
  } catch (e) {
    return {}; // no current-season data yet (e.g. very early in the season)
  }

  const relevant = rosterPlayers.filter((p) => ["QB", "RB", "WR", "TE"].includes(p.position));
  const trends = {};

  for (const player of relevant) {
    const ln = lastName(player.name);
    const team = toNflverseAbbr(player.proTeam);
    const playerRows = rows
      .filter(
        (r) =>
          r.season_type === "REG" &&
          r.position === player.position &&
          r.recent_team === team &&
          lastName(r.player_display_name || "") === ln
      )
      .map((r) => ({ week: parseInt(r.week, 10), usage: usageFor(r, player.position) }))
      .filter((r) => !Number.isNaN(r.week))
      .sort((a, b) => a.week - b.week);

    if (playerRows.length < 2) continue;

    const seasonAvg = average(playerRows.map((r) => r.usage));
    const last3 = playerRows.slice(-3);
    const last3Avg = average(last3.map((r) => r.usage));

    if (seasonAvg <= 0) continue;
    const ratio = last3Avg / seasonAvg;

    let label = "Stable";
    if (ratio >= 1.15) label = "Increasing";
    else if (ratio <= 0.85) label = "Declining";

    trends[player.id] = {
      label,
      seasonAvg: round1(seasonAvg),
      last3Avg: round1(last3Avg),
      gamesLogged: playerRows.length,
      metric: player.position === "QB" ? "pass attempts" : player.position === "RB" ? "touches" : "targets",
    };
  }

  return trends; // { [playerId]: { label, seasonAvg, last3Avg, gamesLogged, metric } }
}

function average(nums) {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

module.exports = { getOpportunityTrend };
