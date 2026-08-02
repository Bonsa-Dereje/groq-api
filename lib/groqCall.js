// lib/groqCall.js — every Groq call from the Vercel side lives here.
// Reads GROQ_API_KEY (+ optional GROQ_MODEL override) from env. Imported
// by api/uabroad.js. If/when api/chat.js's own Groq calls get folded in
// here too, point them at callGroq() below instead of duplicating the
// fetch — that way GROQ_MODEL only needs to be set in one place.
//
// callGroq() is throttled through groqRateLimiter below — the JS
// mirror of splicer_core.py's GroqRateLimiter on the Python desktop
// side, so both talk to Groq at the same pace and shape: strict FIFO,
// base 5s between calls, backing off harder on a real 429 and easing
// back down after clean responses. See the limiter's own comment block
// for the one caveat specific to running this in a Vercel function.

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions'
const DEFAULT_MODEL = 'llama-3.3-70b-versatile' // adjust to match api/chat.js's model if it differs

function getConfig() {
  const key = process.env.GROQ_API_KEY
  if (!key) {
    const err = new Error('Missing GROQ_API_KEY env var')
    err.status = 500
    throw err
  }
  return { key, model: process.env.GROQ_MODEL || DEFAULT_MODEL }
}

// ---------------------------------------------------------------------
// Shared Groq rate limiter — mirrors GroqRateLimiter in splicer_core.py
// (the Python desktop pipeline) so both sides call Groq at the same
// FIFO, adaptive pace instead of two different, uncoordinated schemes.
//
// Base cadence: one call every GROQ_MIN_INTERVAL_MS (5s). A real 429
// from Groq is ground truth that the current pace is still too fast —
// note429() bumps the interval up (+5s per consecutive 429, capped at
// 120s); noteSuccess() eases it back down 1s at a time after every
// clean response, rather than snapping straight back, so a burst of
// 429s doesn't immediately walk right back into the same wall.
//
// FIFO note: waitTurn() chains onto a single promise tail, so callers
// are served in the exact order they called it — same guarantee as the
// ticket queue in the Python limiter, just expressed with promises
// instead of threads (JS has no threads to race here; the ordering
// risk in a single-threaded event loop is two calls both starting
// before either awaits, which chaining onto `tail` synchronously
// avoids).
//
// Caveat specific to this side: this state lives in one Vercel
// function's warm lambda instance. A cold start resets it, and two
// concurrent lambda instances each throttle themselves independently —
// same shape of caveat the Python limiter has for two processes.
// ---------------------------------------------------------------------

const GROQ_MIN_INTERVAL_MS = 5000
const GROQ_MAX_INTERVAL_MS = 120000
const GROQ_429_BACKOFF_STEP_MS = 5000
const GROQ_COOLDOWN_STEP_MS = 1000

const groqRateLimiter = {
  interval: GROQ_MIN_INTERVAL_MS,
  nextAllowedAt: 0,
  consecutive429: 0,
}

let _tail = Promise.resolve()

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function _reserveSlot() {
  const wait = groqRateLimiter.nextAllowedAt - Date.now()
  if (wait > 0) await _sleep(wait)
  groqRateLimiter.nextAllowedAt = Date.now() + groqRateLimiter.interval
}

/**
 * Blocks (asynchronously) until it's this caller's turn, FIFO, and at
 * least groqRateLimiter.interval ms have passed since the last call was
 * allowed to start. Mirrors GroqRateLimiter.wait_turn() in
 * splicer_core.py.
 */
async function waitTurn() {
  // Chain onto the previous caller's turn — this line runs synchronously
  // (no await yet), so if two requests call waitTurn() back to back,
  // the second one's `_tail = ...` always sees the first one's promise,
  // guaranteeing strict call order regardless of how the event loop
  // interleaves everything else afterward.
  const myTurn = _tail.then(() => _reserveSlot())
  _tail = myTurn.catch(() => {}) // one failed reservation must never wedge everyone behind it
  return myTurn
}

