// /api/uabroad.js — the ONE endpoint the svelte frontend talks to for
// anything test-related. This is the only place on the frontend side
// that touches lib/uabroadDB.js (Supabase) and lib/groqCall.js (Groq) —
// the client only ever needs to know this single URL, and never sees
// SUPABASE_SERVICE_KEY_UABROAD or GROQ_API_KEY.
//
// GET /api/uabroad?action=upcoming-test[&category=TOEFL|IELTS|SAT|ACT]
//   -> { ok:true, test: { title, content, deadline, link } | null }
//   Nearest upcoming test_entries row (by registration_deadline, falling
//   back to test_date) plus a Groq-written, word-capped "detail" blurb
//   sized for the Upcoming-tests card. Omit `category` for the nearest
//   test across all four types; pass it to pin the search to just one
//   test type. An unrecognized category returns a 400.
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
// GET /api/uabroad?action=explore-college[&fresh=1]
//   -> { ok:true, college: { collegeId, name, videoId, videoTitle,
//        channelTitle, watchUrl, embedUrl, websiteUrl, image } | null, steps }
//   Formerly its own file (api/explore-college.js) — folded in here since
//   it's just another read-only "give the frontend one card's worth of
//   data" action, same shape as everything else on this endpoint, and one
//   less serverless function to deploy/monitor.
//     1. Picks one random row out of the new "explore_colleges" table
//        (college_id, youtube_link), joined to "collegeData" for the
//        name — this REPLACES the old YouTube search.list + videos.list
//        (embeddable check) calls entirely. The link pool is curated up
//        front in Supabase, so there's no quota spend and no "is this
//        even embeddable" step left to do — YOUTUBE_API_KEY is no longer
//        used anywhere in this project and can be removed from Vercel's
//        env vars if nothing else references it.
//     2. Video title / uploader name (for the "via {channelTitle}" caption)
//        come from YouTube's public oEmbed endpoint — keyless, no quota,
//        just a lookup keyed on the watch URL.
//     3. Official site (Wikidata P856) and the random college image
//        (Storage bucket walk) are unchanged from the old file.
//   Same 45s warm-lambda cache + `?fresh=1` bypass + step-by-step `steps`
//   trace as the old api/explore-college.js, kept for the frontend's
//   existing debug rendering.
//
// Add new actions here as new cards/features need them, rather than
// adding new files — keep the DB/Groq logic itself in lib/uabroadDB.js
// and lib/groqCall.js so it stays reusable and testable on its own.
// (The explore-college helpers below talk to Supabase directly via REST,
// same as the old standalone file did, rather than going through
// lib/uabroadDB.js — move them there later if it's worth the churn.)

import {
  getUpcomingTest,
  getGeneralInfo,
  pickGeneralInfoHighlights,
  insertTestEntry,
  listRecentTests,
} from '../lib/uabroadDB.js'
import { writeCardDetail } from '../lib/groqCall.js'

const DETAIL_WORD_LIMIT = 30

// --- explore-college (formerly api/explore-college.js) ---------------
// Cheap in-memory cache (module scope) so a burst of card-flips on a warm
// lambda doesn't re-hit Supabase + oEmbed + Storage every time. Not a
// durable cache (cold starts wipe it) — just a courtesy dedupe, same as
// the "upcoming-test" path doesn't bother with since it's cheap already.
let exploreCache = { college: null, expiresAt: 0 }
const EXPLORE_CACHE_TTL_MS = 45_000

// Priority order for the image folders inside each college's Storage
// directory. First folder that actually has files in it wins.
const IMAGE_FOLDER_PRIORITY = ['building', 'scenery', 'classroom', 'other']
const IMAGES_BUCKET = 'college_images'

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

/**
 * Telegram-style compact link preview for the card's official/source
 * link: site name + a short description, plus a small image on the
 * right. There's no page-scraping step here (no extra fetch, nothing
 * that can time out) — the image is the site's favicon (Google's public
 * favicon endpoint, keyless) and the description is general_info's own
 * `label` for that category, so it's exact, deterministic, and free.
 * Returns null when there's no link to preview (nothing for the
 * frontend to render).
 */
function buildLinkPreview(url, generalInfo) {
  if (!url) return null

  let siteName
  try {
    siteName = new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null // malformed official_link/source_url — skip the preview rather than throw
  }

  return {
    url,
    siteName,
    image: `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(siteName)}`,
    description: generalInfo?.label || siteName,
  }
}

