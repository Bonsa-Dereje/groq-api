// /api/benchy.js — lives on the same Vercel project as api/chat.js (the
// groq proxy). Uses the SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars
// you added to this project. Called by the DESKTOP APP's Rust side
// (reqwest), the same way call_groq() hits /api/chat — never called
// directly from the browser or from JS `fetch` in the webview.
//
// GET  ?action=benchy-status&web_session_id=123456
//   Read-only. Returns { is_read } for that code. Never mutates anything —
//   the actual is_read flip happens on the marketplace site's own
//   /api/orders benchy-check poll, not here.
//
// POST { action:'benchy-link', web_session_id, category, items, device?, os? }
//   Fills in the pending benchy_data row (written by the marketplace site's
//   benchy-create) with the real order contents. Only succeeds if that row
//   is still pending, unread, and under 30 minutes old.

export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars' })
  }

  const sbHeaders = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  }

  if (req.method === 'GET' && req.query && req.query.action === 'benchy-status') {
    return handleBenchyStatus(req, res, SUPABASE_URL, sbHeaders)
  }
  if (req.method === 'POST' && req.body && req.body.action === 'benchy-link') {
    return handleBenchyLink(req, res, SUPABASE_URL, sbHeaders)
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(400).json({ error: 'Unrecognized action' })
}

const BENCHY_PENDING_CATEGORY = 'pending'

async function handleBenchyLink(req, res, SUPABASE_URL, sbHeaders) {
  const { web_session_id, category, items, device = null, os = 'Windows' } = req.body || {}

  if (!web_session_id || !/^\d{6}$/.test(String(web_session_id))) {
    return res.status(400).json({ error: 'web_session_id must be a 6-digit code' })
  }
  if (!category || !String(category).trim()) {
    return res.status(400).json({ error: 'category is required' })
  }
  const cleanItems = Array.isArray(items)
    ? items.map(i => String(i || '').trim()).filter(Boolean)
    : []
  if (!cleanItems.length) {
    return res.status(400).json({ error: 'items must be a non-empty array' })
  }

  try {
    const lookupRes = await fetch(
      `${SUPABASE_URL}/rest/v1/benchy_data?web_session_id=eq.${encodeURIComponent(web_session_id)}&select=id,category,is_read,created_at&order=created_at.desc&limit=1`,
      { headers: sbHeaders }
    )
    if (!lookupRes.ok) {
      const errBody = await lookupRes.text().catch(() => '')
      throw new Error(`Supabase error looking up session: ${lookupRes.status} ${errBody}`)
    }
    const [row] = await lookupRes.json()

    const stillPending = row && row.category === BENCHY_PENDING_CATEGORY && !row.is_read &&
      (Date.now() - new Date(row.created_at).getTime()) < 1000 * 60 * 30 // 30 min TTL

    if (!stillPending) {
      return res.status(404).json({ error: 'That code was not found or has expired' })
    }

    const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/benchy_data?id=eq.${row.id}`, {
      method: 'PATCH',
      headers: { ...sbHeaders, Prefer: 'return=representation' },
      body: JSON.stringify({
        order_ref: `BENCHY-${web_session_id}-${Date.now()}`,
        category: String(category).trim(),
        items: cleanItems,
        total_items: cleanItems.length,
        device,
        os,
      }),
    })
    if (!patchRes.ok) {
      const errBody = await patchRes.text().catch(() => '')
      throw new Error(`Supabase error linking session: ${patchRes.status} ${errBody}`)
    }

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[api/benchy] handleBenchyLink error', err)
    return res.status(500).json({ error: 'Failed to link session', detail: err.message })
  }
}

async function handleBenchyStatus(req, res, SUPABASE_URL, sbHeaders) {
  const { web_session_id } = req.query || {}
  if (!web_session_id || !/^\d{6}$/.test(String(web_session_id))) {
    return res.status(400).json({ error: 'web_session_id must be a 6-digit code' })
  }

  try {
    const fetchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/benchy_data?web_session_id=eq.${encodeURIComponent(web_session_id)}&select=is_read,category&order=created_at.desc&limit=1`,
      { headers: sbHeaders }
    )
    if (!fetchRes.ok) {
      const errBody = await fetchRes.text().catch(() => '')
      throw new Error(`Supabase error checking status: ${fetchRes.status} ${errBody}`)
    }
    const [row] = await fetchRes.json()
    if (!row) return res.status(404).json({ error: 'Session not found' })

    return res.status(200).json({ is_read: !!row.is_read })
  } catch (err) {
    console.error('[api/benchy] handleBenchyStatus error', err)
    return res.status(500).json({ error: 'Failed to check status', detail: err.message })
  }
}