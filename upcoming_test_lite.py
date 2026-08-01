#!/usr/bin/env python3
"""
upcoming_test_lite.py
----------------------
Lite, standalone companion to alting_ua_gitactions.py -- no PyQt, no
Selenium/BeautifulSoup, no direct Supabase/Groq credentials. Just a plain
requests.get() against the same Vercel proxy the desktop app already uses
(api/uabroad.js -> lib/uabroadDB.js + lib/groqCall.js), so this script
never needs GROQ_API_KEY, SUPABASE_URL_UABROAD, or
SUPABASE_SERVICE_KEY_UABROAD locally -- only the Vercel function does.

What it does, in one call:
    GET /api/uabroad?action=upcoming-test[&category=TOEFL|IELTS|SAT|ACT]
      1. Finds the single public.test_entries row with the nearest
         upcoming registration_deadline (falling back to nearest
         test_date if nothing has an upcoming deadline), is_active=true
         only -- same query as getUpcomingTest() in lib/uabroadDB.js.
         Pass a category to pin the search to just that one test type
         instead of whichever of the four is nearest overall.
      2. Server-side, Groq is handed that row's title plus its other
         known columns (category, deadline, test_date, existing detail)
         as context and asked for a short word-capped summary --
         writeCardDetail() in lib/groqCall.js.
      3. Returns { title, content, deadline, link } -- "content" is the
         Groq summary, "title" is the test type/name.

This script just prints that out. Run it standalone, or import
fetch_upcoming_test() from another script/cron job if you want the dict
instead of stdout.

Requirements:
    pip install requests

Run:
    python3 upcoming_test_lite.py                # nearest upcoming, any type
    python3 upcoming_test_lite.py --category SAT  # nearest upcoming SAT only
"""

import sys
import argparse
import requests

# Same Vercel project/domain alting_ua_gitactions.py's TEST_ENTRIES_API_URL
# points at -- adjust if your deployment lives elsewhere.
UABROAD_API_URL = "https://groq-api-sand.vercel.app/api/uabroad"

# Matches the test_entries_test_category_check constraint in the table DDL.
VALID_CATEGORIES = {"TOEFL", "IELTS", "SAT", "ACT"}

REQUEST_TIMEOUT = 20  # seconds
MAX_ATTEMPTS = 3
RETRY_DELAY = 3.0  # seconds, flat -- this is a one-shot script, not a worker thread


def fetch_upcoming_test(category=None):
    """GETs action=upcoming-test (optionally scoped to one test type) and
    returns the {title, content, deadline, link} dict, or None if there's
    currently nothing upcoming for that scope. Raises on a hard failure
    (bad category, network error, non-ok response) after retrying a
    couple of times on transient errors, same spirit as
    alting_ua_gitactions.py's own _post_with_retry, just simplified for a
    single GET."""
    import time

    if category is not None and category not in VALID_CATEGORIES:
        raise ValueError(f"category must be one of {sorted(VALID_CATEGORIES)}, got {category!r}")

    params = {"action": "upcoming-test"}
    if category:
        params["category"] = category

    last_error = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            resp = requests.get(UABROAD_API_URL, params=params, timeout=REQUEST_TIMEOUT)
            if resp.status_code == 200:
                data = resp.json()
                if data.get("ok"):
                    return data.get("test")  # dict, or None if nothing upcoming
                raise RuntimeError(data.get("error", "Endpoint returned ok:false"))
            if resp.status_code == 429 and attempt < MAX_ATTEMPTS:
                time.sleep(RETRY_DELAY * attempt)
                continue
            raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")
        except requests.exceptions.RequestException as exc:
            last_error = exc
            if attempt < MAX_ATTEMPTS:
                time.sleep(RETRY_DELAY)
    raise RuntimeError(f"Failed to reach {UABROAD_API_URL}: {last_error}")


def main():
    parser = argparse.ArgumentParser(description="Fetch the nearest upcoming test entry + a Groq summary.")
    parser.add_argument(
        "--category",
        choices=sorted(VALID_CATEGORIES),
        default=None,
        help="Restrict to one test type (default: nearest across all four).",
    )
    args = parser.parse_args()

    try:
        test = fetch_upcoming_test(args.category)
    except (RuntimeError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)

    if not test:
        scope = args.category or "any test type"
        print(f"No upcoming test found for {scope}.")
        return

    print(f"Test:     {test.get('title', '(untitled)')}")
    print(f"Deadline: {test.get('deadline') or '(none listed)'}")
    print(f"Summary:  {test.get('content') or '(no summary)'}")
    if test.get("link"):
        print(f"Link:     {test['link']}")


if __name__ == "__main__":
    main()
