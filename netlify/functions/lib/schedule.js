// Resolves each NFL team's opponent for a given week, via ESPN's public
// (no-auth) scoreboard endpoint.

async function getWeekOpponents(week, season) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week=${week}&seasontype=2&year=${season}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`ESPN scoreboard request failed (${res.status})`);
  }
  const data = await res.json();

  const opponents = {};
  for (const event of data.events || []) {
    const competition = event.competitions?.[0];
    if (!competition) continue;
    const [a, b] = competition.competitors || [];
    if (!a || !b) continue;
    const abbrA = a.team?.abbreviation;
    const abbrB = b.team?.abbreviation;
    if (!abbrA || !abbrB) continue;

    // odds[0].spread/overUnder are relative to the HOME team regardless of
    // competitor array order — resolve which entry is home before computing
    // implied totals.
    const odds = competition.odds?.[0];
    let impliedByAbbr = {};
    if (odds && typeof odds.overUnder === "number" && typeof odds.spread === "number") {
      const home = a.homeAway === "home" ? a : b;
      const away = home === a ? b : a;
      const homeImplied = round1(odds.overUnder / 2 - odds.spread / 2);
      const awayImplied = round1(odds.overUnder / 2 + odds.spread / 2);
      impliedByAbbr = {
        [home.team.abbreviation]: homeImplied,
        [away.team.abbreviation]: awayImplied,
      };
    }

    opponents[abbrA] = {
      opponent: abbrB,
      isHome: a.homeAway === "home",
      impliedTotal: impliedByAbbr[abbrA] ?? null,
      overUnder: odds?.overUnder ?? null,
      spread: odds?.spread ?? null,
    };
    opponents[abbrB] = {
      opponent: abbrA,
      isHome: b.homeAway === "home",
      impliedTotal: impliedByAbbr[abbrB] ?? null,
      overUnder: odds?.overUnder ?? null,
      spread: odds?.spread ?? null,
    };
  }
  return opponents; // { TEAM_ABBR: { opponent, isHome, impliedTotal, overUnder, spread } }, teams on bye are absent
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

async function isWeekComplete(week, season) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week=${week}&seasontype=2&year=${season}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`ESPN scoreboard request failed (${res.status})`);
  }
  const data = await res.json();
  const events = data.events || [];
  if (events.length === 0) return false; // no schedule data yet — can't be "complete"
  return events.every((e) => e.competitions?.[0]?.status?.type?.completed === true);
}

module.exports = { getWeekOpponents, isWeekComplete };
