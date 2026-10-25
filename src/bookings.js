'use strict';
const crypto = require('node:crypto');
const { HttpError } = require('./http');
const { getSettings, tx } = require('./db');

const STATUSES = ['new', 'confirmed', 'in_progress', 'ready', 'completed', 'cancelled', 'no_show'];
const INACTIVE = ['cancelled', 'no_show'];

function str(v, max, label, required = false) {
  const s = v == null ? '' : String(v).trim();
  if (required && !s) throw new HttpError(400, `${label} is required`);
  if (s.length > max) throw new HttpError(400, `${label} is too long`);
  return s;
}

function normalisePhone(p) {
  const s = String(p || '').replace(/[^\d+]/g, '');
  return s.startsWith('+') ? '+' + s.slice(1).replace(/\+/g, '') : s.replace(/\+/g, '');
}

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00');
  return !Number.isNaN(d.getTime()) && localDate(d) === s;
}

// Returns [{time, available}] for a date, based on opening hours, slot length and bay capacity.
function slotsFor(db, date, { now = new Date(), ignoreBookingId = null } = {}) {
  if (!isValidDate(date)) throw new HttpError(400, 'Invalid date');
  const s = getSettings(db);
  const hours = JSON.parse(s.hours || '{}');
  const closed = JSON.parse(s.closed_dates || '[]');
  const day = new Date(date + 'T00:00:00').getDay();
  const range = hours[day];
  if (!range || closed.includes(date)) return { open: false, slots: [] };

  const step = Math.max(15, Number(s.slot_minutes) || 60);
  const capacity = Math.max(1, Number(s.slot_capacity) || 1);
  const taken = new Map();
  const rows = db
    .prepare(`SELECT time, COUNT(*) n FROM bookings WHERE date = ? AND status NOT IN ('cancelled','no_show') AND id IS NOT ? GROUP BY time`)
    .all(date, ignoreBookingId);
  for (const r of rows) taken.set(r.time, r.n);

  const today = localDate(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const slots = [];
  // Last bookable slot starts one step before closing.
  for (let m = toMin(range[0]); m + step <= toMin(range[1]); m += step) {
    const time = fromMin(m);
    const past = date < today || (date === today && m <= nowMin + 30);
    slots.push({ time, available: !past && (taken.get(time) || 0) < capacity });
  }
  return { open: true, slots };
}

function newRef(db) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let ref = 'CG-';
    for (const b of crypto.randomBytes(6)) ref += alphabet[b % alphabet.length];
    if (!db.prepare('SELECT 1 FROM bookings WHERE ref = ?').get(ref)) return ref;
  }
}

function upsertCustomer(db, { name, phone, email }) {
  const existing = db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);
  if (existing) {
    db.prepare(`UPDATE customers SET name = ?, email = CASE WHEN ? <> '' THEN ? ELSE email END WHERE id = ?`).run(name, email, email, existing.id);
    return existing.id;
  }
  return Number(db.prepare('INSERT INTO customers (name, phone, email) VALUES (?, ?, ?)').run(name, phone, email).lastInsertRowid);
}

function upsertVehicle(db, customerId, { rego, make, model, year }) {
  if (!rego && !make && !model) return null;
  const existing = rego
    ? db.prepare('SELECT id FROM vehicles WHERE customer_id = ? AND upper(rego) = upper(?)').get(customerId, rego)
    : db.prepare("SELECT id FROM vehicles WHERE customer_id = ? AND rego = '' AND make = ? AND model = ?").get(customerId, make, model);
  if (existing) {
    db.prepare(`UPDATE vehicles SET make = coalesce(nullif(?, ''), make), model = coalesce(nullif(?, ''), model),
      year = coalesce(nullif(?, ''), year) WHERE id = ?`).run(make, model, year, existing.id);
    return existing.id;
  }
  return Number(
    db.prepare('INSERT INTO vehicles (customer_id, rego, make, model, year) VALUES (?, ?, ?, ?, ?)').run(customerId, rego.toUpperCase(), make, model, year)
      .lastInsertRowid,
  );
}

