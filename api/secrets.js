// api/secrets.js
//
// Drop this into your existing groq-api-sand Vercel project (as
// api/secrets.js) and it becomes: https://groq-api-sand.vercel.app/api/secrets
//
// GET  -> returns the current secret values as JSON (for a script/CI job
//         to consume at runtime instead of duplicating them elsewhere).
// POST -> updates one or more values in Vercel's Project env vars via
//         Vercel's own REST API (requires a redeploy to take effect —
//         see the note at the bottom of this file).
//
// SECURITY MODEL — read this before deploying:
//   - Every request must send  Authorization: Bearer <ACCESS_TOKEN>
//     where ACCESS_TOKEN is a value YOU generate and store as a Vercel
//     env var (never hardcode it here). Anyone with this token can read
//     your Supabase service_role key and Groq key, so treat it with the
//     same care as the keys themselves — one strong random token used
//     only by the systems that need to call this endpoint (e.g. your
//     GitHub Actions workflow).
//   - The token is compared with crypto.timingSafeEqual, not `===`, so
//     the comparison itself can't leak the token via timing.
//   - No CORS headers are set on purpose. Browsers should never call
//     this endpoint directly (it would expose the response to any page
//     that could trick a logged-in browser into requesting it); it's
//     meant for server-to-server calls only (curl, GitHub Actions, etc).
//   - Nothing here is logged. Do not add console.log(token) or
//     console.log(secrets) — Vercel function logs are visible to anyone
//     with access to the project dashboard, which may be a wider group
//     than "people who should see the service_role key".
//
// REQUIRED Vercel env vars (set in Project Settings → Environment
// Variables — never in this file):
//   ACCESS_TOKEN               the bearer token this endpoint checks
//   SUPABASE_URL_MAKEDO        (you already have this)
//   SUPABASE_SERVICE_KEY_MAKEDO(you already have this)
//   SUPABASE_DB_URL_MAKEDO     add this one — the Postgres pooler URI
//   GROQ_API_KEY_MAKEDO        add this one
//
// OPTIONAL, only needed if you want the POST/write path to actually
// work (see note near writeEnvVar below):
//   VERCEL_API_TOKEN           a Vercel personal access token (Account
//                              Settings → Tokens) — NOT the same as
//                              ACCESS_TOKEN above
//   VERCEL_PROJECT_ID          this project's ID (Project Settings →
//                              General → Project ID)
//   VERCEL_TEAM_ID             only if this project lives under a team,
//                              not a personal account

const crypto = require("crypto");

// Map the public name a caller asks for -> the actual Vercel env var
// that holds it. Keeps the *_MAKEDO naming as an internal detail.
const SECRET_MAP = {
  SUPABASE_URL: "SUPABASE_URL_MAKEDO",
  SUPABASE_SERVICE_KEY: "SUPABASE_SERVICE_KEY_MAKEDO",
  SUPABASE_DB_URL: "SUPABASE_DB_URL_MAKEDO",
  GROQ_API_KEY: "GROQ_API_KEY_MAKEDO",
};

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal-length buffers so the early return
    // above doesn't itself become a length-based timing signal in
    // practice this is a minor concern for a token check, but cheap to
    // avoid.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthorized(req) {
  const expected = process.env.ACCESS_TOKEN;
  if (!expected) return false; // fail closed if you forgot to set it

  const header = req.headers["authorization"] || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return false;

  return timingSafeEqualStr(token, expected);
}

