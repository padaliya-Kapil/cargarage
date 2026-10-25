'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { getSettings } = require('./db');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function money(cents, currency) {
  const v = cents / 100;
  return currency + (Number.isInteger(v) ? v.toString() : v.toFixed(2));
}

function priceLabel(svc, currency) {
  if (svc.price_type === 'quote') return 'On quote';
  if (svc.price_type === 'from') return `From ${money(svc.price_cents, currency)}`;
  return money(svc.price_cents, currency);
}

function fmtTime(t) {
  const [h, m] = t.split(':').map(Number);
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}${suffix}` : `${h12}${suffix}`;
}

// Groups consecutive days with identical hours: "Mon – Fri  8am – 6pm".
function hoursRows(hours) {
  const rows = [];
  for (const d of DAY_ORDER) {
    const r = hours[d] || null;
    const label = r ? `${fmtTime(r[0])} – ${fmtTime(r[1])}` : 'Closed';
    const last = rows[rows.length - 1];
    if (last && last.label === label) last.to = d;
    else rows.push({ from: d, to: d, label });
  }
  return rows.map((r) => ({ days: r.from === r.to ? DAY_NAMES[r.from] : `${DAY_NAMES[r.from]} – ${DAY_NAMES[r.to]}`, label: r.label }));
}

function renderServices(services, currency) {
  return services
    .map(
      (s) => `<article class="svc">
  <div class="svc-top"><svg class="ico" aria-hidden="true"><use href="#i-${esc(s.icon)}"/></svg><span class="tag">${esc(s.category)}</span></div>
  <h3>${esc(s.name)}</h3>
  <p>${esc(s.description)}</p>
  <div class="svc-foot"><span class="price">${esc(priceLabel(s, currency))}</span><a class="svc-book" href="#book" data-service="${s.id}">Book <span aria-hidden="true">→</span></a></div>
</article>`,
    )
    .join('\n');
}

function renderTestimonials(items) {
  if (!items.length) return '';
  const cards = items
    .map(
      (t) => `<figure class="review">
  <div class="stars" aria-label="${t.rating} out of 5 stars">${'★'.repeat(t.rating)}<span>${'★'.repeat(5 - t.rating)}</span></div>
  <blockquote>${esc(t.text)}</blockquote>
  <figcaption><strong>${esc(t.name)}</strong>${t.vehicle ? ` · ${esc(t.vehicle)}` : ''}</figcaption>
</figure>`,
    )
    .join('\n');
  return `<section class="section" id="reviews" aria-labelledby="reviews-h">
  <div class="wrap">
    <p class="eyebrow">Word on the street</p>
    <h2 id="reviews-h">Customers who keep coming back</h2>
    <div class="reviews">${cards}</div>
  </div>
</section>`;
}

function jsonLd(s, hours) {
  const spec = [];
  for (const d of DAY_ORDER) {
    const r = hours[d];
    if (r) spec.push({ '@type': 'OpeningHoursSpecification', dayOfWeek: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d], opens: r[0], closes: r[1] });
  }
  // `<` is escaped so the JSON can never close the script tag.
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'AutoRepair',
    name: s.business_name,
    slogan: s.tagline,
    telephone: s.phone,
    email: s.email,
    address: s.address,
    openingHoursSpecification: spec,
  }).replace(/</g, '\\u003c');
}

function createSiteRenderer(db, publicDir) {
  const templatePath = path.join(publicDir, 'index.html');
  let cached = null;
  let cachedVersion = -1;
  let templateMtime = 0;
  let version = 0;

  function render() {
    const mtime = fs.statSync(templatePath).mtimeMs;
    if (cached && cachedVersion === version && mtime === templateMtime) return cached;
    const tpl = fs.readFileSync(templatePath, 'utf8');
    const s = getSettings(db);
    const hours = JSON.parse(s.hours || '{}');
    const services = db.prepare('SELECT * FROM services WHERE active = 1 ORDER BY sort, id').all();
    const testimonials = db.prepare('SELECT * FROM testimonials WHERE active = 1 ORDER BY id DESC LIMIT 6').all();
    const tel = s.phone.replace(/[^\d+]/g, '');
    const wa = s.whatsapp.replace(/\D/g, '');
    const vars = {
      BUSINESS_NAME: esc(s.business_name),
      TAGLINE: esc(s.tagline),
      PHONE: esc(s.phone),
      TEL: esc(tel),
      WHATSAPP: esc(wa),
      EMAIL: esc(s.email),
      ADDRESS: esc(s.address),
      MAPS_URL: esc(s.maps_url),
      WARRANTY: esc(s.warranty),
      LABOUR_RATE: esc(money(Number(s.labour_rate_cents) || 0, s.currency)),
      SERVICE_COUNT: String(services.length),
      SERVICES: renderServices(services, s.currency),
      SERVICE_OPTIONS: services.map((x) => `<option value="${x.id}" data-name="${esc(x.name)}">${esc(x.name)} — ${esc(priceLabel(x, s.currency))}</option>`).join(''),
      TESTIMONIALS: renderTestimonials(testimonials),
      HOURS: hoursRows(hours)
        .map((r) => `<div class="hours-row"><dt>${r.days}</dt><dd>${r.label}</dd></div>`)
        .join(''),
      JSON_LD: jsonLd(s, hours),
      HOURS_DATA: esc(JSON.stringify({ hours, closed: JSON.parse(s.closed_dates || '[]'), days: Number(s.booking_days_ahead) || 45 })),
      YEAR: String(new Date().getFullYear()),
    };
    const html = tpl.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
    const body = Buffer.from(html);
    cached = {
      body,
      ext: '.html',
      etag: '"' + crypto.createHash('sha1').update(body).digest('base64url').slice(0, 16) + '"',
      br: zlib.brotliCompressSync(body),
      gzip: zlib.gzipSync(body),
    };
    cachedVersion = version;
    templateMtime = mtime;
    return cached;
  }

  return {
    render,
    invalidate() {
      version += 1;
    },
  };
}

module.exports = { createSiteRenderer, esc, priceLabel, money, hoursRows };
