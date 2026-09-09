// Recommended trades: for each other team in the league, finds a trade that
// (a) fills a spot in THEIR actual current starting lineup with one of my
// players who's a real upgrade there, (b) fills a spot in MY actual starting
// lineup in return, and (c) trades comparable season-long value both ways —
// so a bench-caliber player never gets floated for a league-winning one just
// because it happens to help my lineup this week. Needs are read off each
// team's real ESPN-set lineup (lineupSlotId), not a recomputed "optimal"
// lineup for them — a trade target has to be someone THEY'D actually bench,
// or it wouldn't move the needle for that manager at all. Prefers giving up
// bench players of mine over anything in my own starting lineup, only
// reaching into my starters if that's what it takes to make the trade fair.
// When a single-for-single swap doesn't clear the fairness bar, a smaller
// "throw-in" piece is added to whichever side is light, same as how real
// trades get balanced. This is a snapshot signal for the current week's
// optimal lineup, not a season-long dynasty trade calculator.

import { scorePlayer, buildOptimalLineup, currentStarters } from "./lineup.js";

const TRADEABLE_POSITIONS = ["QB", "RB", "WR", "TE"];
const TOP_TRADES_RETURNED = 5;
const NEEDIEST_POSITIONS_PER_TEAM = 2; // how many of a team's weakest starting spots count as "needs"
const MIN_UPGRADE_MARGIN = 20; // season-point margin the anchor "give" must clear over their current starter
const FAIRNESS_MIN_ABSOLUTE = 20; // season-point slack allowed even for small-value players
const FAIRNESS_MAX_ABSOLUTE = 55; // ...but never more than this, regardless of how big the players are
const FAIRNESS_RELATIVE = 0.2; // the base allowance: this fraction of the larger side's value

function round1(n) {
  return Math.round(n * 10) / 10;
}

function lineupTotal(scoredRoster, rosterSlots) {
  const { lineup } = buildOptimalLineup(scoredRoster, rosterSlots);
  return round1(lineup.reduce((sum, l) => sum + (l.player ? l.player.adjustedProjection : 0), 0));
}

// A player's own season-long worth, independent of this week's matchup —
// ESPN's full-season projection (statSourceId 1 = projected, statSplitTypeId
// 0 = season total, as opposed to a single week) blends actual-so-far with
// rest-of-season outlook as the year progresses. This is what keeps the
// analyzer from treating "helps my lineup this week" as the same thing as
// "this player is actually worth that much" — Aaron Jones and Jahmyr Gibbs
// might both have a fine Week 1 matchup, but their season totals aren't close.
function seasonValue(p) {
  const seasonEntry = (p.rawStats || []).find((s) => s.statSourceId === 1 && s.statSplitTypeId === 0);
  if (seasonEntry && typeof seasonEntry.appliedTotal === "number") {
    return round1(seasonEntry.appliedTotal);
  }
  // No ESPN season projection (rare — very deep waiver-wire players): fall
  // back to ownership as a rough market-value proxy, scaled onto roughly the
  // same axis as a season point total.
  return round1((p.percentOwned || 0) * 2.5);
}

function isFairTrade(giveValue, getValue) {
  const base = Math.max(giveValue, getValue, 1);
  const allowedGap = Math.min(FAIRNESS_MAX_ABSOLUTE, Math.max(FAIRNESS_MIN_ABSOLUTE, base * FAIRNESS_RELATIVE));
  return Math.abs(giveValue - getValue) <= allowedGap;
}

// Ranked by each ACTUAL starting position's weakest (lowest season-value)
// player — i.e. where this team would most want to upgrade. Deliberately
// reads the roster's real lineupSlotId-based starters, not a recomputed
// "optimal" lineup for them: a trade only helps a team if it replaces
// someone they're really starting. Positions with no current starter at all
// rank as maximal need.
function computeTeamNeeds(scoredRoster) {
  const starters = currentStarters(scoredRoster);
  const needs = TRADEABLE_POSITIONS.map((position) => {
    const positionStarters = starters.filter((p) => p.position === position);
    if (!positionStarters.length) return { position, weakestValue: 0, weakestStarter: null };
    const weakestStarter = positionStarters.reduce((min, p) => (p.tradeValue < min.tradeValue ? p : min));
    return { position, weakestValue: weakestStarter.tradeValue, weakestStarter };
  });
  return needs.sort((a, b) => a.weakestValue - b.weakestValue);
}

// Smallest-gap filler from `pool` that brings `anchorValue` as close as
// possible to `targetValue` — the "throw-in" that balances an otherwise
// lopsided single-for-single swap, same as a real trade would.
function bestThrowIn(pool, excludeIds, anchorValue, targetValue) {
  let best = null;
  for (const p of pool) {
    if (excludeIds.has(p.id)) continue;
    const gap = Math.abs(anchorValue + p.tradeValue - targetValue);
    if (!best || gap < best.gap) best = { player: p, gap };
  }
  return best?.player || null;
}

// Tries the anchor pair as a straight 1-for-1 first; if that's not fair,
// adds one throw-in from whichever side is short on value. Returns null if
// no combination (with at most one throw-in) clears the fairness bar.
function buildBalancedPackage({ giveAnchor, getAnchor, myPool, theirPool }) {
  const anchorGive = giveAnchor.tradeValue;
  const anchorGet = getAnchor.tradeValue;

  if (isFairTrade(anchorGive, anchorGet)) {
    return { giveList: [giveAnchor], getList: [getAnchor] };
  }

  if (anchorGive < anchorGet) {
    // I'm light on value — sweeten my side with a smaller piece of mine.
    const throwIn = bestThrowIn(myPool, new Set([giveAnchor.id]), anchorGive, anchorGet);
    if (throwIn && isFairTrade(anchorGive + throwIn.tradeValue, anchorGet)) {
      return { giveList: [giveAnchor, throwIn], getList: [getAnchor] };
    }
    return null;
  }

  // My anchor outweighs theirs — they sweeten their side instead.
  const throwIn = bestThrowIn(theirPool, new Set([getAnchor.id]), anchorGet, anchorGive);
  if (throwIn && isFairTrade(anchorGive, anchorGet + throwIn.tradeValue)) {
    return { giveList: [giveAnchor], getList: [getAnchor, throwIn] };
  }
  return null;
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
    seasonValue: p.tradeValue,
  };
}

