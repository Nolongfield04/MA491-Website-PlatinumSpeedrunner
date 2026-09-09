// Shared helpers for pulling data from nflverse's public GitHub-hosted
// releases (github.com/nflverse/nflverse-data) — used instead of ESPN's
// site.api.espn.com for anything ESPN's WAF blocks Workers traffic from.

// nflverse uses a couple of abbreviations that differ from ESPN's.
const ESPN_TO_NFLVERSE = { LAR: "LA", WSH: "WAS" };
const NFLVERSE_TO_ESPN = { LA: "LAR", WAS: "WSH" };

function toNflverseAbbr(espnAbbr) {
  return ESPN_TO_NFLVERSE[espnAbbr] || espnAbbr;
}

function toEspnAbbr(nflverseAbbr) {
  return NFLVERSE_TO_ESPN[nflverseAbbr] || nflverseAbbr;
}

// Minimal CSV parser that handles quoted fields (some nflverse columns,
// e.g. headshot_url, contain commas inside quotes).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, i) => (obj[h] = r[i]));
    return obj;
  });
}

async function fetchNflverseCsv(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(`nflverse data request failed (${res.status}): ${url}`);
    err.status = res.status;
    throw err;
  }
  return parseCsv(await res.text());
}

export { toNflverseAbbr, toEspnAbbr, parseCsv, fetchNflverseCsv };