async function handleGet(req, res) {
  const { action, category } = req.query

  if (action === 'upcoming-test') {
    const row = await getUpcomingTest(category || undefined)
    if (!row) return res.status(200).json({ ok: true, test: null })

    const title = row.test_name || `${row.test_category} test`
    const context = [
      row.test_category ? `Test category: ${row.test_category}` : null,
      row.registration_deadline ? `Registration deadline: ${row.registration_deadline}` : null,
      row.test_date ? `Test date: ${row.test_date}` : null,
      row.detail ? `Known detail: ${row.detail}` : null,
    ].filter(Boolean).join('\n')

    // Groq's blurb and the general-info row are independent of each
    // other — fire them together instead of waiting on one before
    // starting the other. A general-info lookup failure shouldn't sink
    // the whole card (it just means no tags/link-preview description),
    // so it's caught locally rather than propagating to the outer catch.
    const [content, generalInfo] = await Promise.all([
      writeCardDetail(title, context, DETAIL_WORD_LIMIT),
      getGeneralInfo(row.test_category).catch((err) => {
        console.error('[api/uabroad] getGeneralInfo failed', err)
        return null
      }),
    ])

    // Deterministic — not Groq-written — so these two facts always match
    // exactly what's stored in test_general_info.content.
    const tags = pickGeneralInfoHighlights(generalInfo, 2)
    const link = row.official_link || row.source_url || null

    return res.status(200).json({
      ok: true,
      test: {
        title,
        content,
        deadline: row.registration_deadline || row.test_date || null,
        link,
        tags,
        linkPreview: buildLinkPreview(link, generalInfo),
      },
    })
  }

  if (action === 'explore-college') return await handleExploreCollege(req, res)

  // DEBUG: https://groq-api-sand.vercel.app/api/uabroad?action=list-tests
  // Shows the 10 most recent rows regardless of date/is_active, so you
  // can check straight from a browser whether the table actually has
  // data that getUpcomingTest()'s filters (is_active=true AND a future
  // registration_deadline or test_date) should be matching.
  if (action === 'list-tests') {
    const tests = await listRecentTests(10)
    return res.status(200).json({ ok: true, tests })
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

// --- explore-college -------------------------------------------------
// Same "steps" trace pattern as the old standalone handler, since the
// svelte frontend already folds `data.steps` into its own debug list —
// keeping the shape identical meant zero changes on that side beyond the
// URL it calls.
async function handleExploreCollege(req, res) {
  const steps = []

  const SUPABASE_URL = process.env.SUPABASE_URL_UABROAD
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY_UABROAD

  const envOk = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY)
  steps.push({
    step: 'env_check',
    status: envOk ? 'ok' : 'error',
    detail: envOk
      ? 'SUPABASE_URL_UABROAD, SUPABASE_SERVICE_KEY_UABROAD both present'
      : `Missing: ${[
          !SUPABASE_URL && 'SUPABASE_URL_UABROAD',
          !SUPABASE_SERVICE_KEY && 'SUPABASE_SERVICE_KEY_UABROAD',
        ].filter(Boolean).join(', ')}`,
  })
  if (!envOk) {
    return res.status(500).json({
      ok: false,
      error: 'Server is missing SUPABASE_URL_UABROAD or SUPABASE_SERVICE_KEY_UABROAD env vars',
      steps,
    })
  }

  const fresh = req.query?.fresh === '1'
  if (!fresh && exploreCache.college && Date.now() < exploreCache.expiresAt) {
    steps.push({ step: 'cache', status: 'ok', detail: 'Served from warm-lambda cache, skipped Supabase + oEmbed + Storage' })
    return res.status(200).json({ ok: true, college: exploreCache.college, steps })
  }
  steps.push({ step: 'cache', status: 'miss', detail: fresh ? 'Bypassed with &fresh=1' : 'No warm cache entry (cold start or expired)' })

  // --- Step: pick a random row out of explore_colleges ------------------
  let row
  try {
    row = await fetchRandomExploreCollege(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  } catch (err) {
    console.error('[api/uabroad] explore_colleges error', err)
    steps.push({ step: 'fetch_college', status: 'error', detail: err.message })
    return res.status(500).json({ ok: false, error: 'Failed to query explore_colleges', detail: err.message, steps })
  }
  if (!row) {
    steps.push({ step: 'fetch_college', status: 'empty', detail: 'explore_colleges query returned 0 usable rows (joined collegeData name missing, or table empty)' })
    return res.status(200).json({ ok: true, college: null, steps })
  }
  steps.push({
    step: 'fetch_college',
    status: 'ok',
    detail: `Picked "${row.name}" (college_id ${row.collegeId}) — youtube_link: ${row.youtubeLink}`,
  })

  // --- Step: pull the video id out of the pooled link --------------------
  const videoId = extractYouTubeId(row.youtubeLink)
  if (!videoId) {
    steps.push({ step: 'parse_video_id', status: 'error', detail: `Could not parse a video id out of "${row.youtubeLink}"` })
    return res.status(200).json({ ok: true, college: null, steps })
  }
  steps.push({ step: 'parse_video_id', status: 'ok', detail: `videoId=${videoId}` })

  // --- Step: title / uploader name via oEmbed (free, keyless) -----------
  // No embeddable check here on purpose — the pool in explore_colleges is
  // curated up front, so unlike the old YouTube-search path there's no
  // "is this even embeddable" question left to answer. A failed oEmbed
  // lookup just means no caption text; it doesn't sink the card.
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`
  let oembed
  try {
    oembed = await fetchOEmbedInfo(watchUrl)
  } catch (err) {
    console.error('[api/uabroad] oEmbed lookup error', err)
    oembed = null
  }
  if (oembed) {
    steps.push({ step: 'oembed', status: 'ok', detail: `"${oembed.title}" (${oembed.channelTitle})` })
  } else {
    steps.push({ step: 'oembed', status: 'empty', detail: 'oEmbed lookup failed or returned nothing — caption/title will be blank' })
  }

  // --- Step: resolve the official university site (Wikidata) ------------
  let websiteUrl
  try {
    websiteUrl = await lookupOfficialSite(row.name)
  } catch (err) {
    console.error('[api/uabroad] Wikidata lookup error', err)
    websiteUrl = null
  }
  steps.push(
    websiteUrl
      ? { step: 'official_site', status: 'ok', detail: `Resolved via Wikidata: ${websiteUrl}` }
      : { step: 'official_site', status: 'empty', detail: 'No Wikidata P856 claim found for this college — frontend hides the "Go to site" button' }
  )

  // --- Step: pick a random image from Storage ----------------------------
  let image
  try {
    image = await pickCollegeImage(row.collegeId, SUPABASE_URL, SUPABASE_SERVICE_KEY)
  } catch (err) {
    console.error('[api/uabroad] Storage image lookup error', err)
    steps.push({ step: 'fetch_image', status: 'error', detail: err.message })
    image = null
  }
  if (image) {
    steps.push({ step: 'fetch_image', status: 'ok', detail: `Picked "${image.path}" from "${image.folder}" folder` })
  } else if (!steps.some((s) => s.step === 'fetch_image')) {
    steps.push({ step: 'fetch_image', status: 'empty', detail: `No files found in any of ${IMAGE_FOLDER_PRIORITY.join(', ')} for college_id ${row.collegeId}` })
  }

  // --- Assemble ------------------------------------------------------------
  const college = {
    collegeId: row.collegeId,
    name: row.name,
    videoId,
    videoTitle: oembed?.title || null,
    channelTitle: oembed?.channelTitle || null,
    watchUrl,
    embedUrl: `https://www.youtube.com/embed/${videoId}`,
    websiteUrl,
    image,
  }

  exploreCache = { college, expiresAt: Date.now() + EXPLORE_CACHE_TTL_MS }
  steps.push({ step: 'done', status: 'ok', detail: 'College + pooled video + image assembled and cached' })

  return res.status(200).json({ ok: true, college, steps })
}

// Picks one random row out of explore_colleges, embedding collegeData for
// the name via PostgREST's foreign-key embed (explore_colleges.college_id
// -> collegeData.college_id). Same "pull a page, pick client-side" pattern
// the old fetchRandomCollege() used, rather than trying to get Postgres to
// order by random() through PostgREST.
async function fetchRandomExploreCollege(SUPABASE_URL, SUPABASE_SERVICE_KEY) {
  const sbHeaders = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  }

  const url =
    `${SUPABASE_URL}/rest/v1/explore_colleges` +
    `?select=college_id,youtube_link,collegeData(collegeName)` +
    `&youtube_link=not.is.null` +
    `&limit=1000`

  const r = await fetch(url, { headers: sbHeaders })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`Supabase error selecting explore_colleges: ${r.status} ${body}`)
  }
  const rows = await r.json()
  // Rows whose FK target got deleted (or whose collegeName is null) don't
  // make a usable card — filter those out before picking.
  const usable = (rows || []).filter((row) => row?.collegeData?.collegeName)
  if (!usable.length) return null

  const pick = usable[Math.floor(Math.random() * usable.length)]
  return {
    collegeId: pick.college_id,
    name: pick.collegeData.collegeName,
    youtubeLink: pick.youtube_link,
  }
}

