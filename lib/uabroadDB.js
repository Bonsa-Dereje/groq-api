// lib/uabroadDB.js — every public.test_entries AND public.test_general_info
// DB call lives here so the Supabase URL/key handling exists in exactly one
// place. Imported by api/uabroad.js (the single endpoint the svelte frontend
// talks to) and by api/test-entries.js (the write path alting_ua_gitactions.py's
// SupabaseWriteWorker already hits directly — kept working, now backed
// by the same code instead of a second copy of it).
//
// test_general_info holds one static row per category (TOEFL/IELTS/SAT/ACT)
// — fees, format, test-day rules — with `content` stored as a JSON string.
// getGeneralInfo()/listGeneralInfo() parse that into a `description` object
// for the frontend, separate from the per-test-date rows in test_entries.
//
// Reads SUPABASE_URL_UABROAD / SUPABASE_SERVICE_KEY_UABROAD from env.
// The service-role key never leaves this file / whatever imports it —
// it's never sent to the client.

const TABLE = 'test_entries'
const TABLE_GENERAL_INFO = 'test_general_info'

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

function getConfig() {
  const url = process.env.SUPABASE_URL_UABROAD
  const key = process.env.SUPABASE_SERVICE_KEY_UABROAD
  if (!url || !key) {
    const err = new Error('Missing SUPABASE_URL_UABROAD or SUPABASE_SERVICE_KEY_UABROAD env vars')
    err.status = 500
    throw err
  }
  return { url, key }
}

function sbHeaders(key, extra = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra }
}

async function sbSelect(url, key, path) {
  const r = await fetch(`${url}/rest/v1/${path}`, { headers: sbHeaders(key) })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`Supabase select error: ${r.status} ${body}`)
  }
  return r.json()
}

/**
 * Debug helper — most recent rows regardless of date/active filters, so
 * you can check from the browser whether test_entries actually has data
 * that getUpcomingTest()'s filters should be matching.
 */
export async function listRecentTests(limit = 10) {
  const { url, key } = getConfig()
  const columns =
    'id,test_category,test_name,registration_deadline,test_date,is_active,created_at'
  return sbSelect(url, key, `${TABLE}?select=${columns}&order=created_at.desc&limit=${limit}`)
}

/**
 * Nearest upcoming test — prefers the soonest registration_deadline that
 * hasn't passed; falls back to the soonest test_date if nothing has an
 * upcoming deadline. is_active rows only. Returns the raw row, or null.
 *
 * `category`, if given, must be one of VALID_CATEGORIES (TOEFL/IELTS/SAT/
 * ACT) and restricts the search to just that test type instead of
 * whichever of the four is nearest overall. An invalid category throws
 * (400) rather than silently falling back to "all categories", so a
 * typo'd query param doesn't quietly return the wrong test's data.
 */
export async function getUpcomingTest(category) {
  const { url, key } = getConfig()
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const columns =
    'id,test_category,test_name,detail,registration_deadline,test_date,official_link,source_url'

  let categoryFilter = ''
  if (category !== undefined) {
    if (!VALID_CATEGORIES.has(category)) {
      const err = new Error(
        `Invalid category "${category}" — must be one of ${[...VALID_CATEGORIES].join(', ')}`,
      )
      err.status = 400
      throw err
    }
    categoryFilter = `&test_category=eq.${encodeURIComponent(category)}`
  }

  let rows = await sbSelect(
    url, key,
    `${TABLE}?select=${columns}&is_active=eq.true${categoryFilter}` +
    `&registration_deadline=gte.${today}&order=registration_deadline.asc&limit=1`,
  )
  if (rows.length) return rows[0]

  rows = await sbSelect(
    url, key,
    `${TABLE}?select=${columns}&is_active=eq.true${categoryFilter}` +
    `&test_date=gte.${today}&order=test_date.asc&limit=1`,
  )
  return rows[0] || null
}

/**
 * test_general_info.content is stored as a JSON string (see the seed
 * INSERTs — registration fees, section breakdowns, etc per category).
 * Parses it into an object for 'description'; if a row's content isn't
 * valid JSON for some reason, falls back to the raw string rather than
 * throwing, so one bad row can't take down the whole response.
 */
function parseGeneralInfoRow(row) {
  if (!row) return null
  let description = row.content
  if (typeof row.content === 'string') {
    try {
      description = JSON.parse(row.content)
    } catch {
      description = row.content
    }
  }
  return { ...row, description }
}

/**
 * Static/general info for one test category (fees, format, test-day
 * rules, ...) from test_general_info — one row per category, content
 * parsed into `description`. Returns null if there's no row yet for
 * that category. Throws (400) on an invalid category, same as
 * getUpcomingTest().
 */
export async function getGeneralInfo(category) {
  if (!VALID_CATEGORIES.has(category)) {
    const err = new Error(
      `Invalid category "${category}" — must be one of ${[...VALID_CATEGORIES].join(', ')}`,
    )
    err.status = 400
    throw err
  }

  const { url, key } = getConfig()
  const columns = 'id,test_category,label,content,source_url,fetch_timestamp'
  const rows = await sbSelect(
    url, key,
    `${TABLE_GENERAL_INFO}?select=${columns}&test_category=eq.${encodeURIComponent(category)}&limit=1`,
  )
  return parseGeneralInfoRow(rows[0]) || null
}

/**
 * All four categories' general info in one call (for a page that wants
 * to show fees/format for every test type at once, e.g. the upcoming-
 * tests modal). Returns { TOEFL: {...}|null, IELTS: {...}|null, ... }.
 */
export async function listGeneralInfo() {
  const { url, key } = getConfig()
  const columns = 'id,test_category,label,content,source_url,fetch_timestamp'
  const rows = await sbSelect(url, key, `${TABLE_GENERAL_INFO}?select=${columns}`)

  const byCategory = {}
  for (const category of VALID_CATEGORIES) byCategory[category] = null
  for (const row of rows) byCategory[row.test_category] = parseGeneralInfoRow(row)
  return byCategory
}

/**
 * Sanitizes an arbitrary row payload down to the real, writable
 * test_entries columns, validating test_category/mode against the same
 * values the table's own CHECK constraints allow. Anything not in
 * ALLOWED_FIELDS is silently dropped rather than forwarded to Supabase.
 * Returns null if the row is unusable (missing/bad test_category).
 */
export function sanitizeRow(input) {
  if (!input || typeof input !== 'object') return null
  if (!VALID_CATEGORIES.has(input.test_category)) return null

  const row = {}
  for (const field of ALLOWED_FIELDS) {
    if (input[field] !== undefined) row[field] = input[field]
  }
  if (row.mode !== undefined && !VALID_MODES.has(row.mode)) row.mode = ''
  return row
}

/** Inserts one sanitized row into test_entries. Returns the inserted id. */
export async function insertTestEntry(input) {
  const row = sanitizeRow(input)
  if (!row) {
    const err = new Error('row.test_category is required and must be one of TOEFL, IELTS, SAT, ACT')
    err.status = 400
    throw err
  }

  const { url, key } = getConfig()
  const r = await fetch(`${url}/rest/v1/${TABLE}`, {
    method: 'POST',
    headers: sbHeaders(key, { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`Supabase insert error: ${r.status} ${body}`)
  }
  const [inserted] = await r.json()
  return inserted && inserted.id
}

export { VALID_CATEGORIES, VALID_MODES, ALLOWED_FIELDS }
// getGeneralInfo, listGeneralInfo already exported above via `export async function`.