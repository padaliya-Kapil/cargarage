# Chobbar Garage — ਚੋਬਰ ਗੈਰਾਜ

Website and booking CRM for **Chobbar Garage**. It has a fast public site where customers book online, and a CRM where the owner manages bookings, job cards, rates, customers and invoices.

**Zero dependencies.** It runs on Node.js 22.13+ with the built-in `node:sqlite`. There is no framework, no build step and no `node_modules`. The public home page is about 6 KB over the wire (brotli), plus fonts.

```bash
cp .env.example .env      # set ADMIN_EMAIL / ADMIN_PASSWORD
npm start                 # http://localhost:3000   CRM: http://localhost:3000/admin/
npm test                  # API tests (node:test)
```

If `ADMIN_PASSWORD` isn't set, the first start prints a temporary owner password to the console.

---

## Design direction

| | |
|---|---|
| **Mood** | Matte black and Punjabi gold: a black car under headlights. Confident and bold, not flashy. |
| **Type** | *Anton* for big uppercase headlines, *Baloo Paaji 2* for the Gurmukhi wordmark, and system UI fonts for body text (fast and very readable). |
| **Voice** | Straight-talking and warm, with Punjabi touches ("Sat Sri Akal", chai, Punjabi/Hindi/English updates). The "Chobbar" promise means a hard-working lad who does it right. |
| **Owner's personality** | The **Blackout Detail** section ("The owner drives black, so he sees every swirl mark"). The black-sedan hero, gold pinstripe and headlight beam. |
| **Music vibe** | Shown in the attitude, typography and dark palette only. No artist names, lyrics or likeness are used: that would raise copyright and personality-rights problems for a commercial site. |

The CRM uses a **light** theme on purpose, because it's easier to read on a phone in a bright workshop and it prints well.

## What's included

### Public website (`/`)
- Hero with "Book" and "Call" buttons, plus trust points (upfront rates, warranty, same-day service).
- **Services & rates** come from the database. When the CRM changes a rate, the site updates instantly.
- How it works, the Chobbar promise, the Blackout Detail feature, FAQ, contact details and opening hours (also pulled from the database).
- **Booking form**: service and vehicle, then a day-chip picker with live free slots (opening hours × number of bays), then contact details. The confirmation shows a booking ref, an **Add to calendar (.ics)** button and a prefilled WhatsApp message.
- Enquiry / quote form that goes to the CRM inbox.
- Sticky **Call | WhatsApp | Book** bar on mobile.
- A reviews section that stays hidden until real reviews are added in the CRM (no fake testimonials).
- SEO: `AutoRepair` JSON-LD with opening hours, Open Graph image, sitemap, robots, web manifest and icons.
- Accessibility: skip link, labelled form controls, focus rings, radio-group semantics, `prefers-reduced-motion` support, AA-contrast palette.
- Privacy page and 404 page.

### CRM (`/admin/`)
- **Dashboard**: new bookings to confirm, today's jobs, cars in the workshop, unpaid jobs, open enquiries, this month's revenue, a 6-month revenue chart and popular services. It polls every 60 seconds and shows a toast when an online booking arrives.
- **Bookings**: tabs (Active / Today / Upcoming / New / In workshop / Ready / Completed / Cancelled / All), search by name, phone, rego or ref, CSV export, and manual phone or walk-in bookings that can overbook a slot.
- **Booking detail**:
  - One-click workflow: New → Confirmed → In workshop → Ready → Completed (or Cancelled / No-show).
  - **Job card** with labour, parts and other lines, labour at the configured hourly rate, quick-add from services, and live totals with tax.
  - Reschedule, internal notes and odometer.
  - Payment tracking: mark paid with card, cash or transfer.
  - Activity history and the customer's previous visits.
  - **WhatsApp templates** (confirm / quote / ready) and Call / SMS buttons.
