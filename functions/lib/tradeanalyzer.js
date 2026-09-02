// Trade analyzer: same-position, 1-for-1 trades against every other team in
// the league. Reuses the exact scoring pipeline (matchup/Vegas/injury-adjusted
// weekly projection) that drives the lineup optimizer elsewhere on this page
// — so, like the waiver suggestions, this is a snapshot signal for the
// current week, not a season-long dynasty trade value.
//
// The ranking signal isn't raw player value, though — it's each side's actual
// optimal-lineup delta after the swap. That's what keeps a WR3-for-WR3 trade
// between two already-deep receiving corps from outranking a trade that
// actually plugs a starting hole.

import { scorePlayer, buildOptimalLineup } from "./lineup.js";

const TRADEABLE_POSITIONS = ["QB", "RB", "WR", "TE"];
const MAX_TRADES_RETURNED = 20;
// How much lineup value the other side is allowed to lose and still count as
// a realistic ask — beyond this it's a lopsided trade nobody would accept.
const MAX_ACCEPTABLE_OPPONENT_LOSS = 1.5;

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

function buildReason(give, get, myDelta, theirDelta, theirTeamName) {
  const upgradeNote = get.matchupNote ? `, ${get.matchupNote}` : "";
  const fairness =
    theirDelta >= 0
      ? `also nets ${theirTeamName} a lineup upgrade — a realistic win-win`
      : `costs ${theirTeamName} only ${Math.abs(theirDelta)} lineup pts — plausible if they value a different need`;
  return `${get.name} projects a +${myDelta} pt lineup gain for you${upgradeNote}; ${fairness}.`;
}

function buildTradeAnalysis({ roster, otherTeams, rosterSlots, opponents, rankings, unitHealth, weeksHistory }) {
  const myScored = roster.map((p) => scorePlayer(p, opponents, rankings, unitHealth, weeksHistory));
  const myBaseline = lineupTotal(myScored, rosterSlots);
  const myCandidates = myScored.filter((p) => TRADEABLE_POSITIONS.includes(p.position));

  const trades = [];
  for (const team of otherTeams || []) {
    const theirScored = team.roster.map((p) => scorePlayer(p, opponents, rankings, unitHealth, weeksHistory));
    const theirBaseline = lineupTotal(theirScored, rosterSlots);
    const theirCandidates = theirScored.filter((p) => TRADEABLE_POSITIONS.includes(p.position));

    for (const give of myCandidates) {
      const myRosterWithoutGive = myScored.filter((p) => p.id !== give.id);
      for (const get of theirCandidates) {
        if (get.position !== give.position) continue;

        const myDelta = round1(lineupTotal([...myRosterWithoutGive, get], rosterSlots) - myBaseline);
        if (myDelta <= 0) continue; // only surface trades that are actual upgrades for me

        const theirRosterWithoutGet = theirScored.filter((p) => p.id !== get.id);
        const theirDelta = round1(lineupTotal([...theirRosterWithoutGet, give], rosterSlots) - theirBaseline);
        if (theirDelta < -MAX_ACCEPTABLE_OPPONENT_LOSS) continue; // too lopsided to be realistic

        trades.push({
          withTeam: team.teamName,
          give: summarizeForTrade(give),
          receive: summarizeForTrade(get),
          myLineupDelta: myDelta,
          theirLineupDelta: theirDelta,
          reason: buildReason(give, get, myDelta, theirDelta, team.teamName),
        });
      }
    }
  }

  trades.sort((a, b) => b.myLineupDelta - a.myLineupDelta);
  const allTrades = trades.slice(0, MAX_TRADES_RETURNED);
  return { topTrades: allTrades.slice(0, 3), allTrades };
}

export { buildTradeAnalysis };
