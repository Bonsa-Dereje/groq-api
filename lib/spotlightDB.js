// lib/spotlightDB.js — every public.channels / public.raw_posts /
// public.spotlight_opportunities read lives here, same one-file-per-
// domain pattern as lib/uabroadDB.js. Imported by api/spotlight.js.
//
// spotlight_opportunities is the row the card actually shows — a
// distilled, human-readable record (title/summary/category/tags/...)
// produced upstream from a raw_posts row. channels and raw_posts only
// get touched here to rebuild the original Telegram post link
// (channel_username + message_id), pulled via PostgREST's foreign-key
// embedding in the same request rather than two extra round trips.
//
// Reads SUPABASE_URL_SPOTLIGHT / SUPABASE_SERVICE_KEY_SPOTLIGHT if set,
// else falls back to SUPABASE_URL_UABROAD / SUPABASE_SERVICE_KEY_UABROAD.
// Only set the _SPOTLIGHT vars if this data actually lives in a
// different Supabase project than the test tables — if it's the same
// project, the fallback means you don't need to duplicate anything.

const TABLE = 'spotlight_opportunities'

function getConfig() {
  const url = process.env.SUPABASE_URL_SPOTLIGHT || process.env.SUPABASE_URL_UABROAD
  const key = process.env.SUPABASE_SERVICE_KEY_SPOTLIGHT || process.env.SUPABASE_SERVICE_KEY_UABROAD
  if (!url || !key) {
    const err = new Error(
      'Missing SUPABASE_URL_SPOTLIGHT/SUPABASE_URL_UABROAD or the matching service key env var',
    )
    err.status = 500
    throw err
  }
  return { url, key }
}

function sbHeaders(key) {
  return { apikey: key, Authorization: `Bearer ${key}` }
}

async function sbSelect(url, key, path) {
  const r = await fetch(`${url}/rest/v1/${path}`, { headers: sbHeaders(key) })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`Supabase select error: ${r.status} ${body}`)
  }
  return r.json()
}

// spotlight_opportunities columns + a nested embed of raw_posts (via the
// raw_post_id FK) and, inside that, channels (via raw_posts.channel_id) —
// one request instead of three.
const COLUMNS =
  'opportunity_id,title,summary,category,tags,deadline,location,target_audience,' +
  'importance_level,image_url,source_channel_name,' +
  'raw_posts(message_id,channels(channel_username))'

function buildTelegramLink(row) {
  const username = row?.raw_posts?.channels?.channel_username
  const messageId = row?.raw_posts?.message_id
  if (!username || !messageId) return null
  return `https://t.me/${username}/${messageId}`
}

function parseSpotlightRow(row) {
  if (!row) return null
  return {
    id: row.opportunity_id,
    title: row.title,
    summary: row.summary,
    category: row.category,
    tags: Array.isArray(row.tags) ? row.tags : [],
    deadline: row.deadline,
    location: row.location,
    targetAudience: row.target_audience,
    importanceLevel: row.importance_level,
    image: row.image_url,
    sourceChannelName: row.source_channel_name,
    link: buildTelegramLink(row),
  }
}

/**
 * The featured spotlight — nearest upcoming deadline first, falling
 * back to the most recently added opportunity if nothing has a future
 * deadline (same two-step pattern as uabroadDB.js's getUpcomingTest).
 *
 * `category` is free text on this table (unlike test_entries' 4 fixed
 * values), so an unrecognized value just yields no results rather than
 * throwing a 400 — there's no fixed allowlist to validate against.
 */
export async function getFeaturedSpotlight(category) {
  const { url, key } = getConfig()
  const now = new Date().toISOString()
  const categoryFilter = category ? `&category=eq.${encodeURIComponent(category)}` : ''

  let rows = await sbSelect(
    url, key,
    `${TABLE}?select=${COLUMNS}${categoryFilter}` +
    `&deadline=gte.${now}&order=deadline.asc&limit=1`,
  )
  if (!rows.length) {
    rows = await sbSelect(
      url, key,
      `${TABLE}?select=${COLUMNS}${categoryFilter}&order=created_at.desc&limit=1`,
    )
  }
  return parseSpotlightRow(rows[0])
}

/**
 * Debug helper — most recent rows regardless of deadline, so you can
 * check from the browser whether spotlight_opportunities actually has
 * data getFeaturedSpotlight()'s filters should be matching.
 */
export async function listRecentSpotlights(limit = 10) {
  const { url, key } = getConfig()
  const columns = 'opportunity_id,title,category,deadline,created_at'
  return sbSelect(url, key, `${TABLE}?select=${columns}&order=created_at.desc&limit=${limit}`)
}
