'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { HttpError, json, send, readBody, rateLimiter, clientIp, staticServer, sendEncoded } = require('./http');
const auth = require('./auth');
const { getSettings, DEFAULT_SETTINGS } = require('./db');
const { STATUSES, str, normalisePhone, localDate, isValidDate, slotsFor, createBooking, logActivity, totals } = require('./bookings');
const { createSiteRenderer } = require('./site');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp(db, { now = () => new Date(), notify = () => {} } = {}) {
  const serveStatic = staticServer(PUBLIC_DIR);
  const site = createSiteRenderer(db, PUBLIC_DIR);
  const formLimit = rateLimiter({ windowMs: 15 * 60e3, max: 10 });
  const loginLimit = rateLimiter({ windowMs: 15 * 60e3, max: 8 });

  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, handler });
  };

  // ---------- Public API ----------

  route('GET', '/api/services', () => db.prepare('SELECT id, name, category, description, price_cents, price_type, duration_min FROM services WHERE active = 1 ORDER BY sort, id').all());

  route('GET', '/api/slots', ({ query }) => {
    const date = String(query.get('date') || '');
    const s = getSettings(db);
    const today = localDate(now());
    const max = localDate(new Date(now().getTime() + Number(s.booking_days_ahead || 45) * 864e5));
    if (isValidDate(date) && (date < today || date > max)) return { date, open: false, slots: [] };
    return { date, ...slotsFor(db, date, { now: now() }) };
  });

  route('POST', '/api/bookings', async ({ req, body }) => {
    formLimit('book:' + clientIp(req));
    if (body.website) throw new HttpError(400, 'Rejected'); // honeypot field, hidden from humans
    if (!body.consent) throw new HttpError(400, 'Please agree to be contacted about your booking');
    const { id, ref } = createBooking(db, body, { source: 'web', now: now() });
    notify('booking.created', bookingSummary(id));
    return { ok: true, ref };
  });

  route('POST', '/api/enquiries', ({ req, body }) => {
    formLimit('enq:' + clientIp(req));
    if (body.website) throw new HttpError(400, 'Rejected');
    const name = str(body.name, 80, 'Name', true);
    const phone = normalisePhone(str(body.phone, 30, 'Phone'));
    const email = str(body.email, 120, 'Email');
    const message = str(body.message, 2000, 'Message', true);
    if (!phone && !email) throw new HttpError(400, 'Please leave a phone number or email so we can reply');
    const id = Number(db.prepare('INSERT INTO enquiries (name, phone, email, message) VALUES (?, ?, ?, ?)').run(name, phone, email, message).lastInsertRowid);
    notify('enquiry.created', { id, name, phone, email, message });
    return { ok: true };
  });

  // ---------- Auth ----------

  route('POST', '/api/admin/login', ({ req, res, body }) => {
    loginLimit('login:' + clientIp(req));
    const email = str(body.email, 120, 'Email', true);
    const password = str(body.password, 200, 'Password', true);
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    if (!user || !auth.verifyPassword(password, user.password_hash)) throw new HttpError(401, 'Wrong email or password');
    const token = auth.createSession(db, user.id);
    res.setHeader('Set-Cookie', auth.sessionCookie(token, auth.SESSION_DAYS * 86400));
    return { id: user.id, name: user.name, email: user.email, role: user.role };
  });

  route('POST', '/api/admin/logout', ({ req, res }) => {
    const user = auth.currentUser(db, req);
    if (user) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(user.tokenHash);
    res.setHeader('Set-Cookie', auth.sessionCookie('', 0));
    return { ok: true };
  });

  // Everything below requires a signed-in user (enforced in the dispatcher by the /api/admin/ prefix).

  route('GET', '/api/admin/me', ({ user }) => ({ id: user.id, name: user.name, email: user.email, role: user.role, settings: publicSettings() }));

  route('POST', '/api/admin/password', ({ user, body }) => {
    const current = str(body.current, 200, 'Current password', true);
    const next = str(body.next, 200, 'New password', true);
    if (next.length < 10) throw new HttpError(400, 'Use at least 10 characters');
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!auth.verifyPassword(current, row.password_hash)) throw new HttpError(400, 'Current password is wrong');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(next), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(user.id, user.tokenHash);
    return { ok: true };
  });

  // ---------- Dashboard ----------

  route('GET', '/api/admin/dashboard', () => {
    const today = localDate(now());
    const monthStart = today.slice(0, 8) + '01';
    const s = getSettings(db);
    const count = (sql, ...a) => db.prepare(sql).get(...a).n;
    const revenue = (from, to) => {
      const rows = db
        .prepare(`SELECT ji.qty, ji.unit_cents FROM job_items ji JOIN bookings b ON b.id = ji.booking_id
          WHERE b.status = 'completed' AND b.date BETWEEN ? AND ?`)
        .all(from, to);
      return totals(rows, s.tax_rate).total;
    };
    const months = [];
    const d = new Date(now());
    d.setDate(1);
    for (let i = 5; i >= 0; i--) {
      const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
      const from = localDate(m);
      const to = localDate(new Date(m.getFullYear(), m.getMonth() + 1, 0));
      months.push({ month: from.slice(0, 7), total: revenue(from, to), jobs: count("SELECT COUNT(*) n FROM bookings WHERE status = 'completed' AND date BETWEEN ? AND ?", from, to) });
    }
    return {
      today,
      todayCount: count("SELECT COUNT(*) n FROM bookings WHERE date = ? AND status NOT IN ('cancelled','no_show')", today),
      newCount: count("SELECT COUNT(*) n FROM bookings WHERE status = 'new'"),
      inWorkshop: count("SELECT COUNT(*) n FROM bookings WHERE status IN ('in_progress','ready')"),
      openEnquiries: count("SELECT COUNT(*) n FROM enquiries WHERE status = 'open'"),
      unpaid: count("SELECT COUNT(*) n FROM bookings WHERE status = 'completed' AND paid = 0"),
      monthRevenue: revenue(monthStart, today.slice(0, 8) + '31'),
      months,
      topServices: db
        .prepare(`SELECT s.name, COUNT(*) n FROM bookings b JOIN services s ON s.id = b.service_id
          WHERE b.date >= ? AND b.status NOT IN ('cancelled','no_show') GROUP BY s.id ORDER BY n DESC LIMIT 5`)
        .all(localDate(new Date(now().getTime() - 90 * 864e5))),
      todayList: listBookings({ from: today, to: today, active: true }),
      upcoming: listBookings({ from: localDate(new Date(now().getTime() + 864e5)), active: true, limit: 8 }),
    };
  });

  // ---------- Bookings ----------

  function listBookings({ status, q, from, to, active, customerId, limit = 200 } = {}) {
    const where = [];
    const args = [];
    if (customerId) (where.push('b.customer_id = ?'), args.push(customerId));
    if (status) (where.push('b.status = ?'), args.push(status));
    if (active) where.push("b.status NOT IN ('cancelled','no_show','completed')");
    if (from) (where.push('b.date >= ?'), args.push(from));
    if (to) (where.push('b.date <= ?'), args.push(to));
    if (q) {
      where.push('(b.ref LIKE ? OR c.name LIKE ? OR c.phone LIKE ? OR v.rego LIKE ? OR v.make LIKE ? OR v.model LIKE ?)');
      const like = `%${q}%`;
      args.push(like, like, like, like, like, like);
    }
    args.push(Math.min(Number(limit) || 200, 1000));
    const s = getSettings(db);
    const rows = db
      .prepare(`SELECT b.id, b.ref, b.date, b.time, b.status, b.source, b.paid, c.id customer_id, c.name customer_name, c.phone,
          v.rego, v.make, v.model, v.year, s.name service_name,
          (SELECT coalesce(sum(round(qty * unit_cents)), 0) FROM job_items WHERE booking_id = b.id) subtotal
        FROM bookings b JOIN customers c ON c.id = b.customer_id
        LEFT JOIN vehicles v ON v.id = b.vehicle_id LEFT JOIN services s ON s.id = b.service_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY b.date ${from && !to ? 'ASC' : 'DESC'}, b.time ASC LIMIT ?`)
      .all(...args);
    for (const r of rows) r.total = r.subtotal + Math.round((r.subtotal * (Number(s.tax_rate) || 0)) / 100);
    return rows;
  }

  function bookingDetail(id) {
    const b = db
      .prepare(`SELECT b.*, c.name customer_name, c.phone, c.email, c.notes customer_profile_notes,
          v.rego, v.make, v.model, v.year, s.name service_name
        FROM bookings b JOIN customers c ON c.id = b.customer_id
        LEFT JOIN vehicles v ON v.id = b.vehicle_id LEFT JOIN services s ON s.id = b.service_id WHERE b.id = ?`)
      .get(id);
    if (!b) throw new HttpError(404, 'Booking not found');
    const s = getSettings(db);
    b.items = db.prepare('SELECT id, kind, description, qty, unit_cents FROM job_items WHERE booking_id = ? ORDER BY sort, id').all(id);
    b.totals = totals(b.items, s.tax_rate);
    b.activity = db
      .prepare('SELECT a.message, a.created_at, u.name user_name FROM activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.booking_id = ? ORDER BY a.id DESC')
      .all(id);
    b.history = db
      .prepare(`SELECT b.id, b.ref, b.date, b.status, s.name service_name FROM bookings b LEFT JOIN services s ON s.id = b.service_id
        WHERE b.customer_id = ? AND b.id <> ? ORDER BY b.date DESC LIMIT 10`)
      .all(b.customer_id, id);
    return b;
  }

  function bookingSummary(id) {
    const b = bookingDetail(id);
    return { ref: b.ref, date: b.date, time: b.time, service: b.service_name, name: b.customer_name, phone: b.phone, vehicle: [b.year, b.make, b.model, b.rego].filter(Boolean).join(' '), notes: b.customer_notes };
  }

  route('GET', '/api/admin/bookings', ({ query }) =>
    listBookings({
      status: STATUSES.includes(query.get('status')) ? query.get('status') : null,
      active: query.get('status') === 'active',
      q: (query.get('q') || '').slice(0, 60) || null,
      from: isValidDate(query.get('from') || '') ? query.get('from') : null,
      to: isValidDate(query.get('to') || '') ? query.get('to') : null,
    }),
  );

  route('POST', '/api/admin/bookings', ({ user, body }) => {
    const source = ['phone', 'walk-in', 'web'].includes(body.source) ? body.source : 'phone';
    const { id } = createBooking(db, body, { source: source === 'web' ? 'phone' : source, userId: user.id, now: now() });
    return bookingDetail(id);
  });

  route('GET', '/api/admin/bookings/:id', ({ params }) => bookingDetail(Number(params.id)));

  route('PATCH', '/api/admin/bookings/:id', ({ user, params, body }) => {
    const id = Number(params.id);
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!b) throw new HttpError(404, 'Booking not found');
    const changes = [];
    const set = (col, val, msg) => {
      if (val === undefined || val === b[col]) return;
      db.prepare(`UPDATE bookings SET ${col} = ? WHERE id = ?`).run(val, id);
      if (msg) changes.push(msg);
    };
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) throw new HttpError(400, 'Invalid status');
      set('status', body.status, `Status → ${body.status.replace('_', ' ')}`);
    }
    if (body.date !== undefined || body.time !== undefined) {
      const date = body.date ?? b.date;
      const time = body.time ?? b.time;
      if (!isValidDate(date) || !/^\d{2}:\d{2}$/.test(time)) throw new HttpError(400, 'Invalid date or time');
      if (date !== b.date || time !== b.time) {
        db.prepare('UPDATE bookings SET date = ?, time = ? WHERE id = ?').run(date, time, id);
        changes.push(`Moved to ${date} ${time}`);
      }
    }
    if (body.service_id !== undefined) set('service_id', body.service_id ? Number(body.service_id) : null, 'Service changed');
    if (body.internal_notes !== undefined) set('internal_notes', str(body.internal_notes, 4000, 'Notes'), null);
    if (body.odometer !== undefined) set('odometer', str(body.odometer, 20, 'Odometer'), null);
    if (body.paid !== undefined) {
      const paid = body.paid ? 1 : 0;
      if (paid !== b.paid) {
        const method = str(body.payment_method, 30, 'Payment method');
        db.prepare('UPDATE bookings SET paid = ?, payment_method = ?, paid_at = ? WHERE id = ?').run(paid, paid ? method : '', paid ? new Date().toISOString() : null, id);
        changes.push(paid ? `Marked paid${method ? ` (${method})` : ''}` : 'Marked unpaid');
      }
    }
    db.prepare("UPDATE bookings SET updated_at = datetime('now') WHERE id = ?").run(id);
    for (const c of changes) logActivity(db, id, user.id, c);
    return bookingDetail(id);
  });

  route('PUT', '/api/admin/bookings/:id/items', ({ user, params, body }) => {
    const id = Number(params.id);
    if (!db.prepare('SELECT 1 FROM bookings WHERE id = ?').get(id)) throw new HttpError(404, 'Booking not found');
    if (!Array.isArray(body.items) || body.items.length > 100) throw new HttpError(400, 'Invalid line items');
    const items = body.items.map((it) => {
      const kind = ['labour', 'part', 'other'].includes(it.kind) ? it.kind : 'other';
      const qty = Number(it.qty);
      const unit = Math.round(Number(it.unit_cents));
      if (!Number.isFinite(qty) || qty <= 0 || qty > 10000 || !Number.isFinite(unit) || Math.abs(unit) > 1e9) throw new HttpError(400, 'Invalid quantity or price');
      return { kind, description: str(it.description, 200, 'Description', true), qty, unit };
    });
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM job_items WHERE booking_id = ?').run(id);
      const ins = db.prepare('INSERT INTO job_items (booking_id, kind, description, qty, unit_cents, sort) VALUES (?, ?, ?, ?, ?, ?)');
      items.forEach((it, i) => ins.run(id, it.kind, it.description, it.qty, it.unit, i));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    logActivity(db, id, user.id, 'Job card updated');
    return bookingDetail(id);
  });

  route('GET', '/api/admin/slots', ({ query }) => {
    const ignore = query.get('ignore') ? Number(query.get('ignore')) : null;
    return slotsFor(db, String(query.get('date') || ''), { now: new Date(0), ignoreBookingId: ignore });
  });

  // ---------- Customers ----------

  route('GET', '/api/admin/customers', ({ query }) => {
    const q = (query.get('q') || '').slice(0, 60);
    const like = `%${q}%`;
    return db
      .prepare(`SELECT c.*, (SELECT COUNT(*) FROM bookings WHERE customer_id = c.id) visits,
          (SELECT max(date) FROM bookings WHERE customer_id = c.id) last_visit,
          (SELECT group_concat(trim(make || ' ' || model || ' ' || rego), ', ') FROM vehicles WHERE customer_id = c.id) vehicles
        FROM customers c
        WHERE ? = '' OR c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?
          OR EXISTS (SELECT 1 FROM vehicles v WHERE v.customer_id = c.id AND (v.rego LIKE ? OR v.make LIKE ? OR v.model LIKE ?))
        ORDER BY last_visit DESC NULLS LAST, c.id DESC LIMIT 300`)
      .all(q, like, like, like, like, like, like);
  });

  route('GET', '/api/admin/customers/:id', ({ params }) => {
    const id = Number(params.id);
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!c) throw new HttpError(404, 'Customer not found');
    c.vehicles = db.prepare('SELECT * FROM vehicles WHERE customer_id = ? ORDER BY id DESC').all(id);
    c.bookings = listBookings({ customerId: id, limit: 1000 });
    c.lifetime = c.bookings.filter((b) => b.status === 'completed').reduce((sum, b) => sum + b.total, 0);
    return c;
  });

  route('PATCH', '/api/admin/customers/:id', ({ params, body }) => {
    const id = Number(params.id);
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!c) throw new HttpError(404, 'Customer not found');
    const name = body.name !== undefined ? str(body.name, 80, 'Name', true) : c.name;
    const phone = body.phone !== undefined ? normalisePhone(str(body.phone, 30, 'Phone', true)) : c.phone;
    const email = body.email !== undefined ? str(body.email, 120, 'Email') : c.email;
    const notes = body.notes !== undefined ? str(body.notes, 4000, 'Notes') : c.notes;
    const clash = db.prepare('SELECT id FROM customers WHERE phone = ? AND id <> ?').get(phone, id);
    if (clash) throw new HttpError(409, 'Another customer already has that phone number');
    db.prepare('UPDATE customers SET name = ?, phone = ?, email = ?, notes = ? WHERE id = ?').run(name, phone, email, notes, id);
    return { ok: true };
  });

  route('PATCH', '/api/admin/vehicles/:id', ({ params, body }) => {
    const id = Number(params.id);
    const v = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id);
    if (!v) throw new HttpError(404, 'Vehicle not found');
    db.prepare('UPDATE vehicles SET rego = ?, make = ?, model = ?, year = ? WHERE id = ?').run(
      str(body.rego ?? v.rego, 15, 'Rego').toUpperCase(),
      str(body.make ?? v.make, 40, 'Make'),
      str(body.model ?? v.model, 40, 'Model'),
      str(body.year ?? v.year, 4, 'Year'),
      id,
    );
    return { ok: true };
  });

  // ---------- Services & rates ----------

  const serviceFields = (body, existing = {}) => {
    const priceType = body.price_type ?? existing.price_type ?? 'from';
    if (!['fixed', 'from', 'quote'].includes(priceType)) throw new HttpError(400, 'Invalid price type');
    const price = Math.round(Number(body.price_cents ?? existing.price_cents ?? 0));
    const duration = Math.round(Number(body.duration_min ?? existing.duration_min ?? 60));
    if (!Number.isFinite(price) || price < 0) throw new HttpError(400, 'Invalid price');
    if (!Number.isFinite(duration) || duration < 5 || duration > 10000) throw new HttpError(400, 'Invalid duration');
    return [
      str(body.name ?? existing.name, 80, 'Name', true),
      str(body.category ?? existing.category ?? 'Repairs', 40, 'Category', true),
      str(body.description ?? existing.description ?? '', 400, 'Description'),
      price,
      priceType,
      duration,
      str(body.icon ?? existing.icon ?? 'wrench', 20, 'Icon') || 'wrench',
      body.active === undefined ? (existing.active ?? 1) : body.active ? 1 : 0,
      Math.round(Number(body.sort ?? existing.sort ?? 0)) || 0,
    ];
  };

  route('GET', '/api/admin/services', () => db.prepare('SELECT * FROM services ORDER BY sort, id').all());
  route('POST', '/api/admin/services', ({ body }) => {
    const id = db
      .prepare('INSERT INTO services (name, category, description, price_cents, price_type, duration_min, icon, active, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(...serviceFields(body)).lastInsertRowid;
    return db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  });
  route('PATCH', '/api/admin/services/:id', ({ params, body }) => {
    const existing = db.prepare('SELECT * FROM services WHERE id = ?').get(Number(params.id));
    if (!existing) throw new HttpError(404, 'Service not found');
    db.prepare('UPDATE services SET name = ?, category = ?, description = ?, price_cents = ?, price_type = ?, duration_min = ?, icon = ?, active = ?, sort = ? WHERE id = ?').run(
      ...serviceFields(body, existing),
      existing.id,
    );
    return db.prepare('SELECT * FROM services WHERE id = ?').get(existing.id);
  });
  route('DELETE', '/api/admin/services/:id', ({ params }) => {
    const id = Number(params.id);
    // Services referenced by bookings are hidden instead of deleted so history stays intact.
    if (db.prepare('SELECT 1 FROM bookings WHERE service_id = ?').get(id)) {
      db.prepare('UPDATE services SET active = 0 WHERE id = ?').run(id);
      return { ok: true, archived: true };
    }
    db.prepare('DELETE FROM services WHERE id = ?').run(id);
    return { ok: true };
  });

  // ---------- Enquiries ----------

  route('GET', '/api/admin/enquiries', () => db.prepare("SELECT * FROM enquiries ORDER BY status = 'closed', id DESC LIMIT 300").all());
  route('PATCH', '/api/admin/enquiries/:id', ({ params, body }) => {
    if (!['open', 'closed'].includes(body.status)) throw new HttpError(400, 'Invalid status');
    db.prepare('UPDATE enquiries SET status = ? WHERE id = ?').run(body.status, Number(params.id));
    return { ok: true };
  });

  // ---------- Testimonials ----------

  const testimonialFields = (body) => {
    const rating = Math.round(Number(body.rating ?? 5));
    if (!(rating >= 1 && rating <= 5)) throw new HttpError(400, 'Rating must be 1–5');
    return [str(body.name, 60, 'Name', true), str(body.vehicle, 60, 'Vehicle'), str(body.text, 600, 'Review', true), rating, body.active === false ? 0 : 1];
  };
  route('GET', '/api/admin/testimonials', () => db.prepare('SELECT * FROM testimonials ORDER BY id DESC').all());
  route('POST', '/api/admin/testimonials', ({ body }) => {
    db.prepare('INSERT INTO testimonials (name, vehicle, text, rating, active) VALUES (?, ?, ?, ?, ?)').run(...testimonialFields(body));
    return { ok: true };
  });
  route('PATCH', '/api/admin/testimonials/:id', ({ params, body }) => {
    db.prepare('UPDATE testimonials SET name = ?, vehicle = ?, text = ?, rating = ?, active = ? WHERE id = ?').run(...testimonialFields(body), Number(params.id));
    return { ok: true };
  });
  route('DELETE', '/api/admin/testimonials/:id', ({ params }) => {
    db.prepare('DELETE FROM testimonials WHERE id = ?').run(Number(params.id));
    return { ok: true };
  });

  // ---------- Settings & users ----------

  function publicSettings() {
    const s = getSettings(db);
    return { ...s, hours: JSON.parse(s.hours), closed_dates: JSON.parse(s.closed_dates) };
  }

  route('GET', '/api/admin/settings', () => publicSettings());
  route('PUT', '/api/admin/settings', ({ user, body }) => {
    if (user.role !== 'owner') throw new HttpError(403, 'Only the owner can change settings');
    const up = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (body[key] === undefined) continue;
      let value = body[key];
      if (key === 'hours') {
        if (typeof value !== 'object' || value === null) throw new HttpError(400, 'Invalid hours');
        const clean = {};
        for (let d = 0; d < 7; d++) {
          const r = value[d];
          if (!r) clean[d] = null;
          else if (Array.isArray(r) && /^\d{2}:\d{2}$/.test(r[0]) && /^\d{2}:\d{2}$/.test(r[1]) && r[0] < r[1]) clean[d] = [r[0], r[1]];
          else throw new HttpError(400, 'Invalid hours');
        }
        value = JSON.stringify(clean);
      } else if (key === 'closed_dates') {
        if (!Array.isArray(value) || !value.every(isValidDate)) throw new HttpError(400, 'Invalid closed dates');
        value = JSON.stringify([...new Set(value)].sort());
      } else if (['tax_rate', 'labour_rate_cents', 'slot_minutes', 'slot_capacity', 'booking_days_ahead'].includes(key)) {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `Invalid ${key.replace(/_/g, ' ')}`);
        value = String(n);
      } else {
        value = str(value, 400, key.replace(/_/g, ' '));
      }
      up.run(value, key);
    }
    return publicSettings();
  });

  route('GET', '/api/admin/users', ({ user }) => {
    if (user.role !== 'owner') throw new HttpError(403, 'Owner only');
    return db.prepare('SELECT id, name, email, role, active, created_at FROM users ORDER BY id').all();
  });
  route('POST', '/api/admin/users', ({ user, body }) => {
    if (user.role !== 'owner') throw new HttpError(403, 'Owner only');
    const password = str(body.password, 200, 'Password', true);
    if (password.length < 10) throw new HttpError(400, 'Use at least 10 characters for the password');
    const email = str(body.email, 120, 'Email', true);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'That email already has an account');
    db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(
      str(body.name, 80, 'Name', true),
      email,
      auth.hashPassword(password),
      body.role === 'owner' ? 'owner' : 'staff',
    );
    return { ok: true };
  });
  route('PATCH', '/api/admin/users/:id', ({ user, params, body }) => {
    if (user.role !== 'owner') throw new HttpError(403, 'Owner only');
    const id = Number(params.id);
    if (id === user.id) throw new HttpError(400, "You can't disable your own account");
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(body.active ? 1 : 0, id);
    if (!body.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return { ok: true };
  });

  // ---------- Export ----------

  route('GET', '/api/admin/export/bookings.csv', ({ res }) => {
    const rows = listBookings({ limit: 1000 });
    const cell = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ['ref', 'date', 'time', 'status', 'customer', 'phone', 'rego', 'make', 'model', 'service', 'total', 'paid'];
    const lines = [head.join(',')].concat(
      rows.map((r) => [r.ref, r.date, r.time, r.status, r.customer_name, r.phone, r.rego, r.make, r.model, r.service_name, (r.total / 100).toFixed(2), r.paid ? 'yes' : 'no'].map(cell).join(',')),
    );
    send(res, 200, lines.join('\n'), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="bookings-${localDate(now())}.csv"`,
      'Cache-Control': 'no-store',
    });
    return undefined;
  });

  // ---------- Dispatcher ----------

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    try {
      if (pathname.startsWith('/api/')) {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(pathname);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          const isPublicAuth = pathname === '/api/admin/login' || pathname === '/api/admin/logout';
          const user = pathname.startsWith('/api/admin/') && !isPublicAuth ? auth.requireUser(db, req) : null;
          const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
          const out = await r.handler({ req, res, params, query: url.searchParams, body, user });
          if (user && req.method !== 'GET') site.invalidate();
          if (out !== undefined) json(res, 200, out);
          return;
        }
        throw new HttpError(404, 'Not found');
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      if (pathname === '/' || pathname === '/index.html') {
        const page = site.render();
        const headers = { 'Content-Type': 'text/html; charset=utf-8', ETag: page.etag, Vary: 'Accept-Encoding', 'Cache-Control': 'no-cache' };
        if (req.headers['if-none-match'] === page.etag) return send(res, 304, null, headers);
        return sendEncoded(req, res, page, headers);
      }
      if (pathname === '/admin') return send(res, 301, null, { Location: '/admin/' });
      if (serveStatic(req, res, pathname)) return;
      if (pathname.startsWith('/admin/')) return serveStatic(req, res, '/admin/index.html') || undefined;
      return send(res, 404, fs.readFileSync(path.join(PUBLIC_DIR, '404.html')), { 'Content-Type': 'text/html; charset=utf-8' });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (res.headersSent) return res.end();
      json(res, status, { error: status === 500 ? 'Something went wrong' : err.message });
    }
  };
}

module.exports = { createApp };
