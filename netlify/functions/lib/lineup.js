const { getDvpRank } = require("./defense.js");

const STARTER_LOGIC_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"];

// scale DVP rank 1 (most exploitable) -> 32 (toughest) into a projection multiplier
function matchupMultiplier(dvp) {
  if (!dvp) return { multiplier: 1, note: null };
  const { rank, outOf } = dvp;
  const t = (rank - 1) / (outOf - 1); // 0 = most exploitable, 1 = toughest
  const multiplier = 1.15 - t * 0.3; // 1.15x .. 0.85x
  let note = null;
  if (rank <= Math.ceil(outOf * 0.2)) note = `great matchup (#${rank}/${outOf} vs position)`;
  else if (rank >= outOf - Math.ceil(outOf * 0.2) + 1) note = `tough matchup (#${rank}/${outOf} vs position)`;
  return { multiplier, note };
}

function injuryAdjustment(injuryStatus) {
  switch (injuryStatus) {
    case "Out":
    case "IR":
    case "Suspended":
      return { multiplier: 0, flag: `${injuryStatus} — not expected to play` };
    case "Doubtful":
      return { multiplier: 0.25, flag: "Doubtful — low snap/usage expectation" };
    case "Questionable":
      return { multiplier: 0.85, flag: "Questionable — game-time decision" };
    default:
      return { multiplier: 1, flag: null };
  }
}

function scorePlayer(player, opponents, rankings) {
  const opp = opponents[player.proTeam];
  const dvp = opp ? getDvpRank(rankings, opp.opponent, player.position) : null;
  const { multiplier: matchupMult, note: matchupNote } = matchupMultiplier(dvp);
  const { multiplier: injuryMult, flag: injuryFlag } = injuryAdjustment(player.injuryStatus);

  const base = player.projectedPoints ?? 0;
  const adjustedProjection = opp
    ? Math.round(base * matchupMult * injuryMult * 10) / 10
    : Math.round(base * injuryMult * 10) / 10; // bye week: no matchup data

  return {
    ...player,
    opponent: opp ? opp.opponent : "BYE",
    isHome: opp ? opp.isHome : null,
    dvpRank: dvp,
    matchupNote,
    injuryFlag,
    adjustedProjection,
    onBye: !opp,
  };
}

// Greedy slot-fill: sort by adjusted projection, fill required slots first,
// then FLEX-type slots from best remaining eligible players.
function buildOptimalLineup(scoredRoster, rosterSlots) {
  const pool = [...scoredRoster].sort((a, b) => b.adjustedProjection - a.adjustedProjection);
  const used = new Set();
  const lineup = [];

  const singlePositionSlots = rosterSlots.filter((s) =>
    STARTER_LOGIC_POSITIONS.includes(s.name)
  );
  const flexSlots = rosterSlots.filter((s) => !STARTER_LOGIC_POSITIONS.includes(s.name));

  const eligibleFor = (slotName, player) => {
    if (STARTER_LOGIC_POSITIONS.includes(slotName)) return player.position === slotName;
    if (slotName === "FLEX") return ["RB", "WR", "TE"].includes(player.position);
    if (slotName === "WR/TE") return ["WR", "TE"].includes(player.position);
    if (slotName === "RB/WR") return ["RB", "WR"].includes(player.position);
    if (slotName === "RB/WR/TE") return ["RB", "WR", "TE"].includes(player.position);
    if (slotName === "OP") return true; // superflex
    return false;
  };

  for (const slot of singlePositionSlots) {
    for (let i = 0; i < slot.count; i++) {
      const pick = pool.find((p) => !used.has(p.id) && eligibleFor(slot.name, p));
      if (pick) {
        used.add(pick.id);
        lineup.push({ slot: slot.name, player: pick });
      } else {
        lineup.push({ slot: slot.name, player: null });
      }
    }
  }
  for (const slot of flexSlots) {
    for (let i = 0; i < slot.count; i++) {
      const pick = pool.find((p) => !used.has(p.id) && eligibleFor(slot.name, p));
      if (pick) {
        used.add(pick.id);
        lineup.push({ slot: slot.name, player: pick });
      } else {
        lineup.push({ slot: slot.name, player: null });
      }
    }
  }

  const bench = pool.filter((p) => !used.has(p.id));
  return { lineup, bench };
}

function currentStarters(scoredRoster) {
  // ESPN lineupSlotId of 20 = bench, 21 = IR; anything else is a starting slot
  return scoredRoster.filter((p) => p.lineupSlotId !== 20 && p.lineupSlotId !== 21);
}

function diffLineup(optimalLineup, currentStartersList) {
  const optimalIds = new Set(
    optimalLineup.lineup.filter((l) => l.player).map((l) => l.player.id)
  );
  const currentIds = new Set(currentStartersList.map((p) => p.id));

  const startInstead = optimalLineup.lineup
    .filter((l) => l.player && !currentIds.has(l.player.id))
    .map((l) => l.player);
  const benchInstead = currentStartersList.filter((p) => !optimalIds.has(p.id));

  const changes = [];
  const n = Math.min(startInstead.length, benchInstead.length);
  for (let i = 0; i < n; i++) {
    const start = startInstead[i];
    const bench = benchInstead[i];
    changes.push({
      start,
      bench,
      reason: `${start.name} (${start.adjustedProjection} adj pts${
        start.matchupNote ? ", " + start.matchupNote : ""
      }) projects ahead of ${bench.name} (${bench.adjustedProjection} adj pts${
        bench.injuryFlag ? ", " + bench.injuryFlag : ""
      })`,
    });
  }
  return changes;
}

