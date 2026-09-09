// Recommended trades: for each other team in the league, finds a trade that
// (a) fills a spot in THEIR actual current starting lineup with one of my
// players who's a real upgrade there, (b) fills a spot in MY actual starting
// lineup in return, and (c) never has me giving up more value than I get.
// Needs are read off each team's real ESPN-set lineup (lineupSlotId), not a
// recomputed "optimal" lineup for them — a trade target has to be someone
// THEY'D actually bench, or it wouldn't move the needle for that manager at
// all. Two hard rules, not just preferences: every player I offer up comes
// from my bench, never my current starting lineup — if my bench can't put
// together a fair package for a given team, no trade is proposed for that
// team at all, rather than reaching into a starter — and the total value I
// receive must be at least what I give up, in the same raw season-point
// terms shown on the page.
//
// "Value" for the fairness math isn't just a player's raw season point
// total, though: a starter at a thin position (where the waiver wire has
// nothing close) commands a premium over that raw number, and a package
// where I'm sending multiple players is expected to net me a bit more, not
// just parity (bundling assets has its own cost, separate from the raw
// points) — that internal math still has to clear the hard "never lose
// value" floor above it, though. When a single-for-single swap doesn't
// clear the fairness bar, a smaller "throw-in" piece is added to whichever
// side is light, same as how real trades get balanced. This is a snapshot
// signal for the current week, not a season-long dynasty calculator, though
// the underlying player values update as ESPN's own season-long projections
// do through the year.

import { scorePlayer, buildOptimalLineup, currentStarters } from "./lineup.js";

const TRADEABLE_POSITIONS = ["QB", "RB", "WR", "TE"];
const TOP_TRADES_RETURNED = 5;
const NEEDIEST_POSITIONS_PER_TEAM = 2; // how many of a team's weakest starting spots count as "needs"
const MIN_UPGRADE_MARGIN = 20; // season-point margin the anchor "give" must clear over their current starter
const FAIRNESS_MIN_ABSOLUTE = 20; // season-point slack allowed even for small-value players
const FAIRNESS_MAX_ABSOLUTE = 55; // ...but never more than this, regardless of how big the players are
const FAIRNESS_RELATIVE = 0.2; // the base allowance: this fraction of the larger side's value
const STARTER_SCARCITY_RATE = 0.18; // fraction of a starter's above-waiver-replacement value counted as an extra "hard to replace" premium
const REPLACEMENT_POOL_SIZE = 3; // average the top N free agents at a position to gauge how thin the waiver wire is there
const MULTI_PLAYER_PREMIUM = 0.12; // the side sending MORE players in a package should net this much more value, not just parity

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
// rest-of-season outlook, and keeps updating as ESPN's model does through
// the year — this is what keeps the analyzer from treating "helps my lineup
// this week" as the same thing as "this player is actually worth that much."
// Must also match the CURRENT season's seasonId: a player's stats array
// carries entries from past seasons too, and without this filter `.find()`
// can silently grab last year's season total instead of this year's.
function seasonValue(p, season) {
  const seasonEntry = (p.rawStats || []).find(
    (s) => s.statSourceId === 1 && s.statSplitTypeId === 0 && Number(s.seasonId) === Number(season)
  );
  if (seasonEntry && typeof seasonEntry.appliedTotal === "number") {
    return round1(seasonEntry.appliedTotal);
  }
  // No ESPN season projection for this year (rare — very deep waiver-wire
  // players): fall back to ownership as a rough market-value proxy, scaled
  // onto roughly the same axis as a season point total.
  return round1((p.percentOwned || 0) * 2.5);
}

// Top-N free agents' average value at each position — a data-driven read on
// how thin the waiver wire actually is in THIS league, rather than a
// hardcoded assumption about which positions are generically scarce.
function computeReplacementLevels(freeAgentsScored) {
  const byPosition = {};
  for (const position of TRADEABLE_POSITIONS) {
    const top = freeAgentsScored
      .filter((p) => p.position === position)
      .sort((a, b) => b.tradeValue - a.tradeValue)
      .slice(0, REPLACEMENT_POOL_SIZE);
    byPosition[position] = top.length ? round1(top.reduce((s, p) => s + p.tradeValue, 0) / top.length) : 0;
  }
  return byPosition;
}