module.exports = async (req, res) => {
  // No CORS headers — intentional, see file header.
  res.setHeader("Cache-Control", "no-store");

  if (!isAuthorized(req)) {
    // Same response whether the token is missing, wrong, or the route
    // doesn't exist — don't give an attacker a way to tell "close" from
    // "not even trying".
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  if (req.method === "GET") {
    const out = {};
    const missing = [];
    for (const [publicName, envName] of Object.entries(SECRET_MAP)) {
      const val = process.env[envName];
      if (val) {
        out[publicName] = val;
      } else {
        missing.push(envName);
      }
    }
    if (missing.length) {
      // Don't silently return partial secrets — a caller expecting
      // SUPABASE_DB_URL and not getting it should fail loudly, not
      // limp along with an empty string.
      res.status(500).json({
        error: `missing Vercel env var(s): ${missing.join(", ")}`,
      });
      return;
    }
    res.status(200).json(out);
    return;
  }

  if (req.method === "POST") {
    // See the writeEnvVar note below — this requires extra setup
    // (VERCEL_API_TOKEN / VERCEL_PROJECT_ID) and a redeploy before the
    // new value is actually live.
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        res.status(400).json({ error: "invalid JSON body" });
        return;
      }
    }
    if (!body || typeof body !== "object") {
      res.status(400).json({ error: "expected a JSON object body" });
      return;
    }

    const updates = {};
    for (const [publicName, value] of Object.entries(body)) {
      const envName = SECRET_MAP[publicName];
      if (!envName) {
        res.status(400).json({ error: `unknown key: ${publicName}` });
        return;
      }
      if (typeof value !== "string" || !value) {
        res.status(400).json({ error: `${publicName} must be a non-empty string` });
        return;
      }
      updates[envName] = value;
    }

    try {
      const results = [];
      for (const [envName, value] of Object.entries(updates)) {
        results.push(await writeEnvVar(envName, value));
      }
      res.status(200).json({
        updated: Object.keys(updates),
        note:
          "Values are updated in Vercel, but a redeploy is required " +
          "before running functions pick them up. Trigger one (e.g. via " +
          "a Vercel deploy hook) if you need the change live immediately.",
        results,
      });
    } catch (err) {
      res.status(502).json({ error: String(err.message || err) });
    }
    return;
  }

  res.setHeader("Allow", "GET, POST");
  res.status(405).json({ error: "method not allowed" });
};

// Writing an env var means calling Vercel's own REST API — a serverless
// function can't rewrite its own project's env vars directly. This needs
// VERCEL_API_TOKEN (a personal access token, scoped as narrowly as
// Vercel allows) and VERCEL_PROJECT_ID set as env vars on this same
// project. If you don't set those, POST will fail with a clear error
// telling you which one is missing — the GET/read path works fine
// without any of this.
async function writeEnvVar(key, value) {
  const apiToken = process.env.VERCEL_API_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID; // optional

  if (!apiToken || !projectId) {
    throw new Error(
      "write support isn't configured: set VERCEL_API_TOKEN and " +
        "VERCEL_PROJECT_ID as env vars on this project to enable POST"
    );
  }

  const qs = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
  const url = `https://api.vercel.com/v10/projects/${projectId}/env${qs}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      key,
      value,
      type: "encrypted",
      target: ["production", "preview", "development"],
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    // Vercel returns 409 if the key already exists — update it instead.
    if (resp.status === 409) {
      return updateExistingEnvVar(key, value, projectId, teamId, apiToken);
    }
    throw new Error(
      `Vercel API ${resp.status} setting ${key}: ${JSON.stringify(data)}`
    );
  }
  return { key, action: "created" };
}

async function updateExistingEnvVar(key, value, projectId, teamId, apiToken) {
  const qsBase = teamId ? `teamId=${encodeURIComponent(teamId)}` : "";

  // Find the existing env var's id first.
  const listUrl = `https://api.vercel.com/v9/projects/${projectId}/env${qsBase ? "?" + qsBase : ""}`;
  const listResp = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  const listData = await listResp.json().catch(() => ({}));
  if (!listResp.ok) {
    throw new Error(
      `Vercel API ${listResp.status} listing env vars: ${JSON.stringify(listData)}`
    );
  }
  const existing = (listData.envs || []).find((e) => e.key === key);
  if (!existing) {
    throw new Error(`could not find existing env var ${key} to update`);
  }

  const updUrl = `https://api.vercel.com/v9/projects/${projectId}/env/${existing.id}${qsBase ? "?" + qsBase : ""}`;
  const updResp = await fetch(updUrl, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ value }),
  });
  const updData = await updResp.json().catch(() => ({}));
  if (!updResp.ok) {
    throw new Error(
      `Vercel API ${updResp.status} updating ${key}: ${JSON.stringify(updData)}`
    );
  }
  return { key, action: "updated" };
}