function describePlayers(list) {
  return list.map((p) => `${p.name} (${p.tradeValue} season pts)`).join(" + ");
}

function buildReason({ teamName, giveList, getList, giveValue, getValue, theirNeed, myDelta }) {
  const valueGap = Math.abs(giveValue - getValue);
  const valueNote =
    valueGap <= 10 ? "comparable value" : giveValue > getValue ? "slightly favors you in value" : "slightly favors them in value";
  const theirCurrent = theirNeed.weakestStarter
    ? ` over ${theirNeed.weakestStarter.name} (${theirNeed.weakestValue} season pts)`
    : "";
  const packageNote =
    giveList.length > 1 || getList.length > 1
      ? ` Structured as a ${giveList.length}-for-${getList.length} to balance value.`
      : "";
  return (
    `${teamName} is thin at ${giveList[0].position}: ${describePlayers(giveList)} would likely start${theirCurrent}. ` +
    `${describePlayers(getList)} fills your need at ${getList[0].position} and projects a +${myDelta} pt lineup gain this week — ${valueNote}.${packageNote}`
  );
}

function buildTradeAnalysis({ roster, otherTeams, rosterSlots, opponents, rankings, unitHealth, weeksHistory }) {
  const score = (p) => {
    const scored = scorePlayer(p, opponents, rankings, unitHealth, weeksHistory);
    return { ...scored, tradeValue: seasonValue(scored) };
  };

  const myScored = roster.map(score);
  const myBaseline = lineupTotal(myScored, rosterSlots);
  const myNeeds = computeTeamNeeds(myScored);
  const myNeedPositions = new Set(myNeeds.slice(0, NEEDIEST_POSITIONS_PER_TEAM).map((n) => n.position));
  const myCandidates = myScored.filter((p) => TRADEABLE_POSITIONS.includes(p.position));
  const myStarterIds = new Set(currentStarters(myScored).map((p) => p.id));
  const givesOnlyBench = (giveList) => giveList.every((p) => !myStarterIds.has(p.id));
  // Bench-only packages always beat ones that touch my starting lineup,
  // regardless of lineup delta; only compare delta within the same tier.
  const isBetterCandidate = (a, b) => (a.benchOnly !== b.benchOnly ? a.benchOnly : a.myLineupDelta > b.myLineupDelta);

  const bestPerTeam = [];
  for (const team of otherTeams || []) {
    if (!team.roster?.length) continue;
    const theirScored = team.roster.map(score);
    const theirNeeds = computeTeamNeeds(theirScored);
    const theirNeedPositions = new Set(theirNeeds.slice(0, NEEDIEST_POSITIONS_PER_TEAM).map((n) => n.position));
    const theirNeedByPosition = new Map(theirNeeds.map((n) => [n.position, n]));
    const theirCandidates = theirScored.filter((p) => TRADEABLE_POSITIONS.includes(p.position));

    let best = null;
    for (const giveAnchor of myCandidates) {
      if (!theirNeedPositions.has(giveAnchor.position)) continue; // not a position this team is looking to upgrade
      const theirNeed = theirNeedByPosition.get(giveAnchor.position);
      if (giveAnchor.tradeValue < theirNeed.weakestValue + MIN_UPGRADE_MARGIN) continue; // not a real upgrade for them

      for (const getAnchor of theirCandidates) {
        if (!myNeedPositions.has(getAnchor.position)) continue; // only chase players at positions I actually need

        const pkg = buildBalancedPackage({ giveAnchor, getAnchor, myPool: myCandidates, theirPool: theirCandidates });
        if (!pkg) continue;

        const giveIds = new Set(pkg.giveList.map((p) => p.id));
        const myRosterWithoutGives = myScored.filter((p) => !giveIds.has(p.id));
        const myDelta = round1(lineupTotal([...myRosterWithoutGives, ...pkg.getList], rosterSlots) - myBaseline);
        if (myDelta <= 0) continue; // only surface trades that are actual upgrades for me

        const candidate = { myLineupDelta: myDelta, benchOnly: givesOnlyBench(pkg.giveList) };
        if (!best || isBetterCandidate(candidate, best)) {
          const giveValue = round1(pkg.giveList.reduce((s, p) => s + p.tradeValue, 0));
          const getValue = round1(pkg.getList.reduce((s, p) => s + p.tradeValue, 0));
          best = {
            ...candidate,
            team: team.teamName,
            give: pkg.giveList.map(summarizeForTrade),
            receive: pkg.getList.map(summarizeForTrade),
            reason: buildReason({ teamName: team.teamName, giveList: pkg.giveList, getList: pkg.getList, giveValue, getValue, theirNeed, myDelta }),
          };
        }
      }
    }
    if (best) bestPerTeam.push(best);
  }

  const topTrades = bestPerTeam.sort((a, b) => b.myLineupDelta - a.myLineupDelta).slice(0, TOP_TRADES_RETURNED);
  return { topTrades };
}

export { buildTradeAnalysis };
