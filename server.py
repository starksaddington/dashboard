#!/usr/bin/env python3
"""
Enzo's Morning Dashboard - local server
=======================================
A zero-dependency (Python standard library only) local web server that powers
a personalized motorsport morning dashboard for a WEC/IMSA, NASCAR, IndyCar
and WRC fan.

It serves the static dashboard from /public and exposes a small JSON API that
proxies live data so the browser never hits CORS walls:

  GET /api/news?series=wec|imsa|nascar|indycar|wrc|f1|all
        -> parsed Motorsport.com RSS headlines (title, link, image, summary, date)
  GET /api/nascar?series=1|2|3
        -> NASCAR Cup/Xfinity/Truck schedule + next race + last result
  GET /api/standings   -> editable championship data (data/standings.json)
  GET /api/calendar    -> editable season calendar    (data/calendar.json)
  GET /api/config      -> editable personalization     (data/config.json)
  GET /api/bundle      -> everything the front-end needs in one shot

Live fetches are cached in-memory for a few minutes and fall back to the
bundled sample data in /data when offline, so the dashboard always renders.

Run:  python server.py        (then open http://localhost:8777)
"""

import json
import os
import re
import sys
import time
import html
import threading
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
DATA_DIR = os.path.join(BASE_DIR, "data")

PORT = int(os.environ.get("PORT", "8777"))

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

# --- Motorsport.com RSS endpoints (verified working) -----------------------
RSS_FEEDS = {
    "all": "https://www.motorsport.com/rss/all/news/",
    "wec": "https://www.motorsport.com/rss/wec/news/",
    "imsa": "https://www.motorsport.com/rss/imsa/news/",
    "nascar": "https://www.motorsport.com/rss/nascar/news/",
    "indycar": "https://www.motorsport.com/rss/indycar/news/",
    "wrc": "https://www.motorsport.com/rss/wrc/news/",
    "supercars": "https://www.motorsport.com/rss/v8supercars/news/",
    "f1": "https://www.motorsport.com/rss/f1/news/",
}

# NASCAR public cacher (series 1=Cup, 2=Xfinity, 3=Trucks)
NASCAR_URL = "https://cf.nascar.com/cacher/{year}/{series}/race_list_basic.json"

CACHE_TTL = 600          # seconds for RSS / news
NASCAR_TTL = 1800        # seconds for the NASCAR schedule
_cache = {}              # key -> (timestamp, value)
_cache_lock = threading.Lock()


