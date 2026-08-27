// api/college-images.js
//
// Vercel Serverless Function for groq-api-sand.vercel.app.
// Serves college images from AletCloud S3-compatible object storage using
// ALETCLOUD_ACCESS_KEY and ALETCLOUD_SECRET_KEY.
//
// Endpoints / Actions:
//   1. GET /api/college-images?action=discover&limit=4
//      Returns a random set of college images with metadata for the Discover section.
//   2. GET /api/college-images?action=serve&key=<object_key>  (or ?key=<object_key>)
//      Streams the raw image directly from the AletCloud S3 bucket with proper Content-Type & cache headers.
//   3. GET /api/college-images?action=list
//      Lists all college objects found in the AletCloud bucket.
//   4. GET /api/college-images?action=test
//      Diagnostics and connection test (without exposing secrets).

import crypto from 'crypto';

// ── Environment Configuration ──────────────────────────────────────────────────
function getConfig() {
  const accessKey = process.env.ALETCLOUD_ACCESS_KEY || process.env.ALETCLOUD_ACCESS_KEY_ID || '';
  const secretKey = process.env.ALETCLOUD_SECRET_KEY || process.env.ALETCLOUD_SECRET_ACCESS_KEY || '';
  const rawEndpoint = process.env.ALETCLOUD_ENDPOINT || 'https://s3.aletcloud.com';
  const bucketName = process.env.ALETCLOUD_BUCKET_NAME || process.env.ALETCLOUD_BUCKET || 'college-images';
  const region = process.env.ALETCLOUD_REGION || 'auto';
  const publicUrlBase = process.env.ALETCLOUD_PUBLIC_URL || '';

  const endpointUrl = rawEndpoint.startsWith('http') ? rawEndpoint : `https://${rawEndpoint}`;
  const endpointObj = new URL(endpointUrl);

  return {
    accessKey,
    secretKey,
    endpoint: endpointObj.origin,
    host: endpointObj.host,
    bucketName,
    region,
    publicUrlBase: publicUrlBase ? publicUrlBase.replace(/\/+$/, '') : ''
  };
}

// ── SigV4 Authentication Helpers (Zero-dependency S3 client) ───────────────────
function hmac(key, string, encoding) {
  return crypto.createHmac('sha256', key).update(string, 'utf8').digest(encoding);
}

function sha256(string) {
  return crypto.createHash('sha256').update(string, 'utf8').digest('hex');
}

function getSignatureKey(key, dateStamp, regionName, serviceName) {
  const kDate = hmac('AWS4' + key, dateStamp);
  const kRegion = hmac(kDate, regionName);
  const kService = hmac(kRegion, serviceName);
  const kSigning = hmac(kService, 'aws4_request');
  return kSigning;
}

/**
 * Make an authenticated AWS SigV4 request to AletCloud S3.
 */
async function s3Request({ method = 'GET', path = '/', query = {}, config, payload = '' }) {
  const { accessKey, secretKey, endpoint, host, region } = config;

  if (!accessKey || !secretKey) {
    throw new Error('ALETCLOUD_ACCESS_KEY or ALETCLOUD_SECRET_KEY is missing from environment variables');
  }

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // e.g. 20260827T160000Z
  const dateStamp = amzDate.slice(0, 8); // e.g. 20260827

  // Normalize query parameters
  const queryKeys = Object.keys(query).sort();
  const canonicalQueryString = queryKeys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join('&');

  // Ensure path is properly encoded
  const canonicalUri = '/' + path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');

  const payloadHash = sha256(payload);

  // Canonical headers
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256(canonicalRequest)
  ].join('\n');

  const signingKey = getSignatureKey(secretKey, dateStamp, region, 's3');
  const signature = hmac(signingKey, stringToSign, 'hex');

  const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const requestUrl = `${endpoint}${canonicalUri}${canonicalQueryString ? '?' + canonicalQueryString : ''}`;

  const response = await fetch(requestUrl, {
    method,
    headers: {
      Host: host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      Authorization: authorizationHeader
    }
  });

  return response;
}

// ── XML Parsing Helper for S3 ListObjectsV2 ─────────────────────────────────────
function parseS3ListObjectsXml(xmlText) {
  const keys = [];
  const keyRegex = /<Key>(.*?)<\/Key>/g;
  let match;
  while ((match = keyRegex.exec(xmlText)) !== null) {
    keys.push(match[1]);
  }
  return keys;
}

// ── Filename / College Metadata Parsing ─────────────────────────────────────────
const IMAGE_EXT_REGEX = /\.(jpg|jpeg|png|webp|avif|gif|svg)$/i;

