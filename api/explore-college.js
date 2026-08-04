// /api/explore-college.js — same Vercel project as api/upcoming-test.js,
// api/chat.js, api/test-entries.js. Powers the "Explore" face that flips
// in alongside the Upcoming-tests card.
//
//   SUPABASE_URL_UABROAD / SUPABASE_SERVICE_KEY_UABROAD  -> same pair as
//     the rest of the project, read-only here (only ever SELECTs from
//     public."collegeData").
//   YOUTUBE_API_KEY                                      -> Google Cloud
//     Console -> enable "YouTube Data API v3" on a project -> Credentials
//     -> "Create credentials" -> API key. No OAuth needed, this only
//     calls the public search.list endpoint. Restrict the key to the
//     YouTube Data API v3 (and to your Vercel deployment's outbound IPs /
//     an HTTP referrer restriction isn't usable server-side, so leave it
//     as "None" or use an API restriction instead of an app restriction).
//
// NOTE on thumbnails: nothing here downloads a thumbnail. The mini player
// facade below points straight at https://img.youtube.com/vi/<id>/hqdefault.jpg
// (a static, keyless YouTube CDN URL) and the actual embed is a normal
// youtube.com/embed/<id> iframe — YouTube serves its own preview frame,
// play button and chrome inside that iframe automatically. The Data API
// key is only spent on the ONE call this file makes per request: finding
// which video to embed via search.list. There's no separate "download
// the thumbnail" step to build.
//
// GET /api/explore-college
//   1. Grabs one random row from "collegeData" (is nothing more than an
//      id + name lookup — collegeData has no is_active flag, so every row
//      is fair game).
//   2. Searches YouTube for "<collegeName> campus tour", takes the first
//      hit.
//   3. Returns { ok:true, college: { collegeId, name, videoId, videoTitle,
//      channelTitle, watchUrl, embedUrl } } or { ok:true, college:null }
//      if the table's empty / nothing comes back from YouTube.
//
// Cheap in-memory cache (module scope) so a burst of flips on a warm
// lambda doesn't re-spend YouTube quota every time — each search.list
// call costs 100 quota units against a 10,000/day default. This is NOT a
// durable cache (cold starts wipe it), just a courtesy dedupe.
let cache = { college: null, expiresAt: 0 }
const CACHE_TTL_MS = 45_000

export default async function handler(req, res) {
  // CORS: this app is fetched cross-origin (frontend lives on a different
  // host, see UABROAD_API_BASE in the Svelte page), so without these
  // headers a browser reports ANY failure here — including a plain 404
  // from this route not being deployed yet — as an opaque "network
  // error"/"Failed to fetch" rather than a real HTTP status. Setting
  // these up front means only genuine network/DNS problems show up as
  // network errors from now on.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    return res.status(204).end()
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS')
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  // Every stage below pushes onto `steps` regardless of success/failure,
  // and `steps` rides along on every response (success or error) so the
  // frontend can render exactly how far the request got.
  const steps = []

  const SUPABASE_URL = process.env.SUPABASE_URL_UABROAD
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY_UABROAD
  const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY

  const envOk = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY && YOUTUBE_API_KEY)
  steps.push({
    step: 'env_check',
    status: envOk ? 'ok' : 'error',
    detail: envOk
      ? 'SUPABASE_URL_UABROAD, SUPABASE_SERVICE_KEY_UABROAD, YOUTUBE_API_KEY all present'
      : `Missing: ${[
          !SUPABASE_URL && 'SUPABASE_URL_UABROAD',
          !SUPABASE_SERVICE_KEY && 'SUPABASE_SERVICE_KEY_UABROAD',
          !YOUTUBE_API_KEY && 'YOUTUBE_API_KEY',
        ].filter(Boolean).join(', ')}`,
  })
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'Server is missing SUPABASE_URL_UABROAD or SUPABASE_SERVICE_KEY_UABROAD env vars',
      steps,
    })
  }
  if (!YOUTUBE_API_KEY) {
    return res.status(500).json({ ok: false, error: 'Server is missing YOUTUBE_API_KEY env var', steps })
  }

  const fresh = req.query?.fresh === '1'
  if (!fresh && cache.college && Date.now() < cache.expiresAt) {
    steps.push({ step: 'cache', status: 'ok', detail: 'Served from warm-lambda cache, skipped Supabase + YouTube' })
    return res.status(200).json({ ok: true, college: cache.college, steps })
  }
  steps.push({ step: 'cache', status: 'miss', detail: fresh ? 'Bypassed with ?fresh=1' : 'No warm cache entry (cold start or expired)' })

  // --- Step: pick a random college -----------------------------------
  let row
  try {
    row = await fetchRandomCollege(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  } catch (err) {
    console.error('[api/explore-college] Supabase error', err)
    steps.push({ step: 'fetch_college', status: 'error', detail: err.message })
    return res.status(500).json({ ok: false, error: 'Failed to query collegeData', detail: err.message, steps })
  }
  if (!row) {
    steps.push({ step: 'fetch_college', status: 'empty', detail: 'collegeData query returned 0 rows with a non-null collegeName' })
    return res.status(200).json({ ok: true, college: null, steps })
  }
  steps.push({
    step: 'fetch_college',
    status: 'ok',
    detail: `Picked "${row.collegeName}" (college_id ${row.college_id})`,
  })

  // --- Step: look it up on YouTube ------------------------------------
  let video
  try {
    video = await searchCampusTour(row.collegeName, YOUTUBE_API_KEY)
  } catch (err) {
    console.error('[api/explore-college] YouTube error', err)
    steps.push({ step: 'youtube_search', status: 'error', detail: err.message })
    return res.status(500).json({ ok: false, error: 'YouTube search failed', detail: err.message, steps })
  }
  if (!video) {
    steps.push({
      step: 'youtube_search',
      status: 'empty',
      detail: `search.list returned 0 items for "${row.collegeName} campus tour"`,
    })
    return res.status(200).json({ ok: true, college: null, steps })
  }
  steps.push({
    step: 'youtube_search',
    status: 'ok',
    detail: `videoId=${video.videoId} — "${video.title}" (${video.channelTitle})`,
  })

  // --- Assemble ---------------------------------------------------------
  // --- Step: resolve the official university site (Wikidata) ----------
  // collegeData has no website column, so this looks the school up on
  // Wikidata (free, keyless) and pulls property P856 "official website"
  // off whichever entity best matches the name. Falls back to a Google
  // search link if Wikidata has nothing, so the button is never dead.
  let websiteUrl
  try {
    websiteUrl = await lookupOfficialSite(row.collegeName)
  } catch (err) {
    console.error('[api/explore-college] Wikidata lookup error', err)
    websiteUrl = null
  }
  if (websiteUrl) {
    steps.push({ step: 'official_site', status: 'ok', detail: `Resolved via Wikidata: ${websiteUrl}` })
  } else {
    websiteUrl = `https://www.google.com/search?q=${encodeURIComponent(row.collegeName + ' official site')}`
    steps.push({ step: 'official_site', status: 'fallback', detail: 'No Wikidata P856 claim found, using a Google search link instead' })
  }

  const college = {
    collegeId: row.college_id,
    name: row.collegeName,
    videoId: video.videoId,
    videoTitle: video.title,
    channelTitle: video.channelTitle,
    watchUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
    embedUrl: `https://www.youtube.com/embed/${video.videoId}`,
    websiteUrl,
  }

  cache = { college, expiresAt: Date.now() + CACHE_TTL_MS }
  steps.push({ step: 'done', status: 'ok', detail: 'College + video assembled and cached' })

  return res.status(200).json({ ok: true, college, steps })
}