/** Call when Groq itself returns a 429 — ground truth beats our guess. */
function note429() {
  groqRateLimiter.consecutive429 += 1
  groqRateLimiter.interval = Math.min(
    GROQ_MAX_INTERVAL_MS,
    groqRateLimiter.interval + GROQ_429_BACKOFF_STEP_MS * groqRateLimiter.consecutive429,
  )
  groqRateLimiter.nextAllowedAt = Math.max(
    groqRateLimiter.nextAllowedAt,
    Date.now() + groqRateLimiter.interval,
  )
}

/** Call after every 2xx Groq response. */
function noteSuccess() {
  groqRateLimiter.consecutive429 = 0
  if (groqRateLimiter.interval > GROQ_MIN_INTERVAL_MS) {
    groqRateLimiter.interval = Math.max(GROQ_MIN_INTERVAL_MS, groqRateLimiter.interval - GROQ_COOLDOWN_STEP_MS)
  }
}

/**
 * Non-blocking peek at the limiter's current state — for a live status
 * display somewhere (a dashboard, a log line, etc.), same idea as
 * GROQ_RATE_LIMITER.seconds_until_next()/current_interval() on the
 * Python side.
 */
export function getGroqRateLimiterStatus() {
  return {
    intervalMs: groqRateLimiter.interval,
    msUntilNext: Math.max(0, groqRateLimiter.nextAllowedAt - Date.now()),
    consecutive429: groqRateLimiter.consecutive429,
  }
}

/**
 * Low-level call — pass full `messages`, get back the raw assistant
 * text. Every higher-level "ask" (writeCardDetail, and any future ones)
 * should go through this rather than hitting fetch() directly, so retry/
 * auth/model-selection logic only lives in one spot.
 */
export async function callGroq(messages, { temperature = 0.6, max_tokens = 300, model } = {}) {
  const { key, model: defaultModel } = getConfig()
  await waitTurn()
  const resp = await fetch(GROQ_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model || defaultModel,
      temperature,
      max_tokens,
      messages,
    }),
  })
  if (!resp.ok) {
    if (resp.status === 429) note429()
    const body = await resp.text().catch(() => '')
    throw new Error(`Groq error: ${resp.status} ${body}`)
  }
  noteSuccess()
  const data = await resp.json()
  return data?.choices?.[0]?.message?.content || ''
}

// Belt-and-suspenders word cap — asked for in the prompt too, but this
// enforces it regardless of whether the model actually complies.
function capWords(text, limit) {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length <= limit) return text.trim()
  return words.slice(0, limit).join(' ') + '…'
}

/**
 * Appends fact(s) pulled straight from test_general_info (via
 * uabroadDB.js's pickGeneralInfoHighlights) to an already-generated
 * Groq blurb. Accepts a single string or an array of 2-3 facts. Pure
 * string concatenation — no fetch, no model call. Keeping this separate
 * from writeCardDetail is the point: general-info values must reach the
 * UI exactly as stored in the DB, never rewritten, summarized, or
 * otherwise touched by the model.
 */
export function appendRawFact(blurb, facts) {
  const list = Array.isArray(facts) ? facts.filter(Boolean) : facts ? [facts] : []
  if (!list.length) return blurb

  const factText = list.join(' — ')
  const trimmed = (blurb || '').trim()
  if (!trimmed) return factText

  const needsSpace = /[.!?]$/.test(trimmed)
  return `${trimmed}${needsSpace ? ' ' : '. '}${factText}`
}

/**
 * Short, word-capped blurb for a dashboard card (Upcoming tests,
 * Spotlight, etc). `context` is a plain-text block of known facts the
 * model should stick to rather than invent around (deadline, location,
 * fees, ...).
 */
export async function writeCardDetail(title, context = '', wordLimit = 30) {
  const prompt =
    `Write a short, encouraging blurb for a student dashboard card about ` +
    `the item below.\n\n${title}\n${context}\n\n` +
    `Rules:\n` +
    `- Maximum ${wordLimit} words, ideally a bit under.\n` +
    `- One or two short sentences, plain text only — no markdown, no quotes.\n` +
    `- Do not invent dates, locations, or fees that weren't given above.\n` +
    `- Return ONLY the blurb text, nothing else.`

  const raw = await callGroq([{ role: 'user', content: prompt }], { max_tokens: 120 })
  return capWords(raw.replace(/^"|"$/g, ''), wordLimit)
}