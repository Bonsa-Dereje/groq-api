// /api/spotlight.js — the endpoint the svelte frontend's Spotlight card
// (and its peek modal) talks to. Same shape as api/uabroad.js: the only
// place on the frontend side that touches lib/spotlightDB.js, so the
// client never sees SUPABASE_SERVICE_KEY_SPOTLIGHT/SUPABASE_SERVICE_KEY_UABROAD.
//
// GET /api/spotlight?action=featured[&category=...]
//   -> { ok:true, spotlight: {
//          title, summary, deadline, category, tags, location,
//          targetAudience, importanceLevel, image, sourceChannelName,
//          link
//        } | null }
//   Nearest-deadline spotlight_opportunities row (falling back to most
//   recently added if nothing has a future deadline). `link` is the
//   rebuilt Telegram post URL — null if the channel/message data behind
//   it isn't available. No Groq call: title/summary are already
//   human-written upstream, so this is a straight deterministic fetch.
//
// GET /api/spotlight?action=list
//   -> { ok:true, spotlights: [...] }
//   DEBUG — 10 most recent rows regardless of deadline, so you can check
//   from the browser whether spotlight_opportunities actually has data
//   action=featured's filters should be matching.

import { getFeaturedSpotlight, listRecentSpotlights } from '../lib/spotlightDB.js'

export default async function handler(req, res) {
  // Same cross-origin situation as api/uabroad.js — called straight from
  // the svelte app's browser code, not a same-origin path.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    return res.status(204).end()
  }

  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      return res.status(405).json({ ok: false, error: 'Method not allowed' })
    }

    const { action, category } = req.query

    if (action === 'featured') {
      const spotlight = await getFeaturedSpotlight(category || undefined)
      return res.status(200).json({ ok: true, spotlight })
    }

    if (action === 'list') {
      const spotlights = await listRecentSpotlights(10)
      return res.status(200).json({ ok: true, spotlights })
    }

    return res.status(400).json({ ok: false, error: `Unrecognized action: ${action}` })
  } catch (err) {
    console.error('[api/spotlight] error', err)
    return res.status(err.status || 500).json({ ok: false, error: err.message })
  }
}
