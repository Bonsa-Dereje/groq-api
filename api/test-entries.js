// /api/test-entries.js — lives on the same Vercel project as api/chat.js
// and api/benchy.js. Uses the SUPABASE_URL_UABROAD / SUPABASE_SERVICE_KEY_UABROAD
// env vars on this project. Called by alting_ua_gitactions.py's
// SupabaseWriteWorker (Python `requests`, one row per call, same way
// call_groq() hits /api/chat) — the service-role key stays server-side and
// is never returned to whatever is calling this endpoint.
//
// POST { action:'write-test-entry', row: { test_category, ... } }
//   Inserts ONE row into public.test_entries and returns { ok:true, id }.
//   - Only inserts (no SELECT/UPDATE/DELETE exposed here), so a leaked
//     call to this endpoint can add junk rows at worst, not read or wipe
//     the table.
//   - `row` is passed through an allowlist of the table's real columns —
//     anything else in the payload is silently dropped rather than
//     forwarded to Supabase, so this can't be turned into an arbitrary
//     column-injection endpoint.
//   - test_category and mode are validated against the same values the
//     table's own CHECK constraints allow, so a bad row 400s here instead
//     of failing (or being coerced) at the DB.

const VALID_CATEGORIES = new Set(['TOEFL', 'IELTS', 'SAT', 'ACT'])
const VALID_MODES = new Set(['Online', 'In-person', ''])

// Exactly the writable columns on public.test_entries (id/created_at/
// updated_at/fetch_timestamp are left to their DB defaults).
const ALLOWED_FIELDS = [
  'test_category', 'test_name', 'detail', 'registration_deadline', 'test_date',
  'test_time', 'speaking_date', 'speaking_time', 'speaking_included_in_price',
  'location', 'location_link', 'test_center', 'official_link', 'is_paid',
  'payment_info', 'mode', 'notes', 'source_url', 'is_active',
]

export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL_UABROAD
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY_UABROAD

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({
      error: 'Server is missing SUPABASE_URL_UABROAD or SUPABASE_SERVICE_KEY_UABROAD env vars',
    })
  }

  if (req.method !== 'POST' || !req.body || req.body.action !== 'write-test-entry') {
    res.setHeader('Allow', 'POST')
    return res.status(400).json({ error: 'Unrecognized action' })
  }

  const row = sanitizeRow(req.body.row)
  if (!row) {
    return res.status(400).json({
      error: 'row.test_category is required and must be one of TOEFL, IELTS, SAT, ACT',
    })
  }

  const sbHeaders = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  }

  try {
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/test_entries`, {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify(row),
    })
    if (!insertRes.ok) {
      const errBody = await insertRes.text().catch(() => '')
      throw new Error(`Supabase error inserting row: ${insertRes.status} ${errBody}`)
    }
    const [inserted] = await insertRes.json()
    return res.status(200).json({ ok: true, id: inserted && inserted.id })
  } catch (err) {
    console.error('[api/test-entries] insert error', err)
    return res.status(500).json({ error: 'Failed to write entry', detail: err.message })
  }
}

function sanitizeRow(input) {
  if (!input || typeof input !== 'object') return null
  if (!VALID_CATEGORIES.has(input.test_category)) return null

  const row = {}
  for (const field of ALLOWED_FIELDS) {
    if (input[field] !== undefined) row[field] = input[field]
  }
  if (row.mode !== undefined && !VALID_MODES.has(row.mode)) row.mode = ''
  return row
}
