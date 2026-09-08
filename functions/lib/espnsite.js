// Headers for ESPN's public (no-auth) site.api.espn.com endpoints (scoreboard,
// injuries, news). Its WAF 403s requests with no browser-like User-Agent —
// Workers' default fetch UA gets blocked, so spoof one.
export const ESPN_SITE_HEADERS = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
};
