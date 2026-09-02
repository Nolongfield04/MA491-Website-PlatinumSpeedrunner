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

// receiving-only PPR component allowed to RBs specifically — "how vulnerable
// is this defense to a pass-catching back," a real signal not captured by
// the standard RB DVP (which blends rushing + receiving together).
function num(v) {
  return parseFloat(v) || 0;
}
function rbReceivingPts(r) {
  return num(r.receptions) * 1 + num(r.receiving_yards) * 0.1 + num(r.receiving_tds) * 6 - num(r.receiving_fumbles_lost) * 2;
}
function computeRbReceivingAverages(rows) {
  const totals = {};
  const games = {};
  for (const r of rows) {
    if (r.season_type !== "REG" || r.position !== "RB") continue;
    const key = `RB_REC|${r.opponent_team}`;
    totals[key] = (totals[key] || 0) + rbReceivingPts(r);
    games[key] = (games[key] || 0) + 1;
  }
  const avg = {};
  for (const key of Object.keys(totals)) avg[key] = totals[key] / games[key];
  return avg;
}

// Strength-of-schedule multiplier per defense: derived entirely from the
// same rows (no new fetch) — for each defense, find the offenses they've
// actually faced this season (wherever opponent_team === that defense, the
// row's recent_team for that week is who they played) and compare those
// offenses' average total skill-position output to the league average.
// A defense that's faced tougher-than-average offenses gets its "allowed"
// numbers discounted slightly (they were playing good offenses), and vice
// versa. Uses full-season opponent strength (not excluding the game against
// this defense itself) — a standard, slightly simplified SOS approach.
function computeSosMultipliers(rows) {
  const offenseTotals = {};
  const offenseGames = {};
  const facedByDefense = {};
  for (const r of rows) {
    if (r.season_type !== "REG" || !RANKED_POSITIONS.includes(r.position)) continue;
    const pts = parseFloat(r.fantasy_points_ppr);
    if (!Number.isNaN(pts)) {
      offenseTotals[r.recent_team] = (offenseTotals[r.recent_team] || 0) + pts;
      offenseGames[r.recent_team] = offenseGames[r.recent_team] || new Set();
      offenseGames[r.recent_team].add(r.week);
    }
    facedByDefense[r.opponent_team] = facedByDefense[r.opponent_team] || new Map();
    facedByDefense[r.opponent_team].set(r.week, r.recent_team);
  }

  const offenseStrength = {};
  for (const team of Object.keys(offenseTotals)) {
    offenseStrength[team] = offenseTotals[team] / offenseGames[team].size;
  }
  const strengthValues = Object.values(offenseStrength);
  if (!strengthValues.length) return {};
  const leagueAvg = strengthValues.reduce((a, b) => a + b, 0) / strengthValues.length;

  const multipliers = {};
  for (const [defenseTeam, weeksMap] of Object.entries(facedByDefense)) {
    const opponentStrengths = [...weeksMap.values()]
      .map((t) => offenseStrength[t])
      .filter((v) => v != null);
    if (!opponentStrengths.length) continue;
    const avgOpponentStrength = opponentStrengths.reduce((a, b) => a + b, 0) / opponentStrengths.length;
    multipliers[defenseTeam] = avgOpponentStrength > 0 ? leagueAvg / avgOpponentStrength : 1;
  }
  return multipliers; // { team: multiplier } — >1 means they've faced weak offenses (discount their allowed numbers), <1 means tough slate
}

// merges the standard per-position averages with the RB-receiving-only
// averages into one key->value map (distinct key prefixes, no collisions),
// so the existing season/recency blending logic below can treat them
// identically without duplicating that logic.
function computeCombinedAverages(rows) {
  return { ...computeAverages(rows), ...computeRbReceivingAverages(rows) };
}

function maxWeek(rows) {
  return rows.reduce(
    (max, r) => (r.season_type === "REG" ? Math.max(max, parseInt(r.week, 10) || 0) : max),
    0
  );
}

// tries progressively older seasons until nflverse actually has data —
// relying on exactly one prior season silently produced empty rankings
// (while still labeling the source as if it succeeded) whenever that one
// season also wasn't published yet.
async function fetchMostRecentAvailableSeason(startSeason, maxLookback = 5) {
  for (let s = startSeason, tries = 0; tries < maxLookback; s--, tries++) {
    try {
      const rows = await fetchSeasonStats(s);
      if (rows.length) return { rows, season: s };
    } catch (e) {
      // try the next season back
    }
  }
  return { rows: [], season: null };
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
    const seasonAvg = computeCombinedAverages(currentRows);
    const recentAvg = computeCombinedAverages(recentRows);
    baseAvg = {};
    const keys = new Set([...Object.keys(seasonAvg), ...Object.keys(recentAvg)]);
    for (const k of keys) {
      const s = seasonAvg[k];
      const r = recentAvg[k];
      baseAvg[k] = r != null && s != null ? 0.4 * s + 0.6 * r : r ?? s;
    }
    source = `${season} weeks 1-${weeksPlayed} (recent-weighted)`;
  } else {
    // not enough current-season data yet — fall back to the most recent
    // season nflverse actually has published (not necessarily season - 1)
    const { rows: priorRows, season: priorSeason } = await fetchMostRecentAvailableSeason(season - 1);

    if (weeksPlayed > 0 && priorRows.length) {
      const curAvg = computeCombinedAverages(currentRows);
      const priorAvg = computeCombinedAverages(priorRows);
      baseAvg = {};
      const keys = new Set([...Object.keys(curAvg), ...Object.keys(priorAvg)]);
      for (const k of keys) {
        const c = curAvg[k];
        const p = priorAvg[k];
        baseAvg[k] = c != null && p != null ? 0.5 * c + 0.5 * p : c ?? p;
      }
      source = `${priorSeason} season blended with ${season} weeks 1-${weeksPlayed}`;
    } else if (weeksPlayed > 0) {
      // current season has some data but no prior season was found at all —
      // use what we have rather than nothing
      baseAvg = computeCombinedAverages(currentRows);
      source = `${season} weeks 1-${weeksPlayed} (no prior-season data found)`;
    } else if (priorRows.length) {
      baseAvg = computeCombinedAverages(priorRows);
      source = `${priorSeason} season (no ${season} data yet)`;
    } else {
      baseAvg = {};
      source = `no nflverse data available for ${season} or recent prior seasons`;
    }
  }

  // SOS multipliers only make sense against this-season opponents actually
  // faced; when we're on the no-current-season-data fallback there's nothing
  // to compute them from, so every defense is left unadjusted (multiplier 1).
  const sosMultipliers = weeksPlayed > 0 ? computeSosMultipliers(currentRows) : {};

  // rank 1 = most fantasy points allowed at that position (most exploitable),
  // rank 32 = fewest allowed (toughest matchup). Also computes an
  // SOS-adjusted rank alongside the raw one.
  const rankings = {};
  for (const pos of [...RANKED_POSITIONS, "RB_REC"]) {
    const entries = Object.entries(baseAvg)
      .filter(([k]) => k.startsWith(`${pos}|`))
      .map(([k, v]) => ({
        team: k.split("|")[1],
        avgAllowed: v,
        sosAdjustedAllowed: v * (sosMultipliers[k.split("|")[1]] ?? 1),
      }))
      .sort((a, b) => b.avgAllowed - a.avgAllowed);
    entries.forEach((e, i) => (e.rank = i + 1));
    [...entries]
      .sort((a, b) => b.sosAdjustedAllowed - a.sosAdjustedAllowed)
      .forEach((e, i) => (e.sosAdjustedRank = i + 1));
    rankings[pos] = entries;
  }

  return { rankings, source, totalTeamsRanked: rankings.QB?.length || 0 };
}

function getDvpRank(rankings, espnProTeamAbbr, position) {
  if (![...RANKED_POSITIONS, "RB_REC"].includes(position)) return null;
  const nflverseAbbr = toNflverseAbbr(espnProTeamAbbr);
  const list = rankings[position] || [];
  const entry = list.find((e) => e.team === nflverseAbbr);
  if (!entry) return null;
  return {
    rank: entry.rank,
    avgAllowed: Math.round(entry.avgAllowed * 10) / 10,
    sosAdjustedRank: entry.sosAdjustedRank,
    outOf: list.length,
  };
}

export { getDefenseRankings, getDvpRank, fetchSeasonStats };