# --------------------------------------------------------------------------- #
#  helpers
# --------------------------------------------------------------------------- #
def _fetch(url, timeout=12):
    req = urllib.request.Request(url, headers={"User-Agent": UA,
                                               "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    # most feeds are utf-8; be forgiving
    return raw.decode("utf-8", errors="replace")


def _cached(key, ttl, producer):
    """Return cached value if fresh, otherwise (re)produce it. On producer
    failure, serve a stale value if we have one so the page never breaks."""
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1], False
    try:
        value = producer()
        with _cache_lock:
            _cache[key] = (now, value)
        return value, False
    except Exception as e:
        if hit:
            return hit[1], True          # stale but usable
        raise e


def _strip_html(text):
    text = re.sub(r"<[^>]+>", "", text or "")
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _tag(block, name):
    m = re.search(r"<%s>(.*?)</%s>" % (name, name), block,
                  re.S | re.I)
    if not m:
        return ""
    val = m.group(1).strip()
    # unwrap CDATA
    cd = re.match(r"<!\[CDATA\[(.*?)\]\]>", val, re.S)
    if cd:
        val = cd.group(1).strip()
    return val


def parse_rss(xml, source, limit=12):
    items = []
    for block in re.findall(r"<item>(.*?)</item>", xml, re.S | re.I):
        title = html.unescape(_strip_html(_tag(block, "title")))
        link = _tag(block, "link")
        pub = _tag(block, "pubDate")
        desc = _strip_html(_tag(block, "description"))
        img = ""
        m = re.search(r'<media:thumbnail[^>]*url="([^"]+)"', block, re.I)
        if not m:
            m = re.search(r'<enclosure[^>]*url="([^"]+)"', block, re.I)
        if m:
            img = m.group(1)
        if not title:
            continue
        items.append({
            "title": title,
            "link": link,
            "date": pub,
            "summary": (desc[:220] + "…") if len(desc) > 220 else desc,
            "image": img,
            "source": source,
        })
        if len(items) >= limit:
            break
    return items


def get_news(series):
    series = series if series in RSS_FEEDS else "all"
    url = RSS_FEEDS[series]
    label = {"wec": "WEC", "imsa": "IMSA", "nascar": "NASCAR",
             "indycar": "IndyCar", "wrc": "WRC", "supercars": "Supercars",
             "f1": "F1", "all": "Motorsport"}.get(series, series.upper())

    def produce():
        return parse_rss(_fetch(url), label)

    try:
        items, stale = _cached("news:" + series, CACHE_TTL, produce)
        return {"ok": True, "series": series, "stale": stale, "items": items}
    except Exception as e:
        return {"ok": False, "series": series, "stale": True,
                "items": [], "error": str(e)}


def get_nascar(series="1"):
    series = series if series in ("1", "2", "3") else "1"
    year = time.gmtime().tm_year

    def produce():
        # try current year, then previous (season may not be published yet)
        last_err = None
        for yr in (year, year - 1):
            try:
                raw = _fetch(NASCAR_URL.format(year=yr, series=series))
                data = json.loads(raw)
                if isinstance(data, list) and data:
                    return _shape_nascar(data, yr)
            except Exception as e:
                last_err = e
        raise last_err or RuntimeError("no nascar data")

    try:
        val, stale = _cached("nascar:" + series, NASCAR_TTL, produce)
        val["stale"] = stale
        val["ok"] = True
        return val
    except Exception as e:
        return {"ok": False, "stale": True, "error": str(e),
                "races": [], "next": None, "last": None}


def _shape_nascar(data, year):
    now = time.time()
    races = []
    for r in data:
        ds = r.get("date_scheduled") or r.get("race_date") or ""
        ts = _parse_epoch(ds)
        races.append({
            "name": r.get("race_name", "").strip(),
            "track": r.get("track_name", "").strip(),
            "date": ds,
            "ts": ts,
            "laps": r.get("scheduled_laps"),
            "distance": r.get("scheduled_distance"),
            "tv": (r.get("television_broadcaster") or "").strip(),
            "winner": r.get("race_comments", "").strip(),
        })
    upcoming = [r for r in races if r["ts"] and r["ts"] >= now - 6 * 3600]
    nxt = min(upcoming, key=lambda r: r["ts"]) if upcoming else None
    past = [r for r in races if r["ts"] and r["ts"] < now]
    last = max(past, key=lambda r: r["ts"]) if past else None
    return {"year": year, "races": races, "next": nxt, "last": last}


def _parse_epoch(s):
    """Parse the loose datetime strings NASCAR uses (e.g. '2026-02-15T14:30:00')."""
    if not s:
        return None
    s = s.strip().replace("Z", "")
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%dT%H:%M", "%Y-%m-%d"):
        try:
            return time.mktime(time.strptime(s[:len(fmt) + 2], fmt))
        except Exception:
            continue
    return None


def load_json_file(name, default):
    path = os.path.join(DATA_DIR, name)
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


# --------------------------------------------------------------------------- #
#  LIVE championship standings (via ESPN's public JSON; clean & reliable).
#  Each watched series is mapped to an ESPN "racing" league key. The parsed
#  table is grafted onto the editable data/standings.json; a validation gate
#  falls back to the manual data whenever ESPN has nothing usable, so the
#  dashboard never shows broken or empty standings.
# --------------------------------------------------------------------------- #
ESPN_STANDINGS = "https://site.api.espn.com/apis/v2/sports/racing/{league}/standings"
ESPN_LEAGUES = {            # series -> ESPN racing league slug
    "nascar":  "nascar-premier",
    "indycar": "irl",
}
STANDINGS_TTL = 1800        # 30 min


def _espn_rows(league):
    raw = _fetch(ESPN_STANDINGS.format(league=league))
    data = json.loads(raw)

    # ESPN nests standings groups in a few shapes; collect every "entries" list
    entries = []

    def walk(node):
        if isinstance(node, dict):
            if isinstance(node.get("entries"), list):
                entries.extend(node["entries"])
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(data)

    rows = []
    for e in entries:
        ath = e.get("athlete") or e.get("team") or {}
        name = (ath.get("displayName") or ath.get("name")
                or ath.get("shortName") or "").strip()
        if not name:
            continue
        pts = None
        for s in e.get("stats", []):
            label = " ".join(str(s.get(k, "")) for k in
                             ("name", "type", "displayName", "shortDisplayName",
                              "abbreviation")).lower()
            if "point" in label or "pts" in label.split():
                try:
                    pts = int(round(float(s.get("value"))))
                except (TypeError, ValueError):
                    pts = None
                break
        if pts is None:
            continue
        rows.append({"name": name, "points": pts})
    # collapse dupes, rank by points
    uniq = {}
    for r in rows:
        if r["name"] not in uniq or r["points"] > uniq[r["name"]]["points"]:
            uniq[r["name"]] = r
    out = sorted(uniq.values(), key=lambda r: r["points"], reverse=True)
    for i, r in enumerate(out):
        r["pos"] = i + 1
    return out


def _standings_valid(rows):
    if len(rows) < 5:
        return False
    top = [r["points"] for r in rows[:5]]
    return len(set(top)) >= 3 and top[0] > 0   # not all-equal / not all-zero


def get_live_standings(series):
    league = ESPN_LEAGUES.get(series)
    if not league:
        return None

    def produce():
        rows = _espn_rows(league)
        return rows if _standings_valid(rows) else None

    try:
        val, _ = _cached("espn:" + series, STANDINGS_TTL, produce)
        return val
    except Exception:
        return None


def get_standings():
    """Editable JSON standings, enriched with a live ESPN table per series
    where one is available and sane."""
    base = load_json_file("standings.json", {"series": {}})
    for key, block in base.get("series", {}).items():
        live = get_live_standings(key)
        if live:
            manual = {d.get("name", "").split()[-1].lower(): d.get("team", "")
                      for d in block.get("drivers", [])}
            for row in live:
                row["team"] = manual.get(row["name"].split()[-1].lower(), "")
            block["live"] = {"source": "ESPN",
                             "updatedAt": time.strftime("%Y-%m-%d %H:%M"),
                             "table": live}
        else:
            block["live"] = None
    return base


# --------------------------------------------------------------------------- #
#  HTTP handler
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = "EnzoDash/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s - %s\n" % (self.address_string(), fmt % args))

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path):
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg": "image/svg+xml",
            ".ico": "image/x-icon",
            ".png": "image/png",
        }.get(os.path.splitext(path)[1], "application/octet-stream")
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        try:
            if path.startswith("/api/"):
                return self._handle_api(path, qs)
            return self._handle_static(path)
        except BrokenPipeError:
            pass
        except Exception as e:
            self._send_json({"ok": False, "error": str(e)}, 500)

    # --- api ---------------------------------------------------------------
    def _handle_api(self, path, qs):
        if path == "/api/news":
            return self._send_json(get_news(qs.get("series", ["all"])[0]))
        if path == "/api/nascar":
            return self._send_json(get_nascar(qs.get("series", ["1"])[0]))
        if path == "/api/standings":
            return self._send_json(get_standings())
        if path == "/api/calendar":
            return self._send_json(load_json_file("calendar.json", {}))
        if path == "/api/config":
            return self._send_json(load_json_file("config.json", {}))
        if path == "/api/bundle":
            cfg = load_json_file("config.json", {})
            order = cfg.get("seriesOrder",
                            ["wec", "imsa", "nascar", "indycar", "wrc"])
            news = {s: get_news(s) for s in order}
            news["all"] = get_news("all")
            return self._send_json({
                "ok": True,
                "config": cfg,
                "standings": get_standings(),
                "calendar": load_json_file("calendar.json", {}),
                "news": news,
                "nascar": get_nascar("1"),
                "outreach": load_json_file("outreach.json", {}),
                "sponsors": load_json_file("sponsors.json", {}),
                "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            })
        return self._send_json({"ok": False, "error": "unknown endpoint"}, 404)

    # --- static ------------------------------------------------------------
    def _handle_static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        # prevent path traversal
        safe = os.path.normpath(path).lstrip("\\/")
        full = os.path.join(PUBLIC_DIR, safe)
        if not full.startswith(PUBLIC_DIR):
            return self._send_json({"ok": False, "error": "forbidden"}, 403)
        if os.path.isfile(full):
            return self._send_file(full)
        return self._send_json({"ok": False, "error": "not found",
                                "path": path}, 404)


def main():
    os.chdir(BASE_DIR)
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = "http://localhost:%d" % PORT
    print("\n  \U0001F3CE️  Enzo's Morning Dashboard is live")
    print("  -> " + url)
    print("  (Ctrl+C to stop)\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped. See you tomorrow morning!\n")
        httpd.shutdown()


if __name__ == "__main__":
    main()
