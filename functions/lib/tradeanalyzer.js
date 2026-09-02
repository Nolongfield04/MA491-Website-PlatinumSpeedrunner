// Recommended trades: ranks every tradeable-position player rostered by the
// rest of the league (pooled together, not grouped by team) against each of
// my own tradeable players, using the same scoring pipeline (matchup/Vegas/
// injury-adjusted weekly projection) that drives the lineup optimizer
// elsewhere on this page — a snapshot signal for the current week, not a
// season-long dynasty trade value.
//
// The ranking signal isn't raw player value, though — it's my own
// optimal-lineup delta after the swap. That's what keeps a WR3-for-WR3 trade
// between two already-deep receiving corps from outranking a trade that
// actually plugs a starting hole. Doesn't consider which team a target
// belongs to, or whether they'd realistically accept — this is a target
// list, not a proposal to a specific owner (yet).

import { scorePlayer, buildOptimalLineup } from "./lineup.js";

const TRADEABLE_POSITIONS = ["QB", "RB", "WR", "TE"];
const TOP_TRADES_RETURNED = 3;

function round1(n) {
  return Math.round(n * 10) / 10;
}

function lineupTotal(scoredRoster, rosterSlots) {
  const { lineup } = buildOptimalLineup(scoredRoster, rosterSlots);
  return round1(lineup.reduce((sum, l) => sum + (l.player ? l.player.adjustedProjection : 0), 0));
}

function summarizeForTrade(p) {
  return {
    name: p.name,
    position: p.position,
    proTeam: p.proTeam,
    opponent: p.opponent,
    adjustedProjection: p.adjustedProjection,
    projectedPoints: p.projectedPoints,
    matchupNote: p.matchupNote,
    injuryFlag: p.injuryFlag,
    confidence: p.confidence,
  };
}

function buildReason(give, get, myDelta) {
  const upgradeNote = get.matchupNote ? `, ${get.matchupNote}` : "";
  return `${get.name} projects a +${myDelta} pt lineup gain over ${give.name}${upgradeNote}.`;
}

function buildTradeAnalysis({ roster, otherTeams, rosterSlots, opponents, rankings, unitHealth, weeksHistory }) {
  const myScored = roster.map((p) => scorePlayer(p, opponents, rankings, unitHealth, weeksHistory));
  const myBaseline = lineupTotal(myScored, rosterSlots);
  const myCandidates = myScored.filter((p) => TRADEABLE_POSITIONS.includes(p.position));

  // Every tradeable player rostered by every other team, pooled together —
  // we're building a target list from the whole league, not a per-team offer.
  const leaguePool = (otherTeams || [])
    .flatMap((team) => team.roster)
    .map((p) => scorePlayer(p, opponents, rankings, unitHealth, weeksHistory))
    .filter((p) => TRADEABLE_POSITIONS.includes(p.position));

  // Best (give, get) pairing per target player, keyed by the target's id, so
  // the same incoming player can't crowd the top 3 out with duplicates.
  const bestByTarget = new Map();
  for (const give of myCandidates) {
    const myRosterWithoutGive = myScored.filter((p) => p.id !== give.id);
    for (const get of leaguePool) {
      if (get.position !== give.position) continue;

      const myDelta = round1(lineupTotal([...myRosterWithoutGive, get], rosterSlots) - myBaseline);
      if (myDelta <= 0) continue; // only surface trades that are actual upgrades for me

      const existing = bestByTarget.get(get.id);
      if (!existing || myDelta > existing.myLineupDelta) {
        bestByTarget.set(get.id, {
          give: summarizeForTrade(give),
          receive: summarizeForTrade(get),
          myLineupDelta: myDelta,
          reason: buildReason(give, get, myDelta),
        });
      }
    }
  }

  const topTrades = [...bestByTarget.values()]
    .sort((a, b) => b.myLineupDelta - a.myLineupDelta)
    .slice(0, TOP_TRADES_RETURNED);

  return { topTrades };
}

export { buildTradeAnalysis };