// Picks one random row out of "collegeData". Pulls just the two columns
// this endpoint needs (keeps the payload small even if the table grows),
// then picks an index client-side rather than trying to get Postgres to
// order by random() through PostgREST.
async function fetchRandomCollege(SUPABASE_URL, SUPABASE_SERVICE_KEY) {
  const sbHeaders = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  }

  const url =
    `${SUPABASE_URL}/rest/v1/collegeData` +
    `?select=college_id,collegeName` +
    `&collegeName=not.is.null` +
    `&limit=1000`

  const r = await fetch(url, { headers: sbHeaders })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`Supabase error selecting collegeData: ${r.status} ${body}`)
  }
  const rows = await r.json()
  if (!rows.length) return null

  return rows[Math.floor(Math.random() * rows.length)]
}

// Top 5 hits for "<college name> campus tour" — type=video only,
// safeSearch on since this is embedded straight into a student dashboard.
// search.list doesn't expose whether a video allows embedding, so this
// pulls a handful of candidates and hands them to videos.list (below) to
// find the first one that's actually embeddable. Without this check,
// clicking play on a video whose owner disabled embedding renders as a
// black <iframe> with just YouTube's own "Watch on YouTube" link — no JS
// error, so the old single-result version had no way to catch it.
async function searchCampusTour(collegeName, YOUTUBE_API_KEY) {
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    maxResults: '5',
    safeSearch: 'strict',
    q: `${collegeName} campus tour`,
    key: YOUTUBE_API_KEY,
  })

  const r = await fetch(`https://www.googleapis.com/youtube/v3/search?${params.toString()}`)
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`YouTube search error: ${r.status} ${body}`)
  }
  const data = await r.json()
  const items = data?.items || []
  const candidates = items
    .map((item) => ({
      videoId: item?.id?.videoId,
      title: item.snippet?.title || '',
      channelTitle: item.snippet?.channelTitle || '',
    }))
    .filter((c) => c.videoId)
  if (!candidates.length) return null

  const embeddableId = await firstEmbeddableVideoId(candidates.map((c) => c.videoId), YOUTUBE_API_KEY)
  if (!embeddableId) return null

  return candidates.find((c) => c.videoId === embeddableId)
}

// Given a list of video IDs (in preference order), returns the first one
// with status.embeddable === true, or null if none of them are.
// videos.list accepts up to 50 comma-separated IDs in a single call, so
// this is one extra API call regardless of how many candidates there are.
async function firstEmbeddableVideoId(videoIds, YOUTUBE_API_KEY) {
  const params = new URLSearchParams({
    part: 'status',
    id: videoIds.join(','),
    key: YOUTUBE_API_KEY,
  })
  const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params.toString()}`)
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`YouTube videos.list error: ${r.status} ${body}`)
  }
  const data = await r.json()
  const embeddableIds = new Set(
    (data?.items || []).filter((v) => v.status?.embeddable).map((v) => v.id)
  )
  return videoIds.find((id) => embeddableIds.has(id)) || null
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