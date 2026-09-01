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
    if (abbrA && abbrB) {
      opponents[abbrA] = { opponent: abbrB, isHome: a.homeAway === "home" };
      opponents[abbrB] = { opponent: abbrA, isHome: b.homeAway === "home" };
    }
  }
  return opponents; // { TEAM_ABBR: { opponent, isHome } }, teams on bye are simply absent
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
