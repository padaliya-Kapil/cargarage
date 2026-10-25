'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function json(res, status, data) {
  send(res, status, JSON.stringify(data), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        const data = JSON.parse(raw);
        if (typeof data !== 'object' || data === null || Array.isArray(data)) {
          return reject(new HttpError(400, 'Expected a JSON object'));
        }
        resolve(data);
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Tiny in-memory fixed-window rate limiter keyed by IP + bucket name.
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.reset < now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) throw new HttpError(429, 'Too many requests — please try again in a few minutes.');
  };
}

function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2',
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt', '.xml', '.webmanifest']);

// Serves files from `root`, keeping a compressed copy in memory (files are small; restart picks up changes
// in production, while dev mode re-reads on mtime change).
function staticServer(root) {
  const cache = new Map();
  function load(file) {
    const stat = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtime === stat.mtimeMs) return hit;
    const body = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    const entry = {
      mtime: stat.mtimeMs,
      body,
      ext,
      etag: '"' + crypto.createHash('sha1').update(body).digest('base64url').slice(0, 16) + '"',
      br: COMPRESSIBLE.has(ext) ? zlib.brotliCompressSync(body) : null,
      gzip: COMPRESSIBLE.has(ext) ? zlib.gzipSync(body) : null,
    };
    cache.set(file, entry);
    return entry;
  }
  return function serve(req, res, urlPath) {
    let rel;
    try {
      rel = decodeURIComponent(urlPath);
    } catch {
      return false;
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(root, path.normalize(rel));
    if (!file.startsWith(root + path.sep)) return false;
    let entry;
    try {
      if (!fs.statSync(file).isFile()) return false;
      entry = load(file);
    } catch {
      return false;
    }
    const headers = {
      'Content-Type': MIME[entry.ext] || 'application/octet-stream',
      ETag: entry.etag,
      Vary: 'Accept-Encoding',
      // HTML revalidates every time; assets are cached for a day and revalidated by ETag.
      'Cache-Control': entry.ext === '.html' ? 'no-cache' : 'public, max-age=86400, must-revalidate',
    };
    if (req.headers['if-none-match'] === entry.etag) {
      send(res, 304, null, headers);
      return true;
    }
    sendEncoded(req, res, entry, headers);
    return true;
  };
}

function sendEncoded(req, res, entry, headers) {
  const accept = String(req.headers['accept-encoding'] || '');
  let body = entry.body;
  if (entry.br && /\bbr\b/.test(accept)) {
    body = entry.br;
    headers['Content-Encoding'] = 'br';
  } else if (entry.gzip && /\bgzip\b/.test(accept)) {
    body = entry.gzip;
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = body.length;
  send(res, 200, req.method === 'HEAD' ? null : body, headers);
}

module.exports = { HttpError, send, json, readBody, parseCookies, rateLimiter, clientIp, staticServer, sendEncoded, SECURITY_HEADERS };
