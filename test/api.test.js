'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { open } = require('../src/db');
const { ensureOwner } = require('../src/auth');
const { createApp } = require('../src/app');
const { localDate } = require('../src/bookings');

// Pinned "now": Monday 2030-01-07 07:00 local, so slot availability is deterministic.
const NOW = new Date(2030, 0, 7, 7, 0, 0);
const MONDAY = localDate(NOW);
const SUNDAY = '2030-01-13';

let server;
let base;
let cookie = '';

async function req(method, path, body, { auth = false } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

const booking = (over = {}) => ({
  name: 'Gurpreet Singh',
  phone: '+1 604 555 0199',
  make: 'BMW',
  model: 'M5',
  year: '2022',
  rego: 'chob01',
  service_id: 1,
  date: MONDAY,
  time: '09:00',
  consent: true,
  ...over,
});

before(async () => {
  process.env.ADMIN_EMAIL = 'owner@test.local';
  process.env.ADMIN_PASSWORD = 'correct-horse-battery';
  const db = open(':memory:');
  ensureOwner(db);
  server = http.createServer(createApp(db, { now: () => NOW }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('home page renders services from the database', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.data, /General Service/);
  assert.match(r.data, /From \$149/);
  assert.doesNotMatch(r.data, /\{\{[A-Z_]+\}\}/, 'no unreplaced template variables');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
});

test('slots respect opening hours and closed days', async () => {
  const mon = await req('GET', '/api/slots?date=' + MONDAY);
  assert.equal(mon.data.open, true);
  assert.equal(mon.data.slots[0].time, '08:00');
  assert.equal(mon.data.slots.at(-1).time, '17:00');
  const sun = await req('GET', '/api/slots?date=' + SUNDAY);
  assert.equal(sun.data.open, false);
});

test('online booking creates customer, vehicle and fills capacity', async () => {
  const a = await req('POST', '/api/bookings', booking());
  assert.equal(a.status, 200);
  assert.match(a.data.ref, /^CG-[A-Z0-9]{6}$/);
  const b = await req('POST', '/api/bookings', booking({ phone: '0400 000 111', name: 'Simran' }));
  assert.equal(b.status, 200);
  // Capacity is 2 bays per slot, so the third booking at 09:00 must be rejected.
  const c = await req('POST', '/api/bookings', booking({ phone: '0400 000 222' }));
  assert.equal(c.status, 409);
  const slots = await req('GET', '/api/slots?date=' + MONDAY);
  assert.equal(slots.data.slots.find((s) => s.time === '09:00').available, false);
});

test('booking validation and spam protection', async () => {
  assert.equal((await req('POST', '/api/bookings', booking({ consent: false, time: '10:00' }))).status, 400);
  assert.equal((await req('POST', '/api/bookings', booking({ phone: '12', time: '10:00' }))).status, 400);
  assert.equal((await req('POST', '/api/bookings', booking({ website: 'http://spam', time: '10:00' }))).status, 400);
  assert.equal((await req('POST', '/api/bookings', booking({ date: SUNDAY }))).status, 409);
});

test('admin API requires login', async () => {
  assert.equal((await req('GET', '/api/admin/bookings')).status, 401);
  const bad = await req('POST', '/api/admin/login', { email: 'owner@test.local', password: 'nope' });
  assert.equal(bad.status, 401);
  const ok = await req('POST', '/api/admin/login', { email: 'owner@test.local', password: 'correct-horse-battery' });
  assert.equal(ok.status, 200);
  const set = ok.headers.get('set-cookie');
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  cookie = set.split(';')[0];
});

test('job card, workflow and payment', async () => {
  const list = await req('GET', '/api/admin/bookings?view=all', null, { auth: true });
  const target = list.data.find((b) => b.customer_name === 'Gurpreet Singh');
  assert.equal(target.rego, 'CHOB01');

  const items = await req('PUT', `/api/admin/bookings/${target.id}/items`, {
    items: [
      { kind: 'labour', description: 'General Service', qty: 1, unit_cents: 14900 },
      { kind: 'part', description: 'Oil filter', qty: 2, unit_cents: 1250 },
    ],
  }, { auth: true });
  assert.equal(items.data.totals.subtotal, 17400);

  for (const status of ['confirmed', 'in_progress', 'ready', 'completed']) {
    const r = await req('PATCH', `/api/admin/bookings/${target.id}`, { status }, { auth: true });
    assert.equal(r.data.status, status);
  }
  const paid = await req('PATCH', `/api/admin/bookings/${target.id}`, { paid: true, payment_method: 'Card' }, { auth: true });
  assert.equal(paid.data.paid, 1);
  assert.ok(paid.data.activity.some((a) => a.message.startsWith('Marked paid')));

  const dash = await req('GET', '/api/admin/dashboard', null, { auth: true });
  assert.equal(dash.data.monthRevenue, 17400);
});

test('repeat customers are matched by phone', async () => {
  const again = await req('POST', '/api/bookings', booking({ time: '11:00', rego: 'CHOB01' }));
  assert.equal(again.status, 200);
  const customers = await req('GET', '/api/admin/customers?q=Gurpreet', null, { auth: true });
  assert.equal(customers.data.length, 1);
  assert.equal(customers.data[0].visits, 2);
  const detail = await req('GET', '/api/admin/customers/' + customers.data[0].id, null, { auth: true });
  assert.equal(detail.data.vehicles.length, 1);
});

test('rate changes appear on the website immediately', async () => {
  const r = await req('PATCH', '/api/admin/services/1', { price_cents: 16900 }, { auth: true });
  assert.equal(r.data.price_cents, 16900);
  const home = await req('GET', '/');
  assert.match(home.data, /From \$169/);
});

test('settings validate hours and are owner-only', async () => {
  const bad = await req('PUT', '/api/admin/settings', { hours: { 1: ['18:00', '08:00'] } }, { auth: true });
  assert.equal(bad.status, 400);
  const ok = await req('PUT', '/api/admin/settings', { tax_rate: '5', tax_name: 'GST', closed_dates: [SUNDAY, MONDAY] }, { auth: true });
  assert.equal(ok.data.tax_rate, '5');
  assert.deepEqual(ok.data.closed_dates, [MONDAY, SUNDAY]);
});

test('CSV export neutralises spreadsheet formulas', async () => {
  await req('POST', '/api/bookings', booking({ name: '=HYPERLINK("x")', phone: '0400 999 888', date: '2030-01-08', time: '09:00' }));
  const csv = await req('GET', '/api/admin/export/bookings.csv', null, { auth: true });
  assert.equal(csv.status, 200);
  assert.match(csv.data, /"'=HYPERLINK\(""x""\)"/);
});

test('cross-origin admin writes are blocked', async () => {
  const res = await fetch(base + '/api/admin/services/1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'https://evil.example' },
    body: '{}',
  });
  assert.equal(res.status, 403);
});
