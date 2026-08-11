// api/chat.js — Groq proxy. Now requires a shared secret from the caller
// (your own frontend/desktop app), so it's no longer a free-for-all proxy
// for anyone who finds the URL.
//
// REQUIRED new Vercel env var:
//   SITE_API_KEY   a random token only your own app sends. Generate with
//                  e.g. `openssl rand -hex 32`. NOT the same as GROQ_API_KEY.

const crypto = require('crypto')

// keep this tight — don't let callers pick an arbitrary/expensive model
const ALLOWED_MODELS = new Set([
  'llama-3.3-70b-versatile',
  // add others explicitly as needed
])

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA)
    return false
  }
  return crypto.timingSafeEqual(bufA, bufB)
}

function isAuthorized(req) {
  const expected = process.env.SITE_API_KEY
  if (!expected) return false // fail closed if you forgot to set it
  const header = req.headers['authorization'] || ''
  const [scheme, token] = header.split(' ')
  if (scheme !== 'Bearer' || !token) return false
  return timingSafeEqualStr(token, expected)
}

// very small in-memory rate limit per warm lambda instance — not a
// substitute for a real store (Upstash/Redis) but stops naive abuse
// bursts within one instance's lifetime
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 20
const hits = new Map()
function isRateLimited(ip) {
  const now = Date.now()
  const arr = (hits.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS)
  arr.push(now)
  hits.set(ip, arr)
  return arr.length > RATE_LIMIT_MAX
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown'
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'rate limited' })
  }

  const body = req.body || {}
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return res.status(400).json({ error: 'messages array is required' })
  }
  if (body.model && !ALLOWED_MODELS.has(body.model)) {
    return res.status(400).json({ error: `model not allowed: ${body.model}` })
  }
  // cap payload size roughly, since req.body is already parsed JSON here
  if (JSON.stringify(body).length > 50_000) {
    return res.status(413).json({ error: 'request too large' })
  }

  try {
    const response = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    )

    const data = await response.json()
    return res.status(response.status).json(data)
  } catch (err) {
    return res.status(500).json({
      error: 'Proxy failed',
      details: err.message,
    })
  }
}