- **Quote / tax invoice**: a printable page, or save it as PDF.
- **Week board**: a 7-day view of every booking.
- **Customers**: matched by phone number automatically, with their vehicles, visit count, lifetime spend and private notes.
- **Services & rates**: add or edit price type (fixed / from / on quote), price, duration, category, icon, order and visibility.
- **Enquiries** inbox and **Reviews** manager.
- **Settings**:
  - Business details, hours and holiday closures.
  - Slot length, cars per slot (bays) and how far ahead customers can book.
  - Currency, tax name and rate, labour rate, warranty wording and invoice footer.
  - Staff accounts (owner or staff roles) and password change.

### Security
- Passwords are hashed with scrypt. Sessions use random tokens (only their hashes are stored) in an `HttpOnly; SameSite=Strict` cookie, with an extra same-origin check on writes.
- Strict CSP and security headers on every response.
- Rate limits on login and on the public forms, plus a honeypot field against spam bots.
- All SQL is parameterised. All CRM output is escaped. CSV export is guarded against formula injection.
- `/admin/` and `/api/` are excluded from search engines.

## Project layout

```
server.js            HTTP server, .env loader, optional webhook notifications
src/db.js            SQLite schema, default settings and seed services
src/app.js           Routes: public API, admin API, page rendering
src/bookings.js      Slot availability, booking creation, totals
src/auth.js          Password hashing, sessions
src/site.js          Server-renders index.html with live services, hours, reviews
src/http.js          Static files (brotli/gzip + ETag), JSON body, rate limiting, headers
public/              Website (index.html, css, js, img) and CRM (public/admin/)
test/api.test.js     End-to-end API tests
```

## Deploying

The app needs any host that runs Node 22.13+ and keeps a **persistent disk** for `DATA_DIR`, because that's where the SQLite file lives. Good options:
- A small VPS (Hetzner, DigitalOcean or Lightsail) with Caddy in front for automatic HTTPS.
- Render, Railway or Fly.io with a mounted volume.

```bash
PORT=3000 DATA_DIR=/var/lib/chobbar COOKIE_SECURE=1 TRUST_PROXY=1 TZ=America/Vancouver npm start
```

- Set **`TZ`** to the garage's time zone so "today" and the slot times are correct.
- Set `COOKIE_SECURE=1` behind HTTPS, and `TRUST_PROXY=1` when behind a reverse proxy, so rate limits see real client IPs.
- **Backups:** copy `chobbar.db` every day, for example with `sqlite3 chobbar.db ".backup backup-$(date +%F).db"` on a cron job, and send the copy off the server.
- **Notifications:** set `NOTIFY_WEBHOOK_URL` to a Zapier, Make or n8n hook. It then receives a JSON payload for every new booking or enquiry, which can trigger an SMS, email or WhatsApp to the owner.

## Go-live checklist

- [ ] CRM → Settings: real phone, WhatsApp number, email, address, Google Maps link, business/tax number, hours, tax rate, labour rate and currency.
- [ ] CRM → Services: confirm every price with the owner.
- [ ] Change the owner password. Add staff accounts.
- [ ] Replace `www.chobbargarage.com` in `public/robots.txt` and `public/sitemap.xml` with the real domain.
- [ ] Regenerate `public/img/og.png` once the real phone number is set (it's a screenshot of the hero).
- [ ] Add real photos of the workshop and the owner's black car. Use WebP or AVIF under 200 KB each.
- [ ] Create a **Google Business Profile**, link it from the site, and copy real reviews into CRM → Reviews.
- [ ] Have the privacy page reviewed for local law (PIPEDA, the Australian Privacy Act, UK GDPR…).
- [ ] Set up the daily backup and the notification webhook.

## Roadmap (next phases)

1. **Automated reminders**: SMS/WhatsApp booking confirmations and "service due" reminders after 6 or 12 months (Twilio or the WhatsApp Business API).
2. **Gallery and before/after** for detailing work, with uploads from the CRM.
3. **Online deposit** for big jobs or detailing (Stripe payment link).
4. **Customer portal**: look up a booking by ref and phone, approve a quote online, view photos.
5. **Parts inventory and suppliers**, and a technician assignment per job.
6. **Punjabi (ਪੰਜਾਬੀ) language toggle** for the whole site.
7. Accounting export (Xero / QuickBooks).
