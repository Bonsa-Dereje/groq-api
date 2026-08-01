#!/usr/bin/env python3
"""
uabroad_cli.py — quick CLI check of GET /api/uabroad?action=upcoming-test

Prints what the dashboard card would show: title, then the Groq blurb
concatenated with the 2 deterministic "normie" facts pulled straight off
test_general_info (never touched by the model — same numbers/wording as
the DB row), then deadline / link / link-preview.

Usage:
    python3 uabroad_cli.py                 # nearest test across all 4 types
    python3 uabroad_cli.py --category SAT  # nearest SAT specifically
    python3 uabroad_cli.py --raw           # dump the raw JSON instead
"""

import argparse
import json
import sys
import urllib.error
import urllib.request

API_BASE = "https://groq-api-sand.vercel.app"
CATEGORIES = {"TOEFL", "IELTS", "SAT", "ACT"}


def fetch_upcoming_test(category=None):
    url = f"{API_BASE}/api/uabroad?action=upcoming-test"
    if category:
        url += f"&category={category}"

    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        print(f"HTTP {e.code}: {body}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Request failed: {e.reason}", file=sys.stderr)
        sys.exit(1)


def display_text(test):
    """Groq's card blurb + the deterministic general_info tags, joined
    into one line — the same "content + normie details" combo the card
    renders, just flattened to plain text for the terminal."""
    parts = [test.get("content", "").strip()]
    for tag in test.get("tags", []) or []:
        parts.append(f"{tag['label']}: {tag['value']}")
    return " — ".join(p for p in parts if p)


def main():
    parser = argparse.ArgumentParser(description="CLI check for /api/uabroad upcoming-test")
    parser.add_argument("--category", choices=sorted(CATEGORIES), help="restrict to one test type")
    parser.add_argument("--raw", action="store_true", help="print the raw JSON response instead")
    args = parser.parse_args()

    data = fetch_upcoming_test(args.category)

    if args.raw:
        print(json.dumps(data, indent=2))
        return

    if not data.get("ok"):
        print(f"API error: {data.get('error')}", file=sys.stderr)
        sys.exit(1)

    test = data.get("test")
    if not test:
        print("No upcoming test found.")
        return

    print(test.get("title", "(untitled)"))
    print(display_text(test))

    if test.get("deadline"):
        print(f"Deadline: {test['deadline']}")
    if test.get("link"):
        print(f"Link: {test['link']}")
    if test.get("linkPreview"):
        lp = test["linkPreview"]
        print(f"Preview: {lp['siteName']} — {lp['description']}")


if __name__ == "__main__":
    main()
