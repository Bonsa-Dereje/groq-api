// lib/groqCall.js — every Groq call from the Vercel side lives here.
// Reads GROQ_API_KEY (+ optional GROQ_MODEL override) from env. Imported
// by api/uabroad.js. If/when api/chat.js's own Groq calls get folded in
// here too, point them at callGroq() below instead of duplicating the
// fetch — that way GROQ_MODEL only needs to be set in one place.

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

/**
 * Low-level call — pass full `messages`, get back the raw assistant
 * text. Every higher-level "ask" (writeCardDetail, and any future ones)
 * should go through this rather than hitting fetch() directly, so retry/
 * auth/model-selection logic only lives in one spot.
 */
export async function callGroq(messages, { temperature = 0.6, max_tokens = 300, model } = {}) {
  const { key, model: defaultModel } = getConfig()
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
    const body = await resp.text().catch(() => '')
    throw new Error(`Groq error: ${resp.status} ${body}`)
  }
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