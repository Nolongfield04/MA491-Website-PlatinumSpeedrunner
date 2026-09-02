// League-wide injury report → per-team unit health scores (O-line, D-line,
// secondary). Uses ESPN's public (no-auth) injuries feed, which — unlike the
// fantasy player pool — includes non-fantasy positions like OT/G/C, so it's
// the only free source for offensive/defensive line health.

const OL_POSITIONS = new Set(["OT", "T", "G", "C", "OL"]);
const DL_POSITIONS = new Set(["DE", "DT", "NT", "DL"]);
const SECONDARY_POSITIONS = new Set(["CB", "S", "SS", "FS", "DB"]);

const SEVERITY_WEIGHT = {
  Out: 1.0,
  "Injured Reserve": 1.0,
  IR: 1.0,
  Doubtful: 0.65,
  Questionable: 0.3,
};

// approximate starters-worth of players per unit, used to normalize the
// raw severity sum into a 0-1 "how degraded is this unit" score
const UNIT_SIZE = { OL: 5, DL: 4, secondary: 4 };

function unitFor(positionAbbr) {
  if (OL_POSITIONS.has(positionAbbr)) return "OL";
  if (DL_POSITIONS.has(positionAbbr)) return "DL";
  if (SECONDARY_POSITIONS.has(positionAbbr)) return "secondary";
  return null;
}

async function getUnitHealth() {
  const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`ESPN injuries request failed (${res.status})`);
  }
  const data = await res.json();

  const health = {};
  for (const teamEntry of data.injuries || []) {
    const abbr = teamAbbrFromDisplayName(teamEntry);
    if (!abbr) continue;
    const sums = { OL: 0, DL: 0, secondary: 0 };
    for (const injury of teamEntry.injuries || []) {
      const posAbbr = injury.athlete?.position?.abbreviation;
      const unit = unitFor(posAbbr);
      if (!unit) continue;
      const weight = SEVERITY_WEIGHT[injury.status] || 0;
      sums[unit] += weight;
    }
    health[abbr] = {
      OL: Math.min(1, round2(sums.OL / UNIT_SIZE.OL)),
      DL: Math.min(1, round2(sums.DL / UNIT_SIZE.DL)),
      secondary: Math.min(1, round2(sums.secondary / UNIT_SIZE.secondary)),
    };
  }
  return health; // { [teamAbbr]: { OL, DL, secondary } }, each 0 (healthy) - 1 (gutted)
}

// ESPN's injuries feed doesn't include a team abbreviation directly on each
// group — derive it from the athlete links' team slug instead, since that's
// present and stable.
function teamAbbrFromDisplayName(teamEntry) {
  const href = teamEntry.injuries?.[0]?.athlete?.links?.[0]?.href || "";
  // no reliable abbreviation in the injuries payload itself; fall back to
  // matching on the well-known display name substrings.
  const DISPLAY_NAME_TO_ABBR = {
    "arizona cardinals": "ARI", "atlanta falcons": "ATL", "baltimore ravens": "BAL",
    "buffalo bills": "BUF", "carolina panthers": "CAR", "chicago bears": "CHI",
    "cincinnati bengals": "CIN", "cleveland browns": "CLE", "dallas cowboys": "DAL",
    "denver broncos": "DEN", "detroit lions": "DET", "green bay packers": "GB",
    "houston texans": "HOU", "indianapolis colts": "IND", "jacksonville jaguars": "JAX",
    "kansas city chiefs": "KC", "las vegas raiders": "LV", "los angeles chargers": "LAC",
    "los angeles rams": "LAR", "miami dolphins": "MIA", "minnesota vikings": "MIN",
    "new england patriots": "NE", "new orleans saints": "NO", "new york giants": "NYG",
    "new york jets": "NYJ", "philadelphia eagles": "PHI", "pittsburgh steelers": "PIT",
    "san francisco 49ers": "SF", "seattle seahawks": "SEA", "tampa bay buccaneers": "TB",
    "tennessee titans": "TEN", "washington commanders": "WSH",
  };
  const name = (teamEntry.displayName || "").toLowerCase();
  for (const [full, abbr] of Object.entries(DISPLAY_NAME_TO_ABBR)) {
    if (name === full) return abbr;
  }
  void href; // reserved for a future, more robust lookup if needed
  return null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

export { getUnitHealth };
