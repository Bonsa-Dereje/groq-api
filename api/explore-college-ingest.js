// api/explore-college-ingest.js
//
// Server-side counterpart to explore_college_ingest.py. Holds the Supabase
// and YouTube credentials so the script (or anything else) never needs them
// directly — callers just hit this endpoint with a shared secret, the same
// pattern _page.svelte already uses for /api/explore-college.
//
// Processes ONE college per call (mirrors explore-college.js's one-video-
// per-request shape, and keeps each invocation well under Vercel's
// execution time limit — no 100-college loop inside a single function run).
// Auto-resumes from MAX(college_id) in explore_colleges when no start_id is
// given; callers that already know the next id can pass it explicitly to
// skip that lookup.
//
// Env vars required (set these in the Vercel project, not in the caller):
//   SUPABASE_URL_UABROAD
//   SUPABASE_SERVICE_KEY_UABROAD
//   YOUTUBE_API_KEY
//   INGEST_SHARED_SECRET   <- new: callers must present this
//
// Request:
//   GET /api/explore-college-ingest
//     Authorization: Bearer <INGEST_SHARED_SECRET>   (or ?secret=... query param)
//     ?start_id=123     optional — else auto-resumes from MAX(college_id)+1
//     &dry_run=1        optional — search only, skip the upsert
//
// Response 200:
//   { done: false, college_id, collegeName, youtube_link, dry_run }
//   { done: true }                                  <- no rows at/after start_id
//
// Errors: 401 (bad/missing secret), 500 (missing env / upstream failure)

const SUPABASE_URL = process.env.SUPABASE_URL_UABROAD;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY_UABROAD;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const INGEST_SHARED_SECRET = process.env.INGEST_SHARED_SECRET;

const TABLE_SOURCE = 'collegeData';
const TABLE_TARGET = 'explore_colleges';

function sbHeaders() {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function getLastProcessedId() {
  const url = `${SUPABASE_URL}/rest/v1/${TABLE_TARGET}?select=college_id&order=college_id.desc&limit=1`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`Supabase read (${TABLE_TARGET}) failed: ${r.status} ${await r.text()}`);
  const rows = await r.json();
  return rows.length ? rows[0].college_id : 0;
}

async function fetchNextCollege(startId) {
  const url =
    `${SUPABASE_URL}/rest/v1/${TABLE_SOURCE}` +
    `?select=college_id,collegeName` +
    `&collegeName=not.is.null` +
    `&college_id=gte.${startId}` +
    `&order=college_id.asc` +
    `&limit=1`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`Supabase read (${TABLE_SOURCE}) failed: ${r.status} ${await r.text()}`);
  const rows = await r.json();
  return rows[0] ?? null;
}

async function firstEmbeddableVideoId(videoIds) {
  const params = new URLSearchParams({
    part: 'status',
    id: videoIds.join(','),
    key: YOUTUBE_API_KEY,
  });
  const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`);
  if (!r.ok) throw new Error(`YouTube videos.list failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  const embeddable = new Set(
    (data.items || []).filter((v) => v.status && v.status.embeddable).map((v) => v.id)
  );
  return videoIds.find((id) => embeddable.has(id)) ?? null;
}

async function searchCampusTour(collegeName) {
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    maxResults: '5',
    safeSearch: 'strict',
    q: `${collegeName} campus tour`,
    key: YOUTUBE_API_KEY,
  });
  const r = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
  if (!r.ok) throw new Error(`YouTube search failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  const candidates = (data.items || [])
    .map((item) => ({
      videoId: item.id && item.id.videoId,
      title: (item.snippet && item.snippet.title) || '',
      channelTitle: (item.snippet && item.snippet.channelTitle) || '',
    }))
    .filter((c) => c.videoId);

  if (!candidates.length) return null;

  const embeddableId = await firstEmbeddableVideoId(candidates.map((c) => c.videoId));
  if (!embeddableId) return null;

  return candidates.find((c) => c.videoId === embeddableId);
}

async function upsertResult(collegeId, youtubeLink) {
  const url = `${SUPABASE_URL}/rest/v1/${TABLE_TARGET}`;
  const headers = { ...sbHeaders(), Prefer: 'resolution=merge-duplicates' };
  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ college_id: collegeId, youtube_link: youtubeLink }),
  });
  if (!r.ok) throw new Error(`Supabase upsert failed: ${r.status} ${await r.text()}`);
}

function checkSecret(req) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const provided = bearer || req.query.secret;
  return Boolean(INGEST_SHARED_SECRET) && provided === INGEST_SHARED_SECRET;
}

module.exports = async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !YOUTUBE_API_KEY || !INGEST_SHARED_SECRET) {
    res.status(500).json({ error: 'Server missing required env vars.' });
    return;
  }

  if (!checkSecret(req)) {
    res.status(401).json({ error: 'Missing or invalid secret.' });
    return;
  }

  const dryRun = req.query.dry_run === '1' || req.query.dry_run === 'true';
  const startIdParam = req.query.start_id;

  try {
    const startId = startIdParam ? parseInt(startIdParam, 10) : (await getLastProcessedId()) + 1;

    const row = await fetchNextCollege(startId);
    if (!row) {
      res.status(200).json({ done: true });
      return;
    }

    const collegeId = row.college_id;
    const collegeName = row.collegeName;

    let video = null;
    try {
      video = await searchCampusTour(collegeName);
    } catch (err) {
      console.error(`YouTube error for college_id=${collegeId}:`, err.message);
      video = null;
    }

    const youtubeLink = video ? `https://www.youtube.com/watch?v=${video.videoId}` : null;

    if (!dryRun) {
      await upsertResult(collegeId, youtubeLink);
    }

    res.status(200).json({
      done: false,
      college_id: collegeId,
      collegeName,
      youtube_link: youtubeLink,
      dry_run: dryRun,
    });
  } catch (err) {
    console.error('explore-college-ingest error:', err);
    res.status(500).json({ error: err.message });
  }
};
