// Defense-vs-position (DVP) rankings, computed from nflverse's public
// play-by-play-derived weekly player stats (github.com/nflverse/nflverse-data).
// Real historical performance data — this is what makes the matchup
// adjustment meaningful, since ESPN itself doesn't expose this.

const NFLVERSE_BASE =
  "https://github.com/nflverse/nflverse-data/releases/download/player_stats";

// nflverse uses a couple of abbreviations that differ from ESPN's.
const ESPN_TO_NFLVERSE = { LAR: "LA", WSH: "WAS" };
const RANKED_POSITIONS = ["QB", "RB", "WR", "TE"];

function toNflverseAbbr(espnAbbr) {
  return ESPN_TO_NFLVERSE[espnAbbr] || espnAbbr;
}

// Minimal CSV parser that handles quoted fields (nflverse's headshot_url
// column contains commas inside quotes).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, i) => (obj[h] = r[i]));
    return obj;
  });
}

async function fetchSeasonStats(season) {
  const res = await fetch(`${NFLVERSE_BASE}/player_stats_${season}.csv`);
  if (!res.ok) {
    const err = new Error(`nflverse data not available for season ${season} (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return parseCsv(text);
}

// avgAllowed[position][team] = average PPR fantasy points allowed per game
function computeAverages(rows) {
  const totals = {};
  const games = {};
  for (const r of rows) {
    if (r.season_type !== "REG") continue;
    if (!RANKED_POSITIONS.includes(r.position)) continue;
    const pts = parseFloat(r.fantasy_points_ppr);
    if (Number.isNaN(pts)) continue;
    const key = `${r.position}|${r.opponent_team}`;
    totals[key] = (totals[key] || 0) + pts;
    games[key] = (games[key] || 0) + 1;
  }
  const avg = {};
  for (const key of Object.keys(totals)) {
    avg[key] = totals[key] / games[key];
  }
  return avg;
}

function maxWeek(rows) {
  return rows.reduce((max, r) => Math.max(max, parseInt(r.week, 10) || 0), 0);
}

async function getDefenseRankings(season) {
  let currentRows = [];
  let source = `${season} season-to-date`;
  try {
    currentRows = await fetchSeasonStats(season);
  } catch (e) {
    currentRows = [];
  }

  const weeksPlayed = maxWeek(currentRows);

  let baseAvg;
  if (weeksPlayed >= 4) {
    // enough current-season data: blend full season-to-date with a
    // recency-weighted last-4-weeks window
    const recentRows = currentRows.filter(
      (r) => parseInt(r.week, 10) > weeksPlayed - 4
    );
    const seasonAvg = computeAverages(currentRows);
    const recentAvg = computeAverages(recentRows);
    baseAvg = {};
    const keys = new Set([...Object.keys(seasonAvg), ...Object.keys(recentAvg)]);
    for (const k of keys) {
      const s = seasonAvg[k];
      const r = recentAvg[k];
      baseAvg[k] = r != null && s != null ? 0.4 * s + 0.6 * r : r ?? s;
    }
    source = `${season} weeks 1-${weeksPlayed} (recent-weighted)`;
  } else {
    // not enough current-season data yet — fall back to last season in full
    let priorRows = [];
    try {
      priorRows = await fetchSeasonStats(season - 1);
    } catch (e) {
      priorRows = [];
    }
    if (weeksPlayed > 0) {
      const curAvg = computeAverages(currentRows);
      const priorAvg = computeAverages(priorRows);
      baseAvg = {};
      const keys = new Set([...Object.keys(curAvg), ...Object.keys(priorAvg)]);
      for (const k of keys) {
        const c = curAvg[k];
        const p = priorAvg[k];
        baseAvg[k] = c != null && p != null ? 0.5 * c + 0.5 * p : c ?? p;
      }
      source = `${season - 1} season blended with ${season} weeks 1-${weeksPlayed}`;
    } else {
      baseAvg = computeAverages(priorRows);
      source = `${season - 1} season (no ${season} data yet)`;
    }
  }

  // rank 1 = most fantasy points allowed at that position (most exploitable),
  // rank 32 = fewest allowed (toughest matchup)
  const rankings = {};
  for (const pos of RANKED_POSITIONS) {
    const entries = Object.entries(baseAvg)
      .filter(([k]) => k.startsWith(`${pos}|`))
      .map(([k, v]) => ({ team: k.split("|")[1], avgAllowed: v }))
      .sort((a, b) => b.avgAllowed - a.avgAllowed);
    entries.forEach((e, i) => (e.rank = i + 1));
    rankings[pos] = entries;
  }

  return { rankings, source, totalTeamsRanked: rankings.QB?.length || 0 };
}

function getDvpRank(rankings, espnProTeamAbbr, position) {
  if (!RANKED_POSITIONS.includes(position)) return null;
  const nflverseAbbr = toNflverseAbbr(espnProTeamAbbr);
  const list = rankings[position] || [];
  const entry = list.find((e) => e.team === nflverseAbbr);
  if (!entry) return null;
  return { rank: entry.rank, avgAllowed: Math.round(entry.avgAllowed * 10) / 10, outOf: list.length };
}

module.exports = { getDefenseRankings, getDvpRank, fetchSeasonStats };