function isImageKey(key) {
  return IMAGE_EXT_REGEX.test(key);
}

function formatCollegeName(slug) {
  return slug
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Parse an S3 object key into college name and category/detail.
 * Supports patterns:
 *   - "stanford_university/building/01.jpg"
 *   - "harvard_university/scenery.jpg"
 *   - "colleges/mit/campus.png"
 *   - "oxford_building.jpg"
 */
function parseKeyToCollege(key) {
  const parts = key.replace(/^\/+/, '').split('/');
  const filename = parts[parts.length - 1];
  const cleanFilename = filename.replace(IMAGE_EXT_REGEX, '');

  let collegeName = '';
  let detail = '';

  if (parts.length >= 3) {
    // e.g. "colleges/stanford/building/1.jpg" or "stanford/building/1.jpg"
    if (parts[0].toLowerCase() === 'colleges' || parts[0].toLowerCase() === 'college') {
      collegeName = formatCollegeName(parts[1]);
      detail = formatCollegeName(parts[2]);
    } else {
      collegeName = formatCollegeName(parts[0]);
      detail = formatCollegeName(parts[1]);
    }
  } else if (parts.length === 2) {
    // e.g. "stanford_university/campus.jpg"
    collegeName = formatCollegeName(parts[0]);
    detail = formatCollegeName(cleanFilename);
  } else {
    // e.g. "stanford_university_building.jpg"
    const nameParts = cleanFilename.split(/[_-]/);
    if (nameParts.length > 1) {
      detail = formatCollegeName(nameParts.pop());
      collegeName = formatCollegeName(nameParts.join(' '));
    } else {
      collegeName = formatCollegeName(cleanFilename);
      detail = 'Campus';
    }
  }

  // Standardize detail labels
  const lowerDetail = detail.toLowerCase();
  if (lowerDetail.includes('build')) detail = 'Building';
  else if (lowerDetail.includes('scen') || lowerDetail.includes('view')) detail = 'Scenery';
  else if (lowerDetail.includes('class')) detail = 'Classroom';
  else if (lowerDetail.includes('dorm') || lowerDetail.includes('hous')) detail = 'Housing';
  else if (lowerDetail.includes('lib')) detail = 'Library';
  else if (lowerDetail.includes('camp')) detail = 'Campus';
  else if (!detail || detail === collegeName) detail = 'Campus';

  return { college: collegeName, detail };
}

function getContentType(key) {
  const ext = (key.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'avif':
      return 'image/avif';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

// ── In-Memory Cache for Object Keys ────────────────────────────────────────────
let cachedKeys = null;
let cachedKeysTimestamp = 0;
const CACHE_TTL_MS = 60 * 1000; // 1 minute

async function getBucketImageKeys(config, fresh = false) {
  const now = Date.now();
  if (!fresh && cachedKeys && (now - cachedKeysTimestamp) < CACHE_TTL_MS) {
    return cachedKeys;
  }

  const { bucketName } = config;
  const path = `/${bucketName}`;
  const response = await s3Request({
    method: 'GET',
    path,
    query: { 'list-type': '2', 'max-keys': '1000' },
    config
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`S3 ListObjectsV2 failed [HTTP ${response.status}]: ${errorText.slice(0, 300)}`);
  }

  const xmlText = await response.text();
  const allKeys = parseS3ListObjectsXml(xmlText);
  const imageKeys = allKeys.filter(isImageKey);

  cachedKeys = imageKeys;
  cachedKeysTimestamp = now;

  return imageKeys;
}

// ── Main Handler ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // 1. CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const config = getConfig();

  // Support both req.query (Node / Express / Vercel) and URL parsing
  let searchParams;
  if (req.query) {
    searchParams = new URLSearchParams(req.query);
  } else {
    const parsedUrl = new URL(req.url, `http://${req.headers?.host || 'localhost'}`);
    searchParams = parsedUrl.searchParams;
  }

  const action = searchParams.get('action') || (searchParams.get('key') ? 'serve' : 'discover');
  const keyParam = searchParams.get('key');
  const fresh = searchParams.get('fresh') === '1';
  const limit = Math.max(1, Math.min(20, parseInt(searchParams.get('limit') || '4', 10)));

  // Host URL for proxy URLs
  const host = req.headers?.['x-forwarded-host'] || req.headers?.host || 'groq-api-sand.vercel.app';
  const proto = req.headers?.['x-forwarded-proto'] || 'https';
  const currentBaseUrl = `${proto}://${host}`;

  try {
    // ── Action 1: SERVE raw image binary ───────────────────────────────────────
    if (action === 'serve' || keyParam) {
      const key = keyParam || searchParams.get('key');
      if (!key) {
        res.status(400).json({ ok: false, error: 'Missing key parameter' });
        return;
      }

      const s3Path = `/${config.bucketName}/${key.replace(/^\/+/, '')}`;
      const s3Res = await s3Request({
        method: 'GET',
        path: s3Path,
        config
      });

      if (!s3Res.ok) {
        res.status(s3Res.status).json({
          ok: false,
          error: `Failed to fetch object from AletCloud S3 [HTTP ${s3Res.status}]`,
          key
        });
        return;
      }

      const contentType = s3Res.headers.get('content-type') || getContentType(key);
      const contentLength = s3Res.headers.get('content-length');

      res.setHeader('Content-Type', contentType);
      if (contentLength) res.setHeader('Content-Length', contentLength);
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400');

      const arrayBuffer = await s3Res.arrayBuffer();
      res.status(200).send(Buffer.from(arrayBuffer));
      return;
    }

    // ── Action 2: DISCOVER college images ──────────────────────────────────────
    if (action === 'discover') {
      const imageKeys = await getBucketImageKeys(config, fresh);

      if (!imageKeys || imageKeys.length === 0) {
        res.status(200).json({
          ok: true,
          items: [],
          message: 'No image objects found in the AletCloud bucket',
          bucket: config.bucketName
        });
        return;
      }

      // Group images by college name to ensure diversity
      const collegeMap = new Map();
      for (const key of imageKeys) {
        const parsed = parseKeyToCollege(key);
        if (!collegeMap.has(parsed.college)) {
          collegeMap.set(parsed.college, []);
        }
        collegeMap.get(parsed.college).push({ key, detail: parsed.detail, college: parsed.college });
      }

      // Shuffle colleges
      const colleges = Array.from(collegeMap.keys()).sort(() => 0.5 - Math.random());
      const selectedColleges = colleges.slice(0, limit);

      const items = selectedColleges.map((collegeName) => {
        const collegeImages = collegeMap.get(collegeName);
        const chosen = collegeImages[Math.floor(Math.random() * collegeImages.length)];

        // Build image URL: prefer public URL base if configured, otherwise proxy through this endpoint
        const imageUrl = config.publicUrlBase
          ? `${config.publicUrlBase}/${config.bucketName}/${chosen.key}`
          : `${currentBaseUrl}/api/college-images?action=serve&key=${encodeURIComponent(chosen.key)}`;

        return {
          college: chosen.college,
          detail: chosen.detail,
          image: imageUrl,
          key: chosen.key
        };
      });

      res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
      res.status(200).json({
        ok: true,
        count: items.length,
        items
      });
      return;
    }

    // ── Action 3: LIST all keys in bucket ──────────────────────────────────────
    if (action === 'list') {
      const imageKeys = await getBucketImageKeys(config, fresh);
      const items = imageKeys.map((key) => {
        const parsed = parseKeyToCollege(key);
        return {
          key,
          college: parsed.college,
          detail: parsed.detail,
          url: `${currentBaseUrl}/api/college-images?action=serve&key=${encodeURIComponent(key)}`
        };
      });

      res.status(200).json({
        ok: true,
        count: items.length,
        items
      });
      return;
    }

    // ── Action 4: TEST / Status diagnostics ────────────────────────────────────
    if (action === 'test' || action === 'status') {
      const hasAccessKey = Boolean(config.accessKey);
      const hasSecretKey = Boolean(config.secretKey);

      let bucketStatus = 'unknown';
      let objectCount = 0;
      let sampleKeys = [];
      let errorMessage = null;

      try {
        const keys = await getBucketImageKeys(config, true);
        bucketStatus = 'connected';
        objectCount = keys.length;
        sampleKeys = keys.slice(0, 5);
      } catch (err) {
        bucketStatus = 'error';
        errorMessage = err.message;
      }

      res.status(200).json({
        ok: bucketStatus === 'connected',
        config: {
          hasAccessKey,
          hasSecretKey,
          accessKeyPreview: config.accessKey ? `${config.accessKey.slice(0, 4)}...${config.accessKey.slice(-2)}` : null,
          endpoint: config.endpoint,
          bucketName: config.bucketName,
          region: config.region
        },
        bucketStatus,
        objectCount,
        sampleKeys,
        error: errorMessage
      });
      return;
    }

    res.status(400).json({
      ok: false,
      error: `Unknown action: ${action}. Valid actions: discover, serve, list, test`
    });
  } catch (error) {
    console.error('[AletCloud Images Endpoint Error]', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'Internal server error',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}