// The value actually used for fairness math: a bench/waiver-caliber player's
// value is just their raw season points, but a player currently starting
// gets bumped for how far above the position's waiver-replacement level they
// sit — reflecting that letting go of a starter with no comparable fallback
// available really does cost more than the raw points suggest.
function fairnessValue(p, isStarter, replacementByPosition) {
  if (!isStarter) return p.tradeValue;
  const replacement = replacementByPosition[p.position] || 0;
  const scarcityGap = Math.max(0, p.tradeValue - replacement);
  return round1(p.tradeValue + scarcityGap * STARTER_SCARCITY_RATE);
}

function attachFairnessValues(scoredPlayers, replacementByPosition) {
  const starterIds = new Set(currentStarters(scoredPlayers).map((p) => p.id));
  return scoredPlayers.map((p) => ({
    ...p,
    fairnessVal: fairnessValue(p, starterIds.has(p.id), replacementByPosition),
  }));
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

// How far off (getValue - giveValue) is from what's actually "fair" given
// how many players are on each side. Equal headcounts target plain parity;
// whichever side sends more players is expected to net a premium for
// bundling assets together, not just an even split.
function idealValueGap(giveValue, getValue, giveCount, getCount) {
  if (giveCount === getCount) return 0;
  const base = Math.max(giveValue, getValue, 1);
  return giveCount > getCount ? base * MULTI_PLAYER_PREMIUM : -base * MULTI_PLAYER_PREMIUM;
}

function fairnessSlack(giveValue, getValue) {
  const base = Math.max(giveValue, getValue, 1);
  return Math.min(FAIRNESS_MAX_ABSOLUTE, Math.max(FAIRNESS_MIN_ABSOLUTE, base * FAIRNESS_RELATIVE));
}

function isFairTrade(giveValue, getValue, giveCount, getCount) {
  const actualGap = getValue - giveValue;
  const ideal = idealValueGap(giveValue, getValue, giveCount, getCount);
  return Math.abs(actualGap - ideal) <= fairnessSlack(giveValue, getValue);
}

// Filler player (using fairness-adjusted value) whose addition to `anchorValue`
// lands closest to the ideal give/get gap for the resulting package shape —
// the "throw-in" that balances an otherwise lopsided single-for-single swap,
// same as how real trades get sweetened.
function bestThrowIn(pool, excludeIds, computeResultingGapFor) {
  let best = null;
  for (const p of pool) {
    if (excludeIds.has(p.id)) continue;
    const gap = Math.abs(computeResultingGapFor(p.fairnessVal));
    if (!best || gap < best.gap) best = { player: p, gap };
  }
  return best?.player || null;
}

// Tries the anchor pair as a straight 1-for-1 first; if that's not fair,
// adds one throw-in from whichever side is short on (fairness-adjusted)
// value. Returns null if no combination (with at most one throw-in) clears
// the fairness bar.
function buildBalancedPackage({ giveAnchor, getAnchor, myPool, theirPool }) {
  const anchorGiveFair = giveAnchor.fairnessVal;
  const anchorGetFair = getAnchor.fairnessVal;

  if (isFairTrade(anchorGiveFair, anchorGetFair, 1, 1)) {
    return { giveList: [giveAnchor], getList: [getAnchor] };
  }

  if (anchorGiveFair < anchorGetFair) {
    // I'm light on value — sweeten my side with a smaller piece of mine.
    // Adding a 2nd player to my side makes me the "multi" side, so the
    // target isn't flat parity with their anchor — I should end up
    // slightly light in raw value to account for the bundling premium.
    const throwIn = bestThrowIn(myPool, new Set([giveAnchor.id]), (throwInFair) => {
      const combinedGive = anchorGiveFair + throwInFair;
      return combinedGive - anchorGetFair - idealValueGap(combinedGive, anchorGetFair, 2, 1);
    });
    if (throwIn && isFairTrade(anchorGiveFair + throwIn.fairnessVal, anchorGetFair, 2, 1)) {
      return { giveList: [giveAnchor, throwIn], getList: [getAnchor] };
    }
    return null;
  }

  // My anchor outweighs theirs — they sweeten their side instead.
  const throwIn = bestThrowIn(theirPool, new Set([getAnchor.id]), (throwInFair) => {
    const combinedGet = anchorGetFair + throwInFair;
    return combinedGet - anchorGiveFair - idealValueGap(anchorGiveFair, combinedGet, 1, 2);
  });
  if (throwIn && isFairTrade(anchorGiveFair, anchorGetFair + throwIn.fairnessVal, 1, 2)) {
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
      ? ` Structured as a ${giveList.length}-for-${getList.length} — the side sending more players gets a bit more value back to make bundling worth it.`
      : "";
  return (
    `${teamName} is thin at ${giveList[0].position}: ${describePlayers(giveList)} would likely start${theirCurrent}. ` +
    `${describePlayers(getList)} fills your need at ${getList[0].position} and projects a +${myDelta} pt lineup gain this week — ${valueNote}.${packageNote}`
  );
}

function buildTradeAnalysis({ roster, otherTeams, freeAgents, rosterSlots, season, opponents, rankings, unitHealth, weeksHistory }) {
  const score = (p) => {
    const scored = scorePlayer(p, opponents, rankings, unitHealth, weeksHistory);
    return { ...scored, tradeValue: seasonValue(scored, season) };
  };

  const replacementByPosition = computeReplacementLevels((freeAgents || []).map(score));

  const myScored = attachFairnessValues(roster.map(score), replacementByPosition);
  const myBaseline = lineupTotal(myScored, rosterSlots);
  const myNeeds = computeTeamNeeds(myScored);
  const myNeedPositions = new Set(myNeeds.slice(0, NEEDIEST_POSITIONS_PER_TEAM).map((n) => n.position));
  const myStarterIds = new Set(currentStarters(myScored).map((p) => p.id));
  // Hard rule, not just a preference: never offer up anything in my current
  // starting lineup. Both the anchor and any throw-in are drawn from this
  // bench-only pool, so a starter can't slip in either way.
  const myBenchCandidates = myScored.filter((p) => TRADEABLE_POSITIONS.includes(p.position) && !myStarterIds.has(p.id));

  const bestPerTeam = [];
  for (const team of otherTeams || []) {
    if (!team.roster?.length) continue;
    const theirScored = attachFairnessValues(team.roster.map(score), replacementByPosition);
    const theirNeeds = computeTeamNeeds(theirScored);
    const theirNeedPositions = new Set(theirNeeds.slice(0, NEEDIEST_POSITIONS_PER_TEAM).map((n) => n.position));
    const theirNeedByPosition = new Map(theirNeeds.map((n) => [n.position, n]));
    const theirCandidates = theirScored.filter((p) => TRADEABLE_POSITIONS.includes(p.position));

    let best = null;
    for (const giveAnchor of myBenchCandidates) {
      if (!theirNeedPositions.has(giveAnchor.position)) continue; // not a position this team is looking to upgrade
      const theirNeed = theirNeedByPosition.get(giveAnchor.position);
      if (giveAnchor.tradeValue < theirNeed.weakestValue + MIN_UPGRADE_MARGIN) continue; // not a real upgrade for them

      for (const getAnchor of theirCandidates) {
        if (!myNeedPositions.has(getAnchor.position)) continue; // only chase players at positions I actually need

        const pkg = buildBalancedPackage({ giveAnchor, getAnchor, myPool: myBenchCandidates, theirPool: theirCandidates });
        if (!pkg) continue;

        const giveValue = round1(pkg.giveList.reduce((s, p) => s + p.tradeValue, 0));
        const getValue = round1(pkg.getList.reduce((s, p) => s + p.tradeValue, 0));
        if (getValue < giveValue) continue; // never surface a trade where you give up more raw value than you receive

        const giveIds = new Set(pkg.giveList.map((p) => p.id));
        const myRosterWithoutGives = myScored.filter((p) => !giveIds.has(p.id));
        const myDelta = round1(lineupTotal([...myRosterWithoutGives, ...pkg.getList], rosterSlots) - myBaseline);
        if (myDelta <= 0) continue; // only surface trades that are actual upgrades for me

        if (!best || myDelta > best.myLineupDelta) {
          best = {
            myLineupDelta: myDelta,
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
