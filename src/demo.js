'use strict';
// Sample CRM data for client demos (SEED_DEMO=1). Only runs on an empty database, and only touches
// bookings/customers — never public reviews, so the live site never shows made-up testimonials.
const { createBooking, localDate } = require('./bookings');

const PEOPLE = [
  ['Gurpreet Singh', '+16045550101', 'BMW', 'M5', '2022', 'CHOB01'],
  ['Harjit Kaur', '+16045550102', 'Toyota', 'Camry', '2019', 'HK1919'],
  ['Amandeep Gill', '+16045550103', 'Mercedes-Benz', 'C300', '2021', 'GILL21'],
  ['Simran Dhillon', '+16045550104', 'Honda', 'Civic', '2015', 'SIM015'],
  ['Jaspreet Sandhu', '+16045550105', 'Ford', 'F-150', '2020', 'JS5911'],
  ['Navdeep Brar', '+16045550106', 'Audi', 'A6', '2018', 'BRAR18'],
  ['Manpreet Grewal', '+16045550107', 'Range Rover', 'Sport', '2023', 'MGRW23'],
  ['Rajveer Sidhu', '+16045550108', 'Hyundai', 'Tucson', '2017', 'RAJ717'],
];

// [person, dayOffset, time, serviceIndex, status, paid, extra line items]
const JOBS = [
  [0, -40, '10:00', 0, 'completed', 1, [['part', 'Engine oil 5W-30 (6L)', 1, 6500]]],
  [1, -33, '09:00', 2, 'completed', 1, [['part', 'Front pads (ceramic)', 1, 8900]]],
  [2, -25, '11:00', 10, 'completed', 1, [['other', 'Ceramic coating upgrade', 1, 25000]]],
  [3, -18, '14:00', 3, 'completed', 1, []],
  [4, -12, '08:00', 4, 'completed', 1, [['part', 'Tyres 275/65R18 ×4', 4, 21000]]],
  [5, -6, '13:00', 6, 'completed', 1, []],
  [6, -3, '09:00', 0, 'completed', 0, [['part', 'Air + cabin filters', 1, 7400]]],
  [7, -1, '10:00', 5, 'completed', 1, []],
  [0, 0, '09:00', 10, 'in_progress', 0, []],
  [3, 0, '11:00', 8, 'ready', 0, [['part', 'Clutch kit', 1, 48000], ['labour', 'Clutch replacement (hrs)', 5, 12000]]],
  [1, 0, '14:00', 1, 'confirmed', 0, []],
  [5, 1, '08:00', 2, 'confirmed', 0, []],
  [2, 1, '10:00', 3, 'new', 0, []],
  [7, 2, '09:00', 9, 'new', 0, []],
  [4, 3, '13:00', 7, 'confirmed', 0, []],
  [6, 5, '10:00', 10, 'new', 0, []],
];

function seedDemo(db) {
  if (db.prepare('SELECT COUNT(*) n FROM bookings').get().n > 0) return false;
  const services = db.prepare('SELECT id, name, price_cents, price_type FROM services ORDER BY sort, id').all();
  const today = new Date();
  for (const [p, offset, time, svcIdx, status, paid, extra] of JOBS) {
    const [name, phone, make, model, year, rego] = PEOPLE[p];
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    const svc = services[svcIdx];
    const { id } = createBooking(
      db,
      { name, phone, make, model, year, rego, service_id: svc?.id, date: localDate(d), time, notes: offset >= 0 && status === 'new' ? 'Booked online — demo data' : '' },
      { source: 'phone' },
    );
    const ins = db.prepare('INSERT INTO job_items (booking_id, kind, description, qty, unit_cents, sort) VALUES (?, ?, ?, ?, ?, ?)');
    if (svc?.price_type === 'quote' && !extra.length) ins.run(id, 'labour', svc.name + ' (quoted)', 1, 65000, 0);
    extra.forEach(([kind, desc, qty, unit], i) => ins.run(id, kind, desc, qty, unit, i + 1));
    db.prepare('UPDATE bookings SET status = ?, paid = ?, payment_method = ?, source = ? WHERE id = ?').run(status, paid, paid ? (p % 2 ? 'Card' : 'Cash') : '', p % 3 === 0 ? 'phone' : 'web', id);
  }
  db.prepare("INSERT INTO enquiries (name, phone, message) VALUES (?, ?, ?)").run('Kulwinder', '+16045550199', 'How much for a clutch on a 2015 Civic? Demo enquiry.');
  return true;
}

module.exports = { seedDemo };
