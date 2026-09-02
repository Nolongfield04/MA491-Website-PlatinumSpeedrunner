// Opportunity & efficiency trends, all derived from the same nflverse season
// CSV `defense.js` already fetches for DVP (own fetch here, kept decoupled
// rather than sharing rows across modules):
//   - workload trend (targets/carries/attempts, last 3 games vs. season avg)
//   - target share / air yards share (WR/TE)
//   - expected fantasy points (xFP) vs. actual, as a regression signal

import { fetchSeasonStats } from "./defense.js";

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

const num = (v) => parseFloat(v) || 0;

// standard PPR-scoring component formulas, used only to derive league-average
// points-per-opportunity rates for xFP — the "actual" side of the comparison
// uses the CSV's own authoritative fantasy_points_ppr total, not this formula.
function passPts(r) {
  return num(r.passing_yards) * 0.04 + num(r.passing_tds) * 4 - num(r.interceptions) * 2 + num(r.passing_2pt_conversions) * 2;
}
function rushPts(r) {
  return num(r.rushing_yards) * 0.1 + num(r.rushing_tds) * 6 - num(r.rushing_fumbles_lost) * 2 + num(r.rushing_2pt_conversions) * 2;
}
function recPts(r) {
  return num(r.receptions) * 1 + num(r.receiving_yards) * 0.1 + num(r.receiving_tds) * 6 - num(r.receiving_fumbles_lost) * 2 + num(r.receiving_2pt_conversions) * 2;
}

// league-average points-per-opportunity, split by position, used to convert
// a player's own volume into an expected point total.
function computeLeagueRates(rows) {
  const sums = {
    QB: { attemptPts: 0, attempts: 0, carryPts: 0, carries: 0 },
    RB: { carryPts: 0, carries: 0, targetPts: 0, targets: 0 },
    WR: { targetPts: 0, targets: 0 },
    TE: { targetPts: 0, targets: 0 },
  };
  for (const r of rows) {
    if (r.season_type !== "REG") continue;
    const pos = r.position;
    if (pos === "QB") {
      sums.QB.attemptPts += passPts(r);
      sums.QB.attempts += num(r.attempts);
      sums.QB.carryPts += rushPts(r);
      sums.QB.carries += num(r.carries);
    } else if (pos === "RB") {
      sums.RB.carryPts += rushPts(r);
      sums.RB.carries += num(r.carries);
      sums.RB.targetPts += recPts(r);
      sums.RB.targets += num(r.targets);
    } else if (pos === "WR") {
      sums.WR.targetPts += recPts(r);
      sums.WR.targets += num(r.targets);
    } else if (pos === "TE") {
      sums.TE.targetPts += recPts(r);
      sums.TE.targets += num(r.targets);
    }
  }
  const safeDiv = (a, b) => (b > 0 ? a / b : 0);
  return {
    QB: { rateAttempt: safeDiv(sums.QB.attemptPts, sums.QB.attempts), rateCarry: safeDiv(sums.QB.carryPts, sums.QB.carries) },
    RB: { rateCarry: safeDiv(sums.RB.carryPts, sums.RB.carries), rateTarget: safeDiv(sums.RB.targetPts, sums.RB.targets) },
    WR: { rateTarget: safeDiv(sums.WR.targetPts, sums.WR.targets) },
    TE: { rateTarget: safeDiv(sums.TE.targetPts, sums.TE.targets) },
  };
}

function expectedPoints(position, totals, rates) {
  if (position === "QB") return totals.attempts * rates.QB.rateAttempt + totals.carries * rates.QB.rateCarry;
  if (position === "RB") return totals.carries * rates.RB.rateCarry + totals.targets * rates.RB.rateTarget;
  if (position === "WR") return totals.targets * rates.WR.rateTarget;
  if (position === "TE") return totals.targets * rates.TE.rateTarget;
  return null;
}

async function getOpportunityTrend(rosterPlayers, season) {
  let rows;
  try {
    rows = await fetchSeasonStats(season);
  } catch (e) {
    return {}; // no current-season data yet (e.g. very early in the season)
  }

  const rates = computeLeagueRates(rows);
  const relevant = rosterPlayers.filter((p) => ["QB", "RB", "WR", "TE"].includes(p.position));
  const trends = {};

  for (const player of relevant) {
    const ln = lastName(player.name);
    const team = toNflverseAbbr(player.proTeam);
    const playerRows = rows.filter(
      (r) =>
        r.season_type === "REG" &&
        r.position === player.position &&
        r.recent_team === team &&
        lastName(r.player_display_name || "") === ln
    );
    const weeklyUsage = playerRows
      .map((r) => ({ week: parseInt(r.week, 10), usage: usageFor(r, player.position) }))
      .filter((r) => !Number.isNaN(r.week))
      .sort((a, b) => a.week - b.week);

    if (weeklyUsage.length < 2) continue;

    const seasonAvg = average(weeklyUsage.map((r) => r.usage));
    const last3 = weeklyUsage.slice(-3);
    const last3Avg = average(last3.map((r) => r.usage));

    if (seasonAvg <= 0) continue;
    const ratio = last3Avg / seasonAvg;
    let label = "Stable";
    if (ratio >= 1.15) label = "Increasing";
    else if (ratio <= 0.85) label = "Declining";

    const entry = {
      label,
      seasonAvg: round1(seasonAvg),
      last3Avg: round1(last3Avg),
      gamesLogged: weeklyUsage.length,
      metric: player.position === "QB" ? "pass attempts" : player.position === "RB" ? "touches" : "targets",
    };

    // xFP: compare season-total actual PPR points to volume-implied expected points
    const totals = {
      attempts: sum(playerRows.map((r) => num(r.attempts))),
      carries: sum(playerRows.map((r) => num(r.carries))),
      targets: sum(playerRows.map((r) => num(r.targets))),
    };
    const actualFP = sum(playerRows.map((r) => num(r.fantasy_points_ppr)));
    const expectedFP = expectedPoints(player.position, totals, rates);
    if (expectedFP != null && expectedFP > 0) {
      const diff = actualFP - expectedFP;
      const diffPct = diff / expectedFP;
      let verdict = "On pace with volume";
      if (diffPct >= 0.15) verdict = "Overperforming — regression risk";
      else if (diffPct <= -0.15) verdict = "Underperforming — buy-low candidate";
      entry.xfp = { actualFP: round1(actualFP), expectedFP: round1(expectedFP), diff: round1(diff), verdict };
    }

    // target share / air yards share — WR/TE only, straight from the CSV
    if (player.position === "WR" || player.position === "TE") {
      const targetShares = playerRows.map((r) => num(r.target_share)).filter((v) => v > 0);
      const airYardsShares = playerRows.map((r) => num(r.air_yards_share)).filter((v) => v > 0);
      if (targetShares.length) {
        entry.targetShare = round1(average(targetShares) * 100);
        entry.airYardsShare = airYardsShares.length ? round1(average(airYardsShares) * 100) : null;
      }
    }

    trends[player.id] = entry;
  }

  return trends;
}

function sum(nums) {
  return nums.reduce((a, b) => a + b, 0);
}
function average(nums) {
  return sum(nums) / nums.length;
}
function round1(n) {
  return Math.round(n * 10) / 10;
}

export { getOpportunityTrend };
