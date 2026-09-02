// Cross-week tracking, backed by Cloudflare KV (bound as HISTORY_KV). Each
// finalized week is stored once as a small JSON snapshot of that week's
// roster: projected vs. actual points per player.

const KEY_PREFIX = "week-";

function weekKey(week) {
  return `${KEY_PREFIX}${String(week).padStart(2, "0")}`;
}

async function hasWeek(kv, week) {
  const existing = await kv.get(weekKey(week), { type: "json" });
  return existing != null;
}

// players: [{ id, name, position, proTeam, opponent, projectedPoints, actualPoints, dvpRank }]
// KV has no atomic "only if new" write (unlike Netlify Blobs' `onlyIfNew`) —
// this check-then-put leaves a small race window between two concurrent
// invocations, acceptable for a once-a-week scheduled job.
async function recordWeek(kv, week, players) {
  const key = weekKey(week);
  const existing = await kv.get(key);
  if (existing != null) return false; // a snapshot for this week already existed
  await kv.put(key, JSON.stringify({ week, recordedAt: new Date().toISOString(), players }));
  return true;
}

async function getAllWeeks(kv) {
  const { keys } = await kv.list({ prefix: KEY_PREFIX });
  const weeks = await Promise.all(keys.map((k) => kv.get(k.name, { type: "json" })));
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

export { hasWeek, recordWeek, getAllWeeks, playerHistoryFromWeeks };
