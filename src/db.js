'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('owner','staff')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Repairs',
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL DEFAULT 0,
  price_type TEXT NOT NULL DEFAULT 'from' CHECK (price_type IN ('fixed','from','quote')),
  duration_min INTEGER NOT NULL DEFAULT 60,
  icon TEXT NOT NULL DEFAULT 'wrench',
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  rego TEXT NOT NULL DEFAULT '',
  make TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  year TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS vehicles_customer ON vehicles(customer_id);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  vehicle_id INTEGER REFERENCES vehicles(id),
  service_id INTEGER REFERENCES services(id),
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','confirmed','in_progress','ready','completed','cancelled','no_show')),
  source TEXT NOT NULL DEFAULT 'web',
  customer_notes TEXT NOT NULL DEFAULT '',
  internal_notes TEXT NOT NULL DEFAULT '',
  odometer TEXT NOT NULL DEFAULT '',
  paid INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT '',
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bookings_date ON bookings(date, time);
CREATE INDEX IF NOT EXISTS bookings_customer ON bookings(customer_id);
CREATE TABLE IF NOT EXISTS job_items (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'labour' CHECK (kind IN ('labour','part','other')),
  description TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  unit_cents INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS job_items_booking ON job_items(booking_id);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS activity_booking ON activity(booking_id);
CREATE TABLE IF NOT EXISTS enquiries (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS testimonials (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  vehicle TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  rating INTEGER NOT NULL DEFAULT 5 CHECK (rating BETWEEN 1 AND 5),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// Everything here is editable in CRM -> Settings. Placeholders are marked so they're easy to spot.
const DEFAULT_SETTINGS = {
  business_name: 'Chobbar Garage',
  tagline: 'Built tough. Fixed right.',
  phone: '+1 000 000 0000',
  whatsapp: '10000000000',
  email: 'hello@chobbargarage.com',
  address: '123 Workshop Road, Your City',
  maps_url: 'https://maps.google.com/?q=Chobbar+Garage',
  abn: '',
  country_code: '1',
  currency: '$',
  tax_name: 'Tax',
  tax_rate: '0',
  labour_rate_cents: '12000',
  warranty: '12 months / 20,000 km',
  slot_minutes: '60',
  slot_capacity: '2',
  booking_days_ahead: '45',
  // 0 = Sunday ... 6 = Saturday. null = closed.
  hours: JSON.stringify({
    0: null,
    1: ['08:00', '18:00'],
    2: ['08:00', '18:00'],
    3: ['08:00', '18:00'],
    4: ['08:00', '18:00'],
    5: ['08:00', '18:00'],
    6: ['09:00', '14:00'],
  }),
  closed_dates: '[]',
  invoice_footer: 'Thank you for choosing Chobbar Garage. Payment due on collection.',
};

const DEFAULT_SERVICES = [
  ['General Service', 'Servicing', 'Oil, filters, fluids, brakes and a 50-point safety check. Keeps your logbook warranty intact.', 14900, 'from', 120, 'gauge'],
  ['Oil & Filter Change', 'Servicing', 'Quality synthetic oil and a new filter, done while you wait.', 7900, 'from', 45, 'drop'],
  ['Brakes — Pads & Rotors', 'Repairs', 'Squeal, shudder or soft pedal? Inspect, machine or replace pads and rotors.', 19900, 'from', 120, 'disc'],
  ['Diagnostics & Check Engine', 'Diagnostics', 'Full computer scan plus a real technician who explains the fault in plain words.', 8900, 'fixed', 60, 'scan'],
  ['Tyres & Wheel Alignment', 'Tyres', 'Supply, fit, balance and laser alignment so she drives straight and tyres last.', 8900, 'from', 60, 'tyre'],
  ['Battery Test & Replace', 'Electrical', 'Free test. New batteries fitted with warranty and the system reset.', 15900, 'from', 30, 'battery'],
  ['AC Re-gas & Repair', 'Repairs', 'Leak test, re-gas and repairs so the cabin stays ice cold in summer.', 12900, 'from', 60, 'snow'],
  ['Suspension & Steering', 'Repairs', 'Shocks, struts, bushes and steering parts — ride height and handling sorted.', 0, 'quote', 180, 'spring'],
  ['Clutch & Transmission', 'Repairs', 'Slipping clutch, rough shifts or gearbox noise. We diagnose before we quote.', 0, 'quote', 480, 'gear'],
  ['Pre-Purchase Inspection', 'Diagnostics', 'Buying used? A full report before you hand over the money.', 12900, 'fixed', 90, 'search'],
  ['Blackout Detail', 'Detailing', 'Paint correction, deep clean and ceramic protection. The finish a black car deserves.', 19900, 'from', 240, 'shine'],
];

function open(dataDir) {
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    fs.mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, 'chobbar.db');
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);

  const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

  if (db.prepare('SELECT COUNT(*) n FROM services').get().n === 0) {
    const ins = db.prepare(`INSERT INTO services (name, category, description, price_cents, price_type, duration_min, icon, sort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    DEFAULT_SERVICES.forEach((s, i) => ins.run(...s, i));
  }
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getSettings(db) {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

module.exports = { open, tx, getSettings, DEFAULT_SETTINGS };
