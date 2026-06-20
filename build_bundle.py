#!/usr/bin/env python3
"""
Regenerate bundle.json at the repo root for the public dashboard.

Run by the GitHub Action (.github/workflows/refresh.yml) on a schedule. It
reuses server.py's live fetch/parse logic, reads the editable JSON in data/,
and STRIPS the private sponsor links so nothing internal is published.
"""

import json
import os
import time

import server  # reuses live fetch + parse logic; main() won't run on import

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def main():
    cfg = server.load_json_file("config.json", {})
    order = cfg.get("seriesOrder", ["wec", "imsa", "nascar", "indycar", "wrc"])

    news = {s: server.get_news(s) for s in order}
    news["all"] = server.get_news("all")

    outreach = server.load_json_file("outreach.json", {})
    outreach.pop("sheetUrl", None)     # never publish the contacts sheet link
    outreach.pop("draftsUrl", None)    # never publish the Gmail drafts link

    bundle = {
        "ok": True,
        "config": cfg,
        "standings": server.get_standings(),
        "calendar": server.load_json_file("calendar.json", {}),
        "news": news,
        "nascar": server.get_nascar("1"),
        "outreach": outreach,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }

    out = os.path.join(BASE_DIR, "bundle.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(bundle, f, ensure_ascii=False)

    st = bundle["standings"].get("series", {})
    live = [k for k, v in st.items() if v.get("live")]
    counts = {k: len(v.get("items", [])) for k, v in bundle["news"].items()}
    print("wrote bundle.json | live standings: %s | news: %s | nascar ok: %s"
          % (live or "none", counts, bundle["nascar"].get("ok")))


if __name__ == "__main__":
    main()
