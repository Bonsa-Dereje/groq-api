// /api/upcoming-test.js — lives on the same Vercel project as api/chat.js
// and api/test-entries.js. Same env-var split as test-entries.js:
//   SUPABASE_URL_UABROAD / SUPABASE_SERVICE_KEY_UABROAD  -> read from
//     public.test_entries (service key stays server-side, same as the
//     write path in test-entries.js — this file only ever SELECTs).
//   GROQ_API_KEY (+ optional GROQ_MODEL)                 -> same Groq
//     account alting_ua_gitactions.py's call_groq() hits through
//     /api/chat, just called directly here instead of proxied text.
//
// GET /api/upcoming-test
//   1. Pulls the single test_entries row with the nearest upcoming
//      registration_deadline (falling back to nearest test_date if
//      nothing has an upcoming deadline), is_active = true only.
//   2. Hands that row's title to Groq and asks for a short, word-capped
//      "detail" blurb — the Upcoming-tests card is small (4 clamped
//      lines at 13px under an 18px underlined title), so DETAIL_WORD_LIMIT
//      keeps the AI from writing something that just gets clipped.
//   3. Returns { ok:true, test: { title, content, deadline, link } } or
//      { ok:true, test:null } when there's nothing upcoming.
//
// Adjust GROQ_MODEL below if it doesn't match whatever model
// alting_ua.py's call_groq() / api/chat.js are already using — kept as
// an env override so the two don't have to be edited in lockstep.

const DETAIL_WORD_LIMIT = 30

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  const SUPABASE_URL = process.env.SUPABASE_URL_UABROAD
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY_UABROAD
  const GROQ_API_KEY = process.env.GROQ_API_KEY
  const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({
      error: 'Server is missing SUPABASE_URL_UABROAD or SUPABASE_SERVICE_KEY_UABROAD env vars',
    })
  }
  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: 'Server is missing GROQ_API_KEY env var' })
  }

  try {
    const row = await fetchNearestTestRow(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    if (!row) {
      return res.status(200).json({ ok: true, test: null })
    }

    const title = row.test_name || `${row.test_category} test`
    const detail = await writeDetail(title, row, GROQ_API_KEY, GROQ_MODEL)

    return res.status(200).json({
      ok: true,
      test: {
        title,
        content: detail,
        deadline: row.registration_deadline || row.test_date || null,
        link: row.official_link || row.source_url || null,
      },
    })
  } catch (err) {
    console.error('[api/upcoming-test] error', err)
    return res.status(500).json({ ok: false, error: 'Failed to load upcoming test', detail: err.message })
  }
}

async function fetchNearestTestRow(SUPABASE_URL, SUPABASE_SERVICE_KEY) {
  const sbHeaders = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  }
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

  const columns =
    'id,test_category,test_name,detail,registration_deadline,test_date,official_link,source_url'

  // 1) Prefer the nearest upcoming registration_deadline.
  const byDeadlineUrl =
    `${SUPABASE_URL}/rest/v1/test_entries` +
    `?select=${columns}` +
    `&is_active=eq.true` +
    `&registration_deadline=gte.${today}` +
    `&order=registration_deadline.asc` +
    `&limit=1`

  let rows = await sbSelect(byDeadlineUrl, sbHeaders)
  if (rows.length) return rows[0]

  // 2) Nothing with an upcoming deadline — fall back to nearest test_date.
  const byTestDateUrl =
    `${SUPABASE_URL}/rest/v1/test_entries` +
    `?select=${columns}` +
    `&is_active=eq.true` +
    `&test_date=gte.${today}` +
    `&order=test_date.asc` +
    `&limit=1`

  rows = await sbSelect(byTestDateUrl, sbHeaders)
  return rows[0] || null
}

async function sbSelect(url, headers) {
  const r = await fetch(url, { headers })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`Supabase error selecting test_entries: ${r.status} ${body}`)
  }
  return r.json()
}

async function writeDetail(title, row, GROQ_API_KEY, GROQ_MODEL) {
  const context = [
    row.test_category ? `Test category: ${row.test_category}` : null,
    row.registration_deadline ? `Registration deadline: ${row.registration_deadline}` : null,
    row.test_date ? `Test date: ${row.test_date}` : null,
    row.detail ? `Known detail: ${row.detail}` : null,
  ].filter(Boolean).join('\n')

  const prompt =
    `Write a short, encouraging blurb for a student dashboard card about the ` +
    `upcoming test below.\n\n${title}\n${context}\n\n` +
    `Rules:\n` +
    `- Maximum ${DETAIL_WORD_LIMIT} words, ideally a bit under.\n` +
    `- One or two short sentences, plain text only — no markdown, no quotes.\n` +
    `- Do not invent dates, locations, or fees that weren't given above.\n` +
    `- Return ONLY the blurb text, nothing else.`

  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.6,
      max_tokens: 120,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`Groq error: ${resp.status} ${body}`)
  }

  const data = await resp.json()
  const raw = data?.choices?.[0]?.message?.content || ''
  return capWords(raw.trim().replace(/^"|"$/g, ''), DETAIL_WORD_LIMIT)
}

// Belt-and-suspenders: the prompt asks Groq to stay under the limit, but
// this enforces it regardless of whether the model actually complies.
function capWords(text, limit) {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length <= limit) return text
  return words.slice(0, limit).join(' ') + '…'
}