// Pulls a YouTube video id out of any of the common link shapes the pool
// might contain: watch?v=, youtu.be/, /embed/, /shorts/ — with or without
// extra query params (timestamps, playlist refs, etc.) tacked on.
function extractYouTubeId(link) {
  if (!link) return null
  try {
    const u = new URL(link)
    if (u.hostname.replace(/^www\./, '') === 'youtu.be') {
      return u.pathname.slice(1).split('/')[0] || null
    }
    if (u.searchParams.get('v')) return u.searchParams.get('v')
    const match = u.pathname.match(/\/(embed|shorts)\/([^/?]+)/)
    if (match) return match[2]
    return null
  } catch {
    return null // malformed youtube_link — treat as unusable rather than throw
  }
}

// YouTube's public oEmbed endpoint — keyless, no quota, no OAuth. Given a
// normal watch URL, returns { title, channelTitle } or null if the video
// is gone/private/otherwise not oEmbed-able.
async function fetchOEmbedInfo(watchUrl) {
  const params = new URLSearchParams({ url: watchUrl, format: 'json' })
  const r = await fetch(`https://www.youtube.com/oembed?${params.toString()}`)
  if (!r.ok) return null
  const data = await r.json()
  return { title: data.title || '', channelTitle: data.author_name || '' }
}

