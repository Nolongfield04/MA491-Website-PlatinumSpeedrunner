// Snap share trend — the closest free, honest signal to "emerging player
// before the box score catches up." True route-participation % is a
// PFF-only product with no free equivalent; offensive snap share (nflverse's
// snap_counts dataset) is the real, legitimate substitute used here.

const SNAP_COUNTS_BASE = "https://github.com/nflverse/nflverse-data/releases/download/snap_counts";

const ESPN_TO_NFLVERSE = { LAR: "LA", WSH: "WAS" };
function toNflverseAbbr(espnAbbr) {
  return ESPN_TO_NFLVERSE[espnAbbr] || espnAbbr;
}

function lastName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1].toLowerCase();
}

// same minimal quoted-field CSV parser used in defense.js
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

async function fetchSnapCounts(season) {
  const res = await fetch(`${SNAP_COUNTS_BASE}/snap_counts_${season}.csv`);
  if (!res.ok) {
    const err = new Error(`nflverse snap count data not available for season ${season} (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return parseCsv(await res.text());
}

async function getSnapShareTrend(rosterPlayers, season) {
  let rows;
  try {
    rows = await fetchSnapCounts(season);
  } catch (e) {
    return {};
  }

  const relevant = rosterPlayers.filter((p) => ["QB", "RB", "WR", "TE"].includes(p.position));
  const trends = {};

  for (const player of relevant) {
    const ln = lastName(player.name);
    const team = toNflverseAbbr(player.proTeam);
    const playerRows = rows
      .filter(
        (r) =>
          r.game_type === "REG" &&
          r.position === player.position &&
          r.team === team &&
          lastName(r.player || "") === ln
      )
      .map((r) => ({ week: parseInt(r.week, 10), pct: parseFloat(r.offense_pct) || 0 }))
      .filter((r) => !Number.isNaN(r.week))
      .sort((a, b) => a.week - b.week);

    if (playerRows.length < 2) continue;

    const seasonAvg = average(playerRows.map((r) => r.pct));
    const last3 = playerRows.slice(-3);
    const last3Avg = average(last3.map((r) => r.pct));

    const delta = last3Avg - seasonAvg; // percentage-point swing, not a ratio (pct is often small/noisy)
    let label = "Stable";
    if (delta >= 0.1) label = (player.percentOwned ?? 100) < 50 ? "Emerging" : "Increasing";
    else if (delta <= -0.1) label = "Declining";

    trends[player.id] = {
      label,
      seasonAvgPct: round1(seasonAvg * 100),
      last3AvgPct: round1(last3Avg * 100),
      gamesLogged: playerRows.length,
    };
  }

  return trends;
}

function average(nums) {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
function round1(n) {
  return Math.round(n * 10) / 10;
}

export { getSnapShareTrend };
