// /api/test-entries.js — lives on the same Vercel project as api/chat.js
// and api/uabroad.js. Called by alting_ua_gitactions.py's
// SupabaseWriteWorker (Python `requests`, one row per call, same way
// call_groq() hits /api/chat).
//
// The actual DB logic now lives in lib/uabroadDB.js (shared with
// api/uabroad.js, the endpoint the svelte frontend uses) so there's one
// copy of the insert/validation code instead of two that can drift apart.
// This file just stays around as a stable URL for the desktop app —
// point alting_ua_gitactions.py's TEST_ENTRIES_API_URL at
// /api/uabroad with { action:'write-test-entry', row } instead, whenever
// it's convenient to update, and this file can go away.
//
// POST { action:'write-test-entry', row: { test_category, ... } }
//   Inserts ONE row into public.test_entries and returns { ok:true, id }.

import { insertTestEntry } from '../lib/uabroadDB.js'

export default async function handler(req, res) {
  if (req.method !== 'POST' || !req.body || req.body.action !== 'write-test-entry') {
    res.setHeader('Allow', 'POST')
    return res.status(400).json({ error: 'Unrecognized action' })
  }

  try {
    const id = await insertTestEntry(req.body.row)
    return res.status(200).json({ ok: true, id })
  } catch (err) {
    console.error('[api/test-entries] insert error', err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}
