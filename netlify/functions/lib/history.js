// Cross-week tracking, backed by Netlify Blobs. Each finalized week is
// stored once (idempotent — set with onlyIfNew) as a small JSON snapshot of
// that week's roster: projected vs. actual points per player.

const { getStore } = require("@netlify/blobs");

const STORE_NAME = "fantasy-history";

function store() {
  return getStore(STORE_NAME);
}

function weekKey(week) {
  return `week-${String(week).padStart(2, "0")}`;
}

async function hasWeek(week) {
  const existing = await store().get(weekKey(week), { type: "json" });
  return existing != null;
}

// players: [{ id, name, position, proTeam, opponent, projectedPoints, actualPoints, dvpRank }]
async function recordWeek(week, players) {
  const result = await store().set(
    weekKey(week),
    JSON.stringify({ week, recordedAt: new Date().toISOString(), players }),
    { onlyIfNew: true }
  );
  return result.modified; // false if a snapshot for this week already existed
}

async function getAllWeeks() {
  const { blobs } = await store().list({ prefix: "week-" });
  const weeks = await Promise.all(
    blobs.map((b) => store().get(b.key, { type: "json" }))
  );
  return weeks.filter(Boolean).sort((a, b) => a.week - b.week);
}

// Returns null when there's fewer than 2 recorded weeks for this player —
// deliberately refuses to compute a "confidence" signal from insufficient data.
// `weeks` should come from a single getAllWeeks() call shared across all
// players in a request, rather than re-fetching per player.
function playerHistoryFromWeeks(weeks, playerId) {
  const series = [];
  for (const w of weeks) {
    const entry = (w.players || []).find((p) => p.id === playerId);
    if (!entry || entry.actualPoints == null) continue;
    series.push({
      week: w.week,
      projected: entry.projectedPoints,
      actual: entry.actualPoints,
      deviation:
        entry.projectedPoints != null ? round1(entry.actualPoints - entry.projectedPoints) : null,
    });
  }
  if (series.length < 2) return null;

  const deviations = series.map((s) => s.deviation).filter((d) => d != null);
  const avgDeviation = round1(deviations.reduce((a, b) => a + b, 0) / deviations.length);
  const mean = deviations.reduce((a, b) => a + b, 0) / deviations.length;
  const variance = deviations.reduce((a, b) => a + (b - mean) ** 2, 0) / deviations.length;
  const volatility = round1(Math.sqrt(variance));
  const hitRate = round1(
    (series.filter((s) => s.deviation != null && s.deviation >= 0).length / series.length) * 100
  );

  return { series, avgDeviation, volatility, hitRate };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

module.exports = { hasWeek, recordWeek, getAllWeeks, playerHistoryFromWeeks };
