// /api/uabroad.js — the ONE endpoint the svelte frontend talks to for
// anything test-related. This is the only place on the frontend side
// that touches lib/uabroadDB.js (Supabase) and lib/groqCall.js (Groq) —
// the client only ever needs to know this single URL, and never sees
// SUPABASE_SERVICE_KEY_UABROAD or GROQ_API_KEY.
//
// GET /api/uabroad?action=upcoming-test
//   -> { ok:true, test: { title, content, deadline, link } | null }
//   Nearest upcoming test_entries row (by registration_deadline, falling
//   back to test_date) plus a Groq-written, word-capped "detail" blurb
//   sized for the Upcoming-tests card.
//
// POST /api/uabroad   { action:'write-test-entry', row }
//   -> { ok:true, id }
//   Inserts one row into test_entries (allowlisted columns only, same
//   validation as the old api/test-entries.js). Room for the svelte app
//   to write rows too, without needing a second endpoint.
//
// POST /api/uabroad   { action:'write-detail', title, context?, wordLimit? }
//   -> { ok:true, detail }
//   Generic "ask Groq for a card blurb" action — for any future card
//   (Spotlight, etc.) that wants the same word-capped AI writeup without
//   a dedicated Supabase row driving it.
//
// Add new actions here as new cards/features need them, rather than
// adding new files — keep the DB/Groq logic itself in lib/uabroadDB.js
// and lib/groqCall.js so it stays reusable and testable on its own.

import { getUpcomingTest, insertTestEntry } from '../lib/uabroadDB.js'
import { writeCardDetail } from '../lib/groqCall.js'

const DETAIL_WORD_LIMIT = 30

export default async function handler(req, res) {
  // Called cross-origin, straight from the svelte app's browser code
  // (fetch('https://groq-api-sand.vercel.app/api/uabroad?...')) rather
  // than from a same-origin path, so it needs its own CORS headers.
  // Tighten origin below to the svelte app's real domain once it's live
  // on one instead of leaving this wide open.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    return res.status(204).end()
  }

  try {
    if (req.method === 'GET') return await handleGet(req, res)
    if (req.method === 'POST') return await handlePost(req, res)
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  } catch (err) {
    console.error('[api/uabroad] error', err)
    return res.status(err.status || 500).json({ ok: false, error: err.message })
  }
}

async function handleGet(req, res) {
  const { action } = req.query

  if (action === 'upcoming-test') {
    const row = await getUpcomingTest()
    if (!row) return res.status(200).json({ ok: true, test: null })

    const title = row.test_name || `${row.test_category} test`
    const context = [
      row.test_category ? `Test category: ${row.test_category}` : null,
      row.registration_deadline ? `Registration deadline: ${row.registration_deadline}` : null,
      row.test_date ? `Test date: ${row.test_date}` : null,
      row.detail ? `Known detail: ${row.detail}` : null,
    ].filter(Boolean).join('\n')

    const content = await writeCardDetail(title, context, DETAIL_WORD_LIMIT)

    return res.status(200).json({
      ok: true,
      test: {
        title,
        content,
        deadline: row.registration_deadline || row.test_date || null,
        link: row.official_link || row.source_url || null,
      },
    })
  }

  return res.status(400).json({ ok: false, error: `Unrecognized action: ${action}` })
}

async function handlePost(req, res) {
  const { action } = req.body || {}

  if (action === 'write-test-entry') {
    const id = await insertTestEntry(req.body.row)
    return res.status(200).json({ ok: true, id })
  }

  if (action === 'write-detail') {
    const { title, context, wordLimit } = req.body
    if (!title) return res.status(400).json({ ok: false, error: 'title is required' })
    const detail = await writeCardDetail(title, context || '', wordLimit || DETAIL_WORD_LIMIT)
    return res.status(200).json({ ok: true, detail })
  }

  return res.status(400).json({ ok: false, error: `Unrecognized action: ${action}` })
}
