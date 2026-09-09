// Resolves each NFL team's opponent, kickoff time, and Vegas line for a given
// week. ESPN's public site.api.espn.com scoreboard 403s Cloudflare Workers'
// traffic (its WAF appears to block Workers' shared egress IPs — confirmed
// the exact same URL works fine from a non-Worker client), so this instead
// uses nflverse's public schedule dataset, hosted on GitHub, which isn't
// blocked and already backs the rest of this app's non-ESPN stats.

import { toEspnAbbr, fetchNflverseCsv } from "./nflverse.js";

const GAMES_URL = "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv";

async function fetchWeekGames(week, season) {
  const rows = await fetchNflverseCsv(GAMES_URL);
  return rows.filter(
    (r) => r.game_type === "REG" && Number(r.week) === Number(week) && Number(r.season) === Number(season)
  );
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// US DST (since 2007) runs 2nd Sunday of March through 1st Sunday of
// November; nflverse's gametime is Eastern local, and NFL games only ever
// fall in that Sept-Feb window, so only the November edge really matters.
function easternUtcOffsetHours(gamedayUtc) {
  const y = gamedayUtc.getUTCFullYear();
  const novFirst = new Date(Date.UTC(y, 10, 1));
  const firstSundayNov = new Date(Date.UTC(y, 10, 1 + ((7 - novFirst.getUTCDay()) % 7)));
  const marFirst = new Date(Date.UTC(y, 2, 1));
  const secondSundayMar = new Date(Date.UTC(y, 2, 1 + ((7 - marFirst.getUTCDay()) % 7) + 7));
  const isDst = gamedayUtc >= secondSundayMar && gamedayUtc < firstSundayNov;
  return isDst ? 4 : 5; // hours Eastern is behind UTC
}

function kickoffToIso(gameday, gametime) {
  if (!gameday || !gametime) return null;
  const offset = easternUtcOffsetHours(new Date(`${gameday}T00:00:00Z`));
  return `${gameday}T${gametime}:00-0${offset}:00`;
}

async function getWeekOpponents(week, season) {
  const games = await fetchWeekGames(week, season);

  const opponents = {};
  for (const g of games) {
    const homeAbbr = toEspnAbbr(g.home_team);
    const awayAbbr = toEspnAbbr(g.away_team);
    if (!homeAbbr || !awayAbbr) continue;

    const overUnder = g.total_line !== "" ? parseFloat(g.total_line) : null;
    // nflverse's spread_line is positive when the HOME team is favored;
    // this app's convention (matching the old ESPN-derived odds.spread) is
    // each team's OWN spread with negative = favored, so flip the sign for
    // home and mirror it for away.
    const homeOwnSpread = g.spread_line !== "" ? -parseFloat(g.spread_line) : null;
    const awayOwnSpread = homeOwnSpread !== null ? -homeOwnSpread : null;

    let homeImplied = null;
    let awayImplied = null;
    if (overUnder !== null && homeOwnSpread !== null) {
      homeImplied = round1(overUnder / 2 - homeOwnSpread / 2);
      awayImplied = round1(overUnder / 2 + homeOwnSpread / 2);
    }

    const kickoffTime = kickoffToIso(g.gameday, g.gametime);

    opponents[homeAbbr] = {
      opponent: awayAbbr,
      isHome: true,
      impliedTotal: homeImplied,
      overUnder,
      spread: homeOwnSpread,
      kickoffTime,
    };
    opponents[awayAbbr] = {
      opponent: homeAbbr,
      isHome: false,
      impliedTotal: awayImplied,
      overUnder,
      spread: awayOwnSpread,
      kickoffTime,
    };
  }
  return opponents; // { TEAM_ABBR: { opponent, isHome, impliedTotal, overUnder, spread, kickoffTime } }, teams on bye are absent
}

async function isWeekComplete(week, season) {
  const games = await fetchWeekGames(week, season);
  if (games.length === 0) return false; // no schedule data yet — can't be "complete"
  return games.every((g) => g.home_score !== "" && g.away_score !== "");
}

export { getWeekOpponents, isWeekComplete };
