#!/usr/bin/env python3
"""
spotlight_cli.py — quick CLI check of GET /api/spotlight

Same shape as uabroad_cli.py, but for the Spotlight card. Useful right
now because the UI just shows "Nothing in the spotlight" on empty *or*
on error (the frontend's `if (!res.ok) return` swallows failures
silently) — this prints the real status code and body so you can tell
which one it actually is.

Usage:
    python3 spotlight_cli.py                    # featured (nearest deadline / most recent)
    python3 spotlight_cli.py --category Grants   # featured, filtered to one category
    python3 spotlight_cli.py --action list       # 10 most recent rows, any deadline
    python3 spotlight_cli.py --action random      # random pick from 20 most recent rows
    python3 spotlight_cli.py --raw               # dump the raw JSON instead
    python3 spotlight_cli.py --check-all         # run featured + list + random in one go
"""

import argparse
import json
import sys
import urllib.error
import urllib.request

API_BASE = "https://groq-api-sand.vercel.app"
ACTIONS = {"featured", "list", "random"}


def fetch(action, category=None):
    url = f"{API_BASE}/api/spotlight?action={action}"
    if category:
        url += f"&category={category}"

    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8", "replace")
            return resp.status, json.loads(body)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(body)
        except json.JSONDecodeError:
            return e.code, {"ok": False, "error": body}
    except urllib.error.URLError as e:
        print(f"Request failed: {e.reason}", file=sys.stderr)
        sys.exit(1)


def display_spotlight(spotlight):
    if not spotlight:
        print("  -> spotlight: null (query ran fine, just no row matched)")
        return
    print(f"  title:    {spotlight.get('title', '(untitled)')}")
    summary = (spotlight.get("summary") or "").strip()
    if summary:
        print(f"  summary:  {summary[:140]}{'…' if len(summary) > 140 else ''}")
    if spotlight.get("category"):
        print(f"  category: {spotlight['category']}")
    if spotlight.get("tags"):
        print(f"  tags:     {', '.join(spotlight['tags'])}")
    print(f"  deadline: {spotlight.get('deadline') or 'Ongoing'}")
    print(f"  link:     {spotlight.get('link') or '(none — channel/message id missing)'}")
    print(f"  image:    {spotlight.get('image') or '(none — UI falls back to picsum)'}")


def display_list(spotlights):
    if not spotlights:
        print("  -> [] — table has zero rows visible to this key")
        return
    for row in spotlights:
        print(
            f"  #{row.get('opportunity_id')} | {row.get('title', '(untitled)')} "
            f"| category={row.get('category')} | deadline={row.get('deadline')} "
            f"| created_at={row.get('created_at')}"
        )


def run_one(action, category, raw):
    status, data = fetch(action, category)
    print(f"[{action}] HTTP {status}")

    if raw:
        print(json.dumps(data, indent=2))
        return

    if not data.get("ok"):
        print(f"  API error: {data.get('error')}")
        return

    if action == "list":
        display_list(data.get("spotlights", []))
    else:
        display_spotlight(data.get("spotlight"))


def main():
    parser = argparse.ArgumentParser(description="CLI check for /api/spotlight")
    parser.add_argument("--action", choices=sorted(ACTIONS), default="featured")
    parser.add_argument("--category", help="restrict featured/random to one category (free text)")
    parser.add_argument("--raw", action="store_true", help="print the raw JSON response instead")
    parser.add_argument(
        "--check-all",
        action="store_true",
        help="run featured, list, and random back-to-back — fastest way to see which tier is broken",
    )
    args = parser.parse_args()

    if args.check_all:
        for action in ("featured", "list", "random"):
            run_one(action, args.category, args.raw)
            print()
        return

    run_one(args.action, args.category, args.raw)


if __name__ == "__main__":
    main()
