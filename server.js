'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Minimal .env loader so the app runs with zero dependencies.
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const db = require('./src/db').open(path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data')));
const { ensureOwner } = require('./src/auth');
const { createApp } = require('./src/app');

function notify(event, data) {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url) return;
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event, data }), signal: AbortSignal.timeout(5000) }).catch(
    (err) => console.warn('Webhook failed:', err.message),
  );
}

const created = ensureOwner(db);
if (created) {
  console.log(`\n  Owner account created: ${created.email}`);
  if (created.password) console.log(`  Temporary password:    ${created.password}\n  Sign in at /admin/ and change it under Settings.\n`);
}

if (process.env.SEED_DEMO === '1' && require('./src/demo').seedDemo(db)) console.log('  Demo data seeded.');

const handler = createApp(db, { notify });
// Demo deployments stay out of search results so placeholder details never get indexed.
const server = http.createServer(
  process.env.SEED_DEMO === '1'
    ? (req, res) => {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        handler(req, res);
      }
    : handler,
);
server.keepAliveTimeout = 65_000;
const port = Number(process.env.PORT) || 3000;
server.listen(port, () => console.log(`Chobbar Garage running on http://localhost:${port}  (CRM: /admin/)`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
