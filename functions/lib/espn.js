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

// stats entries aren't tagged to "current week" — each player carries one
// entry per scoring period, so a week must always be specified explicitly
// or .find() can silently return an arbitrary (often wrong) week's numbers.
function getStatsForWeek(rawStats, week) {
  const stats = rawStats || [];
  const projected = stats.find(
    (s) => s.scoringPeriodId === week && s.statSourceId === 1 && s.statSplitTypeId === 1
  );
  const actual = stats.find(
    (s) => s.scoringPeriodId === week && s.statSourceId === 0 && s.statSplitTypeId === 1
  );
  return {
    projectedPoints: projected ? round1(projected.appliedTotal) : null,
    actualPoints: actual ? round1(actual.appliedTotal) : null,
  };
}

function normalizePlayer(entry, week) {
  const p = entry.player || entry.playerPoolEntry?.player;
  const appliedStatTotal =
    entry.playerPoolEntry?.appliedStatTotal ?? entry.appliedStatTotal ?? null;
  const { projectedPoints, actualPoints } = getStatsForWeek(p.stats, week);
  return {
    id: p.id,
    name: p.fullName,
    position: positionName(p.defaultPositionId),
    eligibleSlots: p.eligibleSlots || [],
    proTeam: proTeamAbbr(p.proTeamId),
    injuryStatus: INJURY_STATUS_MAP[p.injuryStatus] || p.injuryStatus || "Active",
    projectedPoints: projectedPoints ?? (appliedStatTotal ? round1(appliedStatTotal) : null),
    actualPoints,
    percentOwned: p.ownership ? round1(p.ownership.percentOwned) : null,
    percentStarted: p.ownership ? round1(p.ownership.percentStarted) : null,
    lineupSlotId: entry.lineupSlotId,
    rawStats: p.stats || [],
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// Returns null when there's no opponent this week — either no schedule entry
// yet, or (a real case, seen live with an 11-team league) a bye built into
// the fantasy schedule itself, distinct from an NFL bye week.
function getWeekMatchup(data, myTeamId, week) {
  const matchup = (data.schedule || []).find(
    (m) => m.matchupPeriodId === week && (m.home?.teamId === myTeamId || m.away?.teamId === myTeamId)
  );
  if (!matchup) return null;
  const oppSide = matchup.home?.teamId === myTeamId ? matchup.away : matchup.home;
  if (!oppSide) return null;
  const oppTeam = (data.teams || []).find((t) => t.id === oppSide.teamId);
  if (!oppTeam) return null;
  return {
    teamId: oppTeam.id,
    teamName: oppTeam.name,
    roster: (oppTeam.roster?.entries || []).map((entry) => normalizePlayer(entry, week)),
  };
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

  const roster = (team.roster?.entries || []).map((entry) => normalizePlayer(entry, week));

  const rosterSlots = [];
  const lineupSlotCounts = data.settings?.rosterSettings?.lineupSlotCounts || {};
  for (const [slotId, count] of Object.entries(lineupSlotCounts)) {
    const id = Number(slotId);
    if (count > 0 && id !== 20 && id !== 21) {
      rosterSlots.push({ slotId: id, name: SLOT_ID_MAP[id] || `SLOT_${id}`, count });
    }
  }

  const opponent = getWeekMatchup(data, team.id, week);

  // Every other team's roster, straight from the same `data.teams` payload
  // already fetched above — no second request needed. Feeds the trade
  // analyzer (lib/tradeanalyzer.js).
  const otherTeams = (data.teams || [])
    .filter((t) => t.id !== team.id)
    .map((t) => ({
      teamId: t.id,
      teamName: t.name,
      roster: (t.roster?.entries || []).map((entry) => normalizePlayer(entry, week)),
    }));

  return { week, season: cfg.season, roster, rosterSlots, teamName: team.name, opponent, otherTeams };
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
  return (data.players || []).map((entry) => normalizePlayer(entry, week));
}

export {
  getLeagueRosterAndSettings,
  getFreeAgents,
  positionName,
  proTeamAbbr,
  getStatsForWeek,
  getWeekMatchup,
};
