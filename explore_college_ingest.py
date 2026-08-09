#!/usr/bin/env python3
"""
explore_college_ingest.py

Calls the /api/explore-college-ingest endpoint once per college, in
ascending college_id order, up to --limit times per run. All Supabase and
YouTube credentials now live server-side in that endpoint's Vercel env —
this script only needs the endpoint URL and a shared secret, the same way
_page.svelte talks to /api/explore-college without holding any keys itself.

Auto-resume: the FIRST call of a run omits start_id, so the endpoint
figures out where to resume from MAX(college_id) already in
explore_colleges. Every call after that passes start_id explicitly
(previous college_id + 1) since the script already knows it — no need to
ask the endpoint to look it up again each time.

NOTE: the shared-secret check has been removed on the endpoint side for
now while testing locally, so this script no longer sends one either.
Add it back on both sides before this is public-facing.

Usage:
  python explore_college_ingest.py                 # normal daily run, auto-resumes
  python explore_college_ingest.py --start-id 200   # force a specific starting college_id
  python explore_college_ingest.py --limit 50       # override the daily cap
  python explore_college_ingest.py --dry-run        # search + print only, no writes
"""

import argparse
import sys
import time

import requests

DAILY_LIMIT_DEFAULT = 100
REQUEST_DELAY_SECONDS = 1.0  # be polite between calls to the endpoint

# Same Vercel project _page.svelte's UABROAD_API_BASE points at.
UABROAD_API_BASE = "https://groq-api-sand.vercel.app"
INGEST_ENDPOINT_URL = f"{UABROAD_API_BASE}/api/explore-college-ingest"


def call_ingest_endpoint(start_id=None, dry_run=False):
    """One call = one college processed by the endpoint. start_id=None lets
    the endpoint auto-resume from MAX(college_id) in explore_colleges."""
    params = {}
    if start_id is not None:
        params["start_id"] = start_id
    if dry_run:
        params["dry_run"] = "1"

    r = requests.get(INGEST_ENDPOINT_URL, params=params, timeout=30)
    if not r.ok:
        print(f"  Response body: {r.text}")
    r.raise_for_status()
    return r.json()


def main():
    parser = argparse.ArgumentParser(
        description="Ingest YouTube campus-tour links via the explore-college-ingest endpoint, 100/day."
    )
    parser.add_argument(
        "--start-id",
        type=int,
        default=None,
        help="Force a starting college_id instead of letting the endpoint auto-resume.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=DAILY_LIMIT_DEFAULT,
        help=f"Max colleges to process this run (default {DAILY_LIMIT_DEFAULT}).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Search YouTube and print results but don't write to Supabase.",
    )
    args = parser.parse_args()

    # None on the first call => endpoint auto-resumes from MAX(college_id)+1.
    # After that we always pass it explicitly since we already know it.
    next_start_id = args.start_id
    processed = 0

    print(f"Calling {INGEST_ENDPOINT_URL} for up to {args.limit} colleges...")


    for _ in range(args.limit):
        try:
            result = call_ingest_endpoint(start_id=next_start_id, dry_run=args.dry_run)
        except requests.HTTPError as e:
            print(f"Endpoint error: {e}")
            print("Stopping run here so this college_id isn't skipped tomorrow.")
            break
        except Exception as e:
            print(f"Unexpected error calling endpoint: {e}")
            break

        if result.get("done"):
            print("No more colleges to process.")
            break

        college_id = result["college_id"]
        name = result["collegeName"]
        youtube_link = result.get("youtube_link")

        print(f"[{processed + 1}/{args.limit}] college_id={college_id} — {name}")
        if youtube_link:
            print(f"  -> {youtube_link}")
        else:
            print("  -> no embeddable video found, stored null link so it isn't retried forever")

        processed += 1
        next_start_id = college_id + 1

        time.sleep(REQUEST_DELAY_SECONDS)

    print(f"Done. Processed {processed} colleges this run.")


if __name__ == "__main__":
    main()