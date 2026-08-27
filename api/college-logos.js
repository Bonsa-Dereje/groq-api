// api/college-logos.js
//
// Deploy this file to your Vercel project at: /api/college-logos.js
// (works whether the project is plain Vercel functions or Next.js "pages" router)
//
// Requires the dependency: @supabase/supabase-js
//   npm install @supabase/supabase-js
//
// Requires these env vars to already be set in the Vercel project
// (which you said they are): SUPABASE_URL_UABROAD, SUPABASE_SERVICE_KEY_UABROAD
//
// Optional: set DOWNLOAD_TOKEN as an env var in Vercel to require a
// ?token=... query param on requests to this endpoint. Strongly recommended
// since this endpoint hands out signed URLs using your SERVICE ROLE key.

const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'spotlight-images';
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

module.exports = async (req, res) => {
  try {
    const supabaseUrl = process.env.SUPABASE_URL_UABROAD;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY_UABROAD;

    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({
        error: 'Missing SUPABASE_URL_UABROAD or SUPABASE_SERVICE_KEY_UABROAD env vars',
      });
    }

    // Optional simple auth gate
    const requiredToken = process.env.DOWNLOAD_TOKEN;
    if (requiredToken) {
      const providedToken = req.query.token;
      if (providedToken !== requiredToken) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const supabase = createClient(supabaseUrl, serviceKey);

    const allFiles = await listAllFiles(supabase, BUCKET, '');

    const filesWithUrls = [];
    for (const file of allFiles) {
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(file.path, SIGNED_URL_TTL_SECONDS);

      if (error) {
        filesWithUrls.push({ ...file, url: null, error: error.message });
      } else {
        filesWithUrls.push({ ...file, url: data.signedUrl });
      }
    }

    return res.status(200).json({
      bucket: BUCKET,
      count: filesWithUrls.length,
      files: filesWithUrls,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
};

// Recursively walks the bucket (Supabase Storage "folders" are just path
// prefixes) and returns a flat list of { name, path, size, updated_at }.
async function listAllFiles(supabase, bucket, prefix) {
  const results = [];

  const { data, error } = await supabase.storage.from(bucket).list(prefix, {
    limit: 1000,
    sortBy: { column: 'name', order: 'asc' },
  });

  if (error) throw error;

  for (const item of data) {
    const itemPath = prefix ? `${prefix}/${item.name}` : item.name;

    // Supabase Storage returns folders as entries with metadata === null
    const isFolder = item.id === null && item.metadata === null;

    if (isFolder) {
      const nested = await listAllFiles(supabase, bucket, itemPath);
      results.push(...nested);
    } else {
      results.push({
        name: item.name,
        path: itemPath,
        size: item.metadata ? item.metadata.size : undefined,
        updated_at: item.updated_at,
      });
    }
  }

  return results;
}