// Looks the school up on Wikidata and returns its P856 "official website"
// claim, or null if nothing matches. Two calls, both keyless/free:
//   1. wbsearchentities — fuzzy name match -> best entity id (Q-number)
//   2. wbgetclaims       -> P856 value off that entity, if it has one
async function lookupOfficialSite(collegeName) {
  const searchParams = new URLSearchParams({
    action: 'wbsearchentities',
    search: collegeName,
    language: 'en',
    format: 'json',
    type: 'item',
    limit: '1',
  })
  const searchRes = await fetch(`https://www.wikidata.org/w/api.php?${searchParams.toString()}`)
  if (!searchRes.ok) return null
  const searchData = await searchRes.json()
  const entityId = searchData?.search?.[0]?.id
  if (!entityId) return null

  const claimsParams = new URLSearchParams({
    action: 'wbgetclaims',
    entity: entityId,
    property: 'P856',
    format: 'json',
  })
  const claimsRes = await fetch(`https://www.wikidata.org/w/api.php?${claimsParams.toString()}`)
  if (!claimsRes.ok) return null
  const claimsData = await claimsRes.json()
  const url = claimsData?.claims?.P856?.[0]?.mainsnak?.datavalue?.value
  return url || null
}

// Walks college_images/<college_id>/{building,scenery,classroom,other} in
// that exact priority order via Storage's list endpoint, stops at the
// first folder that actually has files in it, and returns one random pick
// from that folder. Returns null if none of the four folders exist or all
// are empty for this college.
async function pickCollegeImage(collegeId, SUPABASE_URL, SUPABASE_SERVICE_KEY) {
  const sbHeaders = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  }

  for (const folder of IMAGE_FOLDER_PRIORITY) {
    const prefix = `${collegeId}/${folder}`

    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${IMAGES_BUCKET}`, {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify({
        prefix,
        limit: 100,
        offset: 0,
        sortBy: { column: 'name', order: 'asc' },
      }),
    })

    // A missing prefix isn't an error from this endpoint (it just comes
    // back as an empty array), but treat a genuine HTTP failure here as
    // "this folder doesn't count" rather than aborting the whole
    // fallback chain — one bad folder shouldn't sink the other three.
    if (!r.ok) continue

    const entries = await r.json()
    // Supabase Storage's list endpoint returns folders AND files as
    // sibling entries; real files have an `id` (uuid) and metadata,
    // sub-folders don't. Also strip out the placeholder object some
    // Supabase UIs leave behind when a folder is created empty.
    const files = (entries || []).filter(
      (e) => e && e.id && e.name && e.name !== '.emptyFolderPlaceholder'
    )
    if (!files.length) continue

    const pick = files[Math.floor(Math.random() * files.length)]
    const path = `${prefix}/${pick.name}`

    return {
      folder,
      path,
      // Bucket is public (see the storage.objects SELECT policy for
      // "college_images"), so this is a plain, cacheable, keyless URL —
      // no signing round-trip needed.
      url: `${SUPABASE_URL}/storage/v1/object/public/${IMAGES_BUCKET}/${path}`,
    }
  }

  return null
}