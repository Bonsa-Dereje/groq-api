// /api/scholarshipsDB.js — lives on the same Vercel project as api/chat.js,
// api/uabroad.js, and api/test-entries.js (groq-api-sand.vercel.app).
// Called by deepship4dev.py's SupabaseWriteWorker (Python `requests`, one
// row per call), the same pattern test-entries.js used for uabroadDB.js.
//
// POST { action:'write-scholarship', row: { Title, URL, ... } }
//   Upserts ONE row into public.scholarships (conflict target: url) and
//   returns { ok:true, id }.
//
// Env vars required (Vercel project settings -> Environment Variables):
//   SUPABASE_URL_UABROAD
//   SUPABASE_SERVICE_KEY_UABROAD   (service_role key — server-side only,
//                                   never expose this to the browser)

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL_UABROAD,
  process.env.SUPABASE_SERVICE_KEY_UABROAD,
  { auth: { persistSession: false } }
)

// deepship4dev.py's record dict uses the human-readable column labels
// straight out of App.COLUMNS. Map each one onto the snake_case column
// name in public.scholarships (see scholarships_schema.sql).
const COLUMN_MAP = {
  Source: 'source',
  Category: 'category',
  Title: 'title',
  Level: 'level',
  Deadline: 'deadline',
  'Study in': 'study_in',
  'Next course starts': 'next_course_starts',
  'Brief description': 'brief_description',
  'Host Institution(s)': 'host_institutions',
  'Field of study': 'field_of_study',
  'Number of Awards': 'number_of_awards',
  'Target group': 'target_group',
  'Scholarship value/inclusions/duration': 'scholarship_value',
  Eligibility: 'eligibility',
  'Application instructions': 'application_instructions',
  Website: 'website',
  'Host Country': 'host_country',
  'Degree Level': 'degree_level',
  Benefits: 'benefits',
  'Funded by': 'funded_by',
  URL: 'url',
}

function mapRow(rawRow) {
  const out = {}
  for (const [label, value] of Object.entries(rawRow || {})) {
    const col = COLUMN_MAP[label]
    if (!col) continue // ignore any field not in the schema
    out[col] = value == null ? '' : String(value)
  }
  return out
}

export default async function handler(req, res) {
  if (req.method !== 'POST' || !req.body || req.body.action !== 'write-scholarship') {
    res.setHeader('Allow', 'POST')
    return res.status(400).json({ error: 'Unrecognized action' })
  }

  const row = mapRow(req.body.row)
  if (!row.url) {
    return res.status(400).json({ error: 'row.URL is required' })
  }

  try {
    const { data, error } = await supabase
      .from('scholarships')
      .upsert(row, { onConflict: 'url' })
      .select('id')
      .single()

    if (error) throw error
    return res.status(200).json({ ok: true, id: data.id })
  } catch (err) {
    console.error('[api/scholarshipsDB] insert error', err)
    return res.status(err.status || 500).json({ error: err.message || String(err) })
  }
}