function parseBookingInput(body) {
  const phone = normalisePhone(str(body.phone, 30, 'Phone', true));
  if (phone.replace('+', '').length < 8) throw new HttpError(400, 'Please enter a valid phone number');
  const email = str(body.email, 120, 'Email');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Please enter a valid email');
  const date = str(body.date, 10, 'Date', true);
  const time = str(body.time, 5, 'Time', true);
  if (!/^\d{2}:\d{2}$/.test(time)) throw new HttpError(400, 'Invalid time');
  return {
    name: str(body.name, 80, 'Name', true),
    phone,
    email,
    rego: str(body.rego, 15, 'Rego / plate'),
    make: str(body.make, 40, 'Make'),
    model: str(body.model, 40, 'Model'),
    year: str(body.year, 4, 'Year'),
    service_id: body.service_id ? Number(body.service_id) : null,
    date,
    time,
    notes: str(body.notes, 1000, 'Notes'),
  };
}

// Creates a booking. `staff` bookings (phone / walk-in) may overbook a slot; web bookings may not.
function createBooking(db, body, { source = 'web', userId = null, now = new Date() } = {}) {
  const input = parseBookingInput(body);
  if (input.service_id && !db.prepare('SELECT 1 FROM services WHERE id = ? AND (active = 1 OR ?)').get(input.service_id, source !== 'web' ? 1 : 0)) {
    throw new HttpError(400, 'Please choose a valid service');
  }
  return tx(db, () => {
    if (source === 'web') {
      const settings = getSettings(db);
      const maxDate = localDate(new Date(now.getTime() + Number(settings.booking_days_ahead || 45) * 864e5));
      if (input.date > maxDate) throw new HttpError(400, 'That date is too far ahead — please call us.');
      const { slots } = slotsFor(db, input.date, { now });
      const slot = slots.find((x) => x.time === input.time);
      if (!slot || !slot.available) throw new HttpError(409, 'Sorry, that time was just taken. Please pick another slot.');
    } else if (!isValidDate(input.date)) {
      throw new HttpError(400, 'Invalid date');
    }
    const customerId = upsertCustomer(db, input);
    const vehicleId = upsertVehicle(db, customerId, input);
    const ref = newRef(db);
    const id = Number(
      db
        .prepare(`INSERT INTO bookings (ref, customer_id, vehicle_id, service_id, date, time, source, customer_notes, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(ref, customerId, vehicleId, input.service_id, input.date, input.time, source, input.notes, source === 'web' ? 'new' : 'confirmed')
        .lastInsertRowid,
    );
    // Pre-fill the job card with the service's listed price so the quote starts somewhere sensible.
    const svc = input.service_id ? db.prepare('SELECT name, price_cents, price_type FROM services WHERE id = ?').get(input.service_id) : null;
    if (svc && svc.price_type !== 'quote') {
      db.prepare("INSERT INTO job_items (booking_id, kind, description, qty, unit_cents) VALUES (?, 'labour', ?, 1, ?)").run(id, svc.name, svc.price_cents);
    }
    logActivity(db, id, userId, source === 'web' ? 'Booked online' : `Booking created (${source})`);
    return { id, ref };
  });
}

function logActivity(db, bookingId, userId, message) {
  db.prepare('INSERT INTO activity (booking_id, user_id, message) VALUES (?, ?, ?)').run(bookingId, userId, message);
}

function totals(items, taxRate) {
  const subtotal = items.reduce((sum, i) => sum + Math.round(i.qty * i.unit_cents), 0);
  const tax = Math.round((subtotal * (Number(taxRate) || 0)) / 100);
  return { subtotal, tax, total: subtotal + tax };
}

module.exports = { STATUSES, INACTIVE, str, normalisePhone, localDate, isValidDate, slotsFor, createBooking, logActivity, totals };
