// Matches ESPN's public NFL news feed against roster player names, so the
// page can surface only news relevant to a start/sit decision this week.

function lastName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1].toLowerCase();
}

async function getPlayerNews(rosterPlayers) {
  const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`ESPN news request failed (${res.status})`);
  }
  const data = await res.json();

  const byLastName = new Map();
  for (const p of rosterPlayers) {
    byLastName.set(lastName(p.name), p.name);
  }

  const matches = [];
  for (const article of data.articles || []) {
    const athleteCategories = (article.categories || []).filter((c) => c.type === "athlete");
    const matchedPlayers = new Set();
    for (const cat of athleteCategories) {
      const name = cat.description || cat.athlete?.description;
      if (!name) continue;
      const ln = lastName(name);
      if (byLastName.has(ln)) matchedPlayers.add(byLastName.get(ln));
    }
    if (matchedPlayers.size === 0) continue;
    matches.push({
      headline: article.headline,
      description: article.description || null,
      link: article.links?.web?.href || null,
      published: article.published || null,
      players: [...matchedPlayers],
    });
  }

  matches.sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0));
  return matches.slice(0, 15);
}

module.exports = { getPlayerNews };