function suggestWaivers(scoredRoster, scoredFreeAgents, bench) {
  const weakSpots = {};
  for (const p of scoredRoster) {
    weakSpots[p.position] = weakSpots[p.position] || [];
    weakSpots[p.position].push(p);
  }

  const suggestions = [];
  const topFreeAgents = [...scoredFreeAgents].sort(
    (a, b) => b.adjustedProjection - a.adjustedProjection
  );

  for (const fa of topFreeAgents.slice(0, 40)) {
    const worstAtPosition = (weakSpots[fa.position] || [])
      .filter((p) => p.lineupSlotId === 20) // only compare against bench players
      .sort((a, b) => a.adjustedProjection - b.adjustedProjection)[0];
    if (worstAtPosition && fa.adjustedProjection > worstAtPosition.adjustedProjection + 2) {
      suggestions.push({
        add: fa,
        drop: worstAtPosition,
        reason: `${fa.name} projects ${(
          fa.adjustedProjection - worstAtPosition.adjustedProjection
        ).toFixed(1)} pts higher than ${worstAtPosition.name}${
          fa.matchupNote ? " — " + fa.matchupNote : ""
        }`,
      });
    }
    if (suggestions.length >= 5) break;
  }
  return suggestions;
}

function buildKeyTakeaways({ scoredRoster, lineupChanges, waiverSuggestions, week }) {
  const takeaways = [];

  const bestMatchup = [...scoredRoster]
    .filter((p) => p.matchupNote?.includes("great"))
    .sort((a, b) => b.adjustedProjection - a.adjustedProjection)[0];
  if (bestMatchup) {
    takeaways.push(
      `${bestMatchup.name} has the best matchup on your roster this week (${bestMatchup.matchupNote}) — locked-in start.`
    );
  }

  const injuries = scoredRoster.filter((p) => p.injuryFlag && p.lineupSlotId !== 20 && p.lineupSlotId !== 21);
  for (const p of injuries) {
    takeaways.push(`${p.name}: ${p.injuryFlag}.`);
  }

  if (lineupChanges.length) {
    takeaways.push(
      `Recommend ${lineupChanges.length} lineup change${lineupChanges.length > 1 ? "s" : ""} this week — see Suggested Changes below.`
    );
  } else {
    takeaways.push("Your current starting lineup already matches the optimal lineup — no changes recommended.");
  }

  if (waiverSuggestions.length) {
    const top = waiverSuggestions[0];
    takeaways.push(
      `Top waiver target: ${top.add.name} (${top.add.position}, ${top.add.percentOwned ?? "?"}% owned) — ${top.reason}`
    );
  }

  const toughMatchups = scoredRoster.filter(
    (p) => p.matchupNote?.includes("tough") && p.lineupSlotId !== 20 && p.lineupSlotId !== 21
  );
  for (const p of toughMatchups) {
    takeaways.push(`Risky start: ${p.name} faces a tough matchup this week (${p.matchupNote}).`);
  }

  const byePlayers = scoredRoster.filter((p) => p.onBye && p.lineupSlotId !== 20 && p.lineupSlotId !== 21);
  for (const p of byePlayers) {
    takeaways.push(`${p.name} is on bye this week — must be replaced in your lineup.`);
  }

  takeaways.push(`Analysis for Week ${week}.`);
  return takeaways;
}

function buildAnalysis({ roster, freeAgents, rosterSlots, opponents, rankings, week, defenseSource }) {
  const scoredRoster = roster.map((p) => scorePlayer(p, opponents, rankings));
  const scoredFreeAgents = freeAgents.map((p) => scorePlayer(p, opponents, rankings));

  const optimalLineup = buildOptimalLineup(scoredRoster, rosterSlots);
  const startersNow = currentStarters(scoredRoster);
  const lineupChanges = diffLineup(optimalLineup, startersNow);
  const waiverSuggestions = suggestWaivers(scoredRoster, scoredFreeAgents, optimalLineup.bench);
  const keyTakeaways = buildKeyTakeaways({ scoredRoster, lineupChanges, waiverSuggestions, week });

  return {
    week,
    defenseDataSource: defenseSource,
    keyTakeaways,
    startingLineup: optimalLineup.lineup.map((l) => ({
      slot: l.slot,
      player: l.player
        ? {
            name: l.player.name,
            position: l.player.position,
            opponent: l.player.opponent,
            adjustedProjection: l.player.adjustedProjection,
            projectedPoints: l.player.projectedPoints,
            matchupNote: l.player.matchupNote,
            injuryFlag: l.player.injuryFlag,
          }
        : null,
    })),
    bench: optimalLineup.bench.map(summarizePlayer),
    suggestedChanges: lineupChanges.map((c) => ({
      start: summarizePlayer(c.start),
      bench: summarizePlayer(c.bench),
      reason: c.reason,
    })),
    waiverTargets: waiverSuggestions.map((w) => ({
      add: summarizePlayer(w.add),
      drop: summarizePlayer(w.drop),
      reason: w.reason,
    })),
    fullRoster: scoredRoster.map(summarizePlayer),
  };
}

function summarizePlayer(p) {
  return {
    name: p.name,
    position: p.position,
    proTeam: p.proTeam,
    opponent: p.opponent,
    onBye: p.onBye,
    projectedPoints: p.projectedPoints,
    adjustedProjection: p.adjustedProjection,
    dvpRank: p.dvpRank,
    matchupNote: p.matchupNote,
    injuryStatus: p.injuryStatus,
    injuryFlag: p.injuryFlag,
    percentOwned: p.percentOwned,
  };
}

module.exports = { buildAnalysis };
