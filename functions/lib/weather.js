// Weather Impact Dashboard — Open-Meteo (free, no API key, supports batched
// multi-location requests). Only outdoor stadiums carry real weather risk;
// retractable-roof stadiums are conservatively treated as domes here since
// there's no free way to know in advance whether the roof will be open.

const STADIUMS = {
  ARI: { lat: 33.5276, lon: -112.2626, roof: "dome" },
  ATL: { lat: 33.7554, lon: -84.4008, roof: "dome" },
  BAL: { lat: 39.278, lon: -76.6227, roof: "outdoor" },
  BUF: { lat: 42.7738, lon: -78.787, roof: "outdoor" },
  CAR: { lat: 35.2258, lon: -80.8528, roof: "outdoor" },
  CHI: { lat: 41.8623, lon: -87.6167, roof: "outdoor" },
  CIN: { lat: 39.0955, lon: -84.5161, roof: "outdoor" },
  CLE: { lat: 41.5061, lon: -81.6995, roof: "outdoor" },
  DAL: { lat: 32.7473, lon: -97.0945, roof: "dome" },
  DEN: { lat: 39.7439, lon: -105.0201, roof: "outdoor" },
  DET: { lat: 42.34, lon: -83.0456, roof: "dome" },
  GB: { lat: 44.5013, lon: -88.0622, roof: "outdoor" },
  HOU: { lat: 29.6847, lon: -95.4107, roof: "dome" },
  IND: { lat: 39.7601, lon: -86.1639, roof: "dome" },
  JAX: { lat: 30.3239, lon: -81.6373, roof: "outdoor" },
  KC: { lat: 39.0489, lon: -94.4839, roof: "outdoor" },
  LV: { lat: 36.0909, lon: -115.1833, roof: "dome" },
  LAC: { lat: 33.9535, lon: -118.3392, roof: "dome" },
  LAR: { lat: 33.9535, lon: -118.3392, roof: "dome" },
  MIA: { lat: 25.958, lon: -80.2389, roof: "outdoor" },
  MIN: { lat: 44.9736, lon: -93.2575, roof: "dome" },
  NE: { lat: 42.0909, lon: -71.2643, roof: "outdoor" },
  NO: { lat: 29.9511, lon: -90.0812, roof: "dome" },
  NYG: { lat: 40.8135, lon: -74.0745, roof: "outdoor" },
  NYJ: { lat: 40.8135, lon: -74.0745, roof: "outdoor" },
  PHI: { lat: 39.9008, lon: -75.1675, roof: "outdoor" },
  PIT: { lat: 40.4468, lon: -80.0158, roof: "outdoor" },
  SF: { lat: 37.4032, lon: -121.9698, roof: "outdoor" },
  SEA: { lat: 47.5952, lon: -122.3316, roof: "outdoor" },
  TB: { lat: 27.9759, lon: -82.5033, roof: "outdoor" },
  TEN: { lat: 36.1665, lon: -86.7713, roof: "outdoor" },
  WSH: { lat: 38.9077, lon: -76.8645, roof: "outdoor" },
};

function assessRisk(tempF, windMph, precipChance) {
  const risks = [];
  if (windMph >= 20) risks.push("High wind — passing/kicking risk");
  if (precipChance >= 50) risks.push("Precipitation likely");
  if (tempF <= 20) risks.push("Extreme cold");
  return risks.length ? risks.join("; ") : null;
}

// teamAbbrs: the set of teams actually relevant this week (roster's own
// teams + their opponents) — kept small so the batched call stays fast.
async function getWeatherForTeams(teamAbbrs, opponents) {
  const outdoorTeams = [...new Set(teamAbbrs)].filter((t) => STADIUMS[t]?.roof === "outdoor" && opponents[t]?.isHome);
  if (!outdoorTeams.length) return {};

  const lats = outdoorTeams.map((t) => STADIUMS[t].lat).join(",");
  const lons = outdoorTeams.map((t) => STADIUMS[t].lon).join(",");
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&hourly=temperature_2m,windspeed_10m,precipitation_probability&forecast_days=10&temperature_unit=fahrenheit&windspeed_unit=mph`;

  // Open-Meteo occasionally streams a truncated body on larger multi-location
  // requests ("allEndpointsUnavailable") — one retry clears it in practice.
  let results;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url);
    if (!res.ok) {
      if (attempt === 1) throw new Error(`Open-Meteo request failed (${res.status})`);
      continue;
    }
    const text = await res.text();
    try {
      results = JSON.parse(text);
      break;
    } catch (e) {
      if (attempt === 1) throw new Error("Open-Meteo returned a malformed response after retry");
    }
  }
  const list = Array.isArray(results) ? results : [results];

  const weather = {};
  outdoorTeams.forEach((homeTeam, i) => {
    const forecast = list[i];
    const kickoff = opponents[homeTeam]?.kickoffTime;
    if (!forecast?.hourly?.time || !kickoff) return;

    const kickoffMs = new Date(kickoff).getTime();
    let closestIdx = 0;
    let closestDiff = Infinity;
    forecast.hourly.time.forEach((t, idx) => {
      const diff = Math.abs(new Date(t).getTime() - kickoffMs);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestIdx = idx;
      }
    });
    // forecast only extends 16 days out — if kickoff is further away than
    // that, the "closest" hour is a poor proxy, so skip rather than mislead.
    if (closestDiff > 6 * 60 * 60 * 1000) return;

    const tempF = Math.round(forecast.hourly.temperature_2m[closestIdx]);
    const windMph = Math.round(forecast.hourly.windspeed_10m[closestIdx]);
    const precipChance = Math.round(forecast.hourly.precipitation_probability[closestIdx]);

    const entry = { tempF, windMph, precipChance, risk: assessRisk(tempF, windMph, precipChance) };
    weather[homeTeam] = entry;
    const awayTeam = opponents[homeTeam]?.opponent;
    if (awayTeam) weather[awayTeam] = entry; // same game, same weather
  });

  return weather; // { [teamAbbr]: { tempF, windMph, precipChance, risk } }, dome/too-far-out teams simply absent
}

export { getWeatherForTeams, STADIUMS };
