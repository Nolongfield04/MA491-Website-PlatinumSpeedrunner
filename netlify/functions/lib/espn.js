// ESPN Fantasy Football private API client.
// Auth: espn_s2 + SWID cookies from the league owner's browser session.

const POSITION_MAP = {
  0: "QB", 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K",
  16: "DST", 17: "K", 20: "BENCH", 21: "IR", 23: "FLEX",
};

const SLOT_ID_MAP = {
  0: "QB", 2: "RB", 3: "RB/WR", 4: "WR", 6: "TE", 7: "OP",
  16: "DST", 17: "K", 20: "BE", 21: "IR", 23: "FLEX",
  24: "WR/TE", 25: "RB/WR/TE",
};

const INJURY_STATUS_MAP = {
  ACTIVE: "Active",
  QUESTIONABLE: "Questionable",
  DOUBTFUL: "Doubtful",
  OUT: "Out",
  INJURY_RESERVE: "IR",
  SUSPENSION: "Suspended",
};

const PRO_TEAM_ABBR = {
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET",
  9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN",
  17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC",
  25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
  0: "FA",
};

function positionName(defaultPositionId) {
  return POSITION_MAP[defaultPositionId] || "FLEX";
}

function proTeamAbbr(proTeamId) {
  return PRO_TEAM_ABBR[proTeamId] || "FA";
}

async function espnFetch(path, { season, leagueId, espnS2, swid }, extraHeaders = {}) {
  // fantasy.espn.com/apis/v3/... now unconditionally 302-redirects (ESPN moved
  // the actual read API to this dedicated subdomain).
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}${path}`;
  const res = await fetch(url, {
    headers: {
      Cookie: `espn_s2=${espnS2}; SWID=${swid}`,
      Accept: "application/json",
      ...extraHeaders,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(
      `ESPN API request failed (${res.status}). Cookies may have expired — refresh espn_s2/SWID from a logged-in browser session. ${body.slice(0, 200)}`
    );
    err.status = res.status;
    throw err;
  }
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    // Invalid/expired espn_s2+SWID cookies don't get a clean 401 from ESPN —
    // instead the request gets redirected to a generic HTML login/landing page.
    const err = new Error(
      "ESPN did not return JSON (likely an expired or invalid espn_s2/SWID cookie, or a wrong league/team ID). Refresh the cookies from a logged-in browser session and re-set ESPN_S2/ESPN_SWID."
    );
    err.status = 401;
    throw err;
  }
  return res.json();
}

function normalizePlayer(entry) {
  const p = entry.player || entry.playerPoolEntry?.player;
  const appliedStatTotal =
    entry.playerPoolEntry?.appliedStatTotal ?? entry.appliedStatTotal ?? null;
  const projected = (p.stats || []).find(
    (s) => s.statSourceId === 1 && s.statSplitTypeId === 1
  );
  const actual = (p.stats || []).find(
    (s) => s.statSourceId === 0 && s.statSplitTypeId === 1
  );
  return {
    id: p.id,
    name: p.fullName,
    position: positionName(p.defaultPositionId),
    eligibleSlots: p.eligibleSlots || [],
    proTeam: proTeamAbbr(p.proTeamId),
    injuryStatus: INJURY_STATUS_MAP[p.injuryStatus] || p.injuryStatus || "Active",
    projectedPoints: projected ? round1(projected.appliedTotal) : appliedStatTotal ? round1(appliedStatTotal) : null,
    actualPoints: actual ? round1(actual.appliedTotal) : null,
    percentOwned: p.ownership ? round1(p.ownership.percentOwned) : null,
    lineupSlotId: entry.lineupSlotId,
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

async function getLeagueRosterAndSettings(cfg) {
  const data = await espnFetch(
    `?view=mRoster&view=mTeam&view=mSettings&view=mMatchup&view=mMatchupScore`,
    cfg
  );

  const week = data.scoringPeriodId;
  const team = (data.teams || []).find((t) => String(t.id) === String(cfg.teamId));
  if (!team) {
    throw new Error(`Team ${cfg.teamId} not found in league ${cfg.leagueId}`);
  }

  const roster = (team.roster?.entries || []).map(normalizePlayer);

  const rosterSlots = [];
  const lineupSlotCounts = data.settings?.rosterSettings?.lineupSlotCounts || {};
  for (const [slotId, count] of Object.entries(lineupSlotCounts)) {
    const id = Number(slotId);
    if (count > 0 && id !== 20 && id !== 21) {
      rosterSlots.push({ slotId: id, name: SLOT_ID_MAP[id] || `SLOT_${id}`, count });
    }
  }

  return { week, season: cfg.season, roster, rosterSlots, teamName: team.name };
}

async function getFreeAgents(cfg, week) {
  const filter = {
    players: {
      filterStatus: { value: ["FREEAGENT", "WAIVERS"] },
      sortPercOwned: { sortPriority: 1, sortAsc: false },
      limit: 150,
    },
  };
  const data = await espnFetch(`?view=kona_player_info&scoringPeriodId=${week}`, cfg, {
    "X-Fantasy-Filter": JSON.stringify(filter),
  });
  return (data.players || []).map(normalizePlayer);
}

module.exports = { getLeagueRosterAndSettings, getFreeAgents, positionName, proTeamAbbr };
