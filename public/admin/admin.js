'use strict';
(() => {
  const app = document.getElementById('app');
  const state = { me: null, settings: null, services: [], badge: { bookings: 0, enquiries: 0 } };

  // ---------- Utilities ----------

  class Raw {
    constructor(s) {
      this.s = s;
    }
    toString() {
      return this.s;
    }
  }
  const raw = (s) => new Raw(s);
  const escape = (v) =>
    v instanceof Raw ? v.s : Array.isArray(v) ? v.map(escape).join('') : String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  // Tagged template: interpolated values are HTML-escaped unless wrapped with raw() or produced by html``.
  const html = (strings, ...vals) => raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? escape(vals[i]) : ''), ''));

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (s, n) => {
    const d = new Date(s + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return iso(d);
  };
  const today = () => iso(new Date());
  const money = (c) => (state.settings?.currency || '$') + (Number(c || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (s, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => (s ? new Date(s + 'T00:00:00').toLocaleDateString(undefined, opts) : '');
  const fmtTime = (t) => {
    if (!t) return '';
    const [h, m] = t.split(':').map(Number);
    return `${h % 12 || 12}:${pad(m)}${h >= 12 ? 'pm' : 'am'}`;
  };
  const fmtStamp = (s) => new Date(s.replace(' ', 'T') + (s.includes('T') ? '' : 'Z')).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const STATUS_LABEL = { new: 'New', confirmed: 'Confirmed', in_progress: 'In workshop', ready: 'Ready for pickup', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show' };
  const pill = (s) => html`<span class="pill st-${s}">${STATUS_LABEL[s] || s}</span>`;
  const vehicle = (b) => [b.year, b.make, b.model].filter(Boolean).join(' ') || '—';
  const waNumber = (phone) => {
    let d = String(phone || '').replace(/\D/g, '');
    if (String(phone).trim().startsWith('+')) return d;
    if (d.startsWith('0')) d = (state.settings?.country_code || '') + d.slice(1);
    return d;
  };

  function toast(msg, err = false) {
    const t = document.createElement('div');
    t.className = 'toast' + (err ? ' err' : '');
    t.textContent = msg;
    document.body.append(t);
    setTimeout(() => t.remove(), err ? 4500 : 2200);
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    if (res.status === 401 && !url.endsWith('/login')) {
      state.me = null;
      renderLogin();
      throw new Error('Please sign in');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  const get = (u) => api('GET', u);

  // Run an action, surfacing errors as a toast.
  async function attempt(fn, okMsg) {
    try {
      const out = await fn();
      if (okMsg) toast(okMsg);
      return out;
    } catch (e) {
      toast(e.message, true);
      return undefined;
    }
  }

  const formObj = (form) => {
    const o = {};
    for (const el of form.elements) if (el.name) o[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    return o;
  };

  // Generic modal from an html`` form body. Resolves with form data or null.
  function modal(title, body, { submit = 'Save', onOpen } = {}) {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.innerHTML = html`<form method="dialog"><h2>${title}</h2>${body}<p class="err-text" hidden></p>
        <div class="row"><span class="spacer"></span><button class="btn" value="cancel" type="button" data-close>Cancel</button><button class="btn btn-primary" value="ok">${submit}</button></div></form>`.s;
      document.body.append(dlg);
      const form = $('form', dlg);
      const close = (v) => {
        dlg.close();
        dlg.remove();
        resolve(v);
      };
      $('[data-close]', dlg).onclick = () => close(null);
      dlg.addEventListener('cancel', () => close(null));
      form.onsubmit = (e) => {
        e.preventDefault();
        close(formObj(form));
      };
      dlg.showModal();
      onOpen?.(dlg);
    });
  }

  // ---------- Shell & routing ----------

  const NAV = [
    ['#/', 'Dashboard'],
    ['#/bookings', 'Bookings', 'bookings'],
    ['#/calendar', 'Week board'],
    ['#/customers', 'Customers'],
    ['#/services', 'Services & rates'],
    ['#/enquiries', 'Enquiries', 'enquiries'],
    ['#/reviews', 'Reviews'],
    ['#/settings', 'Settings'],
  ];

  function shell(content, active) {
    app.className = '';
    app.innerHTML = html`<div class="shell">
      <aside class="side" id="side">
        <a class="brand" href="#/">CHOBBAR <span>CRM</span></a>
        <nav>${NAV.map(([href, label, badge]) => {
          const n = badge ? state.badge[badge] : 0;
          return html`<a class="nav-item ${active === href ? 'active' : ''}" href="${href}">${label}${n ? html`<span class="badge">${n}</span>` : ''}</a>`;
        })}</nav>
        <div class="side-foot">${state.me.name} · ${state.me.role}<br><a href="/" target="_blank" rel="noopener">View website</a> · <button id="logout">Sign out</button></div>
      </aside>
      <main class="main" id="main">${content}</main>
    </div>`.s;
    $('#logout').onclick = async () => {
      await api('POST', '/api/admin/logout');
      state.me = null;
      renderLogin();
    };
    $$('.nav-item').forEach((a) => (a.onclick = () => $('#side').classList.remove('open')));
    $$('[data-menu]').forEach((b) => (b.onclick = () => $('#side').classList.toggle('open')));
  }
  const topbar = (title, actions = '') => html`<div class="topbar"><button class="btn menu-btn" data-menu aria-label="Menu">☰</button><h1>${title}</h1><span class="spacer"></span>${actions}</div>`;

  const routes = [
    [/^#\/?$/, viewDashboard, '#/'],
    [/^#\/bookings$/, viewBookings, '#/bookings'],
    [/^#\/bookings\/(\d+)$/, viewBooking, '#/bookings'],
    [/^#\/invoice\/(\d+)$/, viewInvoice, '#/bookings'],
    [/^#\/calendar$/, viewCalendar, '#/calendar'],
    [/^#\/customers$/, viewCustomers, '#/customers'],
    [/^#\/customers\/(\d+)$/, viewCustomer, '#/customers'],
    [/^#\/services$/, viewServices, '#/services'],
    [/^#\/enquiries$/, viewEnquiries, '#/enquiries'],
    [/^#\/reviews$/, viewReviews, '#/reviews'],
    [/^#\/settings$/, viewSettings, '#/settings'],
  ];

  async function router() {
    if (!state.me) return;
    const [hash, qs] = (location.hash || '#/').split('?');
    const params = new URLSearchParams(qs || '');
    for (const [re, view, nav] of routes) {
      const m = re.exec(hash);
      if (!m) continue;
      try {
        await view({ id: m[1] ? Number(m[1]) : null, params, nav });
      } catch (e) {
        if (state.me) shell(html`${topbar('Error')}<div class="card err-text">${e.message}</div>`, nav);
      }
      return;
    }
    location.hash = '#/';
  }
  window.addEventListener('hashchange', router);

  async function refreshBadges() {
    try {
      const d = await get('/api/admin/dashboard');
      const changed = d.newCount !== state.badge.bookings || d.openEnquiries !== state.badge.enquiries;
      if (d.newCount > state.badge.bookings && state.badge.loaded) toast('New online booking received');
      state.badge = { bookings: d.newCount, enquiries: d.openEnquiries, loaded: true };
      document.title = (d.newCount ? `(${d.newCount}) ` : '') + 'Chobbar CRM';
      if (changed) $$('.nav-item').forEach((a) => {
        const item = NAV.find(([h]) => h === a.getAttribute('href'));
        if (!item?.[2]) return;
        $('.badge', a)?.remove();
        const n = state.badge[item[2]];
        if (n) a.insertAdjacentHTML('beforeend', `<span class="badge">${n}</span>`);
      });
      return d;
    } catch {
      return null;
    }
  }

  // ---------- Login ----------

  function renderLogin() {
    app.className = '';
    app.innerHTML = html`<div class="login"><form id="login">
      <div class="brand">CHOBBAR <span style="color:var(--gold)">CRM</span></div>
      <label class="f">Email<input name="email" type="email" autocomplete="username" required></label>
      <label class="f">Password<input name="password" type="password" autocomplete="current-password" required></label>
      <p class="err-text" hidden></p>
      <button class="btn btn-primary">Sign in</button>
      <a class="small muted" href="/">← Back to website</a>
    </form></div>`.s;
    $('#login').onsubmit = async (e) => {
      e.preventDefault();
      const err = $('.err-text', e.target);
      try {
        await api('POST', '/api/admin/login', formObj(e.target));
        await boot();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      }
    };
  }

  // ---------- Dashboard ----------

  async function viewDashboard({ nav }) {
    const d = await refreshBadges();
    if (!d) throw new Error('Could not load dashboard');
    const max = Math.max(1, ...d.months.map((m) => m.total));
    shell(
      html`${topbar('Sat Sri Akal, ' + state.me.name.split(' ')[0], html`<a class="btn btn-gold" href="#/bookings?new=1">+ New booking</a>`)}
      <div class="stats">
        <a class="stat hl" href="#/bookings?status=new"><b>${d.newCount}</b><span>New bookings to confirm</span></a>
        <a class="stat" href="#/bookings?view=today"><b>${d.todayCount}</b><span>Booked today</span></a>
        <a class="stat" href="#/bookings?status=in_progress"><b>${d.inWorkshop}</b><span>In workshop / ready</span></a>
        <a class="stat" href="#/bookings?status=completed&unpaid=1"><b>${d.unpaid}</b><span>Completed, unpaid</span></a>
        <a class="stat" href="#/enquiries"><b>${d.openEnquiries}</b><span>Open enquiries</span></a>
        <div class="stat"><b>${money(d.monthRevenue)}</b><span>Revenue this month</span></div>
      </div>
      <div class="detail">
        <div>
          <div class="card"><h2>Today · ${fmtDate(d.today, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>${bookingTable(d.todayList, 'Nothing booked for today.')}</div>
          <div class="card"><h2>Coming up</h2>${bookingTable(d.upcoming, 'No upcoming bookings.')}</div>
        </div>
        <div>
          <div class="card"><h2>Revenue (completed jobs)</h2>
            <div class="bars">${d.months.map(
              (m) => html`<div class="bar" title="${m.jobs} jobs"><span>${m.total ? money(m.total).replace(/\.00$/, '') : ''}</span><i style="height:${Math.round((m.total / max) * 100)}%"></i>${new Date(m.month + '-01T00:00:00').toLocaleDateString(undefined, { month: 'short' })}</div>`,
            )}</div>
          </div>
          <div class="card"><h2>Popular services (90 days)</h2>
            ${d.topServices.length ? html`<table>${d.topServices.map((s) => html`<tr><td>${s.name}</td><td class="right"><b>${s.n}</b></td></tr>`)}</table>` : html`<p class="muted">No data yet.</p>`}
          </div>
        </div>
      </div>`,
      nav,
    );
    bindRows();
  }

  function bookingTable(rows, empty = 'No bookings found.') {
    if (!rows.length) return html`<p class="empty">${empty}</p>`;
    return html`<div class="table-wrap"><table>
      <thead><tr><th>When</th><th>Customer</th><th>Vehicle</th><th class="hide-sm">Service</th><th>Status</th><th class="right hide-sm">Total</th></tr></thead>
      <tbody>${rows.map(
        (b) => html`<tr class="click" data-href="#/bookings/${b.id}">
          <td><b>${fmtDate(b.date)}</b><br><span class="muted small">${fmtTime(b.time)}</span></td>
          <td>${b.customer_name}<br><span class="muted small">${b.phone}</span></td>
          <td>${vehicle(b)}<br><span class="muted small mono">${b.rego || ''}</span></td>
          <td class="hide-sm">${b.service_name || html`<span class="muted">—</span>`}</td>
          <td>${pill(b.status)}${b.source !== 'web' ? html`<br><span class="muted small">${b.source}</span>` : ''}</td>
          <td class="right hide-sm">${b.total ? money(b.total) : '—'}${b.status === 'completed' ? html`<br><span class="small ${b.paid ? 'paid' : 'unpaid'}">${b.paid ? 'Paid' : 'Unpaid'}</span>` : ''}</td>
        </tr>`,
      )}</tbody></table></div>`;
  }
  const bindRows = () => $$('tr[data-href]').forEach((tr) => (tr.onclick = () => (location.hash = tr.dataset.href)));

  // ---------- Bookings list ----------

  async function viewBookings({ params, nav }) {
    const view = params.get('view') || (params.get('status') ? '' : 'active');
    const status = params.get('status') || '';
    const q = params.get('q') || '';
    const qs = new URLSearchParams();
    if (view === 'active') qs.set('status', 'active');
    if (view === 'today') (qs.set('from', today()), qs.set('to', today()));
    if (view === 'upcoming') qs.set('from', today());
    if (status) qs.set('status', status);
    if (q) qs.set('q', q);
    let rows = await get('/api/admin/bookings?' + qs);
    if (params.get('unpaid')) rows = rows.filter((r) => !r.paid);
    const tab = (label, p) => {
      const isActive = new URLSearchParams(p).toString() === new URLSearchParams({ ...(view ? { view } : {}), ...(status ? { status } : {}) }).toString();
      return html`<a href="#/bookings?${p}" class="${isActive ? 'active' : ''}">${label}</a>`;
    };
    shell(
      html`${topbar('Bookings', html`<a class="btn" href="/api/admin/export/bookings.csv">Export CSV</a><button class="btn btn-gold" id="new-booking">+ New booking</button>`)}
      <div class="card">
        <div class="row" style="margin-bottom:.8rem">
          <div class="tabs">${tab('Active', 'view=active')}${tab('Today', 'view=today')}${tab('Upcoming', 'view=upcoming')}${tab('New', 'status=new')}${tab('In workshop', 'status=in_progress')}${tab('Ready', 'status=ready')}${tab('Completed', 'status=completed')}${tab('Cancelled', 'status=cancelled')}${tab('All', 'view=all')}</div>
          <span class="spacer"></span>
          <form id="search" class="search"><input name="q" type="search" placeholder="Search name, phone, rego, ref…" value="${q}"></form>
        </div>
        ${bookingTable(rows)}
      </div>`,
      nav,
    );
    bindRows();
    $('#search').onsubmit = (e) => {
      e.preventDefault();
      const p = new URLSearchParams(params);
      p.set('q', e.target.q.value.trim());
      if (!p.get('q')) p.delete('q');
      p.set('view', 'all');
      p.delete('status');
      location.hash = '#/bookings?' + p;
    };
    $('#new-booking').onclick = newBooking;
    if (params.get('new')) {
      history.replaceState(null, '', '#/bookings');
      newBooking();
    }
  }

  async function newBooking() {
    const services = await get('/api/admin/services');
    const data = await modal(
      'New booking (phone / walk-in)',
      html`<div class="grid2">
        <label class="f">Customer name<input name="name" required></label>
        <label class="f">Phone<input name="phone" type="tel" required></label>
        <label class="f">Email<input name="email" type="email"></label>
        <label class="f">Source<select name="source"><option value="phone">Phone</option><option value="walk-in">Walk-in</option></select></label>
        <label class="f">Make<input name="make"></label>
        <label class="f">Model<input name="model"></label>
        <label class="f">Year<input name="year" maxlength="4"></label>
        <label class="f">Rego / plate<input name="rego"></label>
        <label class="f">Date<input name="date" type="date" required value="${today()}"></label>
        <label class="f">Time<input name="time" type="time" required step="900" value="09:00"></label>
      </div>
      <label class="f">Service<select name="service_id"><option value="">— None / to be quoted —</option>${services.map((s) => html`<option value="${s.id}">${s.name}</option>`)}</select></label>
      <label class="f">Notes from customer<textarea name="notes"></textarea></label>
      <p class="small muted" id="slot-hint"></p>`,
      {
        submit: 'Create booking',
        onOpen: (dlg) => {
          const f = $('form', dlg);
          const hint = async () => {
            try {
              const r = await get('/api/admin/slots?date=' + f.date.value);
              const free = r.slots.filter((s) => s.available).map((s) => fmtTime(s.time));
              $('#slot-hint', dlg).textContent = !r.open ? 'Garage is closed that day (you can still book).' : free.length ? 'Free: ' + free.join(', ') : 'All bays booked that day.';
            } catch {
              /* ignore */
            }
          };
          f.date.onchange = hint;
          hint();
        },
      },
    );
    if (!data) return;
    const b = await attempt(() => api('POST', '/api/admin/bookings', data), 'Booking created');
    if (b) location.hash = '#/bookings/' + b.id;
  }

  // ---------- Booking detail ----------

  async function viewBooking({ id, nav }) {
    const [b, services] = await Promise.all([get('/api/admin/bookings/' + id), state.services.length ? state.services : get('/api/admin/services')]);
    state.services = services;
    const s = state.settings;
    const wa = waNumber(b.phone);
    const firstName = b.customer_name.split(' ')[0];
    const waMsgs = {
      confirm: `Sat Sri Akal ${firstName}! Your booking at ${s.business_name} is confirmed for ${fmtDate(b.date, { weekday: 'long', day: 'numeric', month: 'long' })} at ${fmtTime(b.time)}. Ref ${b.ref}.`,
      quote: `Hi ${firstName}, we've inspected your ${vehicle(b)}. Quote: ${money(b.totals.total)} (incl. ${s.tax_name}). Reply YES to go ahead.`,
      ready: `Hi ${firstName}, your ${vehicle(b)} is ready for pickup at ${s.business_name}. Total ${money(b.totals.total)}. See you soon!`,
    };
    const nextActions = {
      new: [['confirmed', 'Confirm'], ['cancelled', 'Cancel']],
      confirmed: [['in_progress', 'Car arrived — start job'], ['no_show', 'No-show'], ['cancelled', 'Cancel']],
      in_progress: [['ready', 'Ready for pickup']],
      ready: [['completed', 'Collected — complete']],
      completed: [],
      cancelled: [['confirmed', 'Re-open']],
      no_show: [['confirmed', 'Re-open']],
    }[b.status];

    shell(
      html`${topbar(html`<span class="mono">${b.ref}</span> ${pill(b.status)}`, html`<a class="btn" href="#/invoice/${b.id}">${b.status === 'completed' ? 'Invoice' : 'Quote'} / print</a>`)}
      <div class="detail">
        <div>
          <div class="card">
            <div class="row"><h2 style="margin:0">Workflow</h2><span class="spacer"></span>
              <div class="status-bar">${nextActions.map(([st, label], i) => html`<button class="btn btn-sm ${i === 0 ? 'btn-primary' : ''} ${st === 'cancelled' || st === 'no_show' ? 'btn-danger' : ''}" data-status="${st}">${label}</button>`)}
              <select id="status-any" class="btn-sm" style="width:auto" aria-label="Set status">${Object.entries(STATUS_LABEL).map(([k, v]) => html`<option value="${k}" ${k === b.status ? raw('selected') : ''}>${v}</option>`)}</select></div>
            </div>
          </div>

          <div class="card">
            <div class="row"><h2 style="margin:0">Job card</h2><span class="spacer"></span>
              <select id="quick-add" class="btn-sm" style="width:auto"><option value="">+ Add from services…</option>${services.filter((x) => x.active).map((x) => html`<option value="${x.id}">${x.name}</option>`)}</select>
              <button class="btn btn-sm" data-add="labour">+ Labour</button><button class="btn btn-sm" data-add="part">+ Part</button>
            </div>
            <div class="table-wrap" style="margin-top:.6rem"><table class="items"><thead><tr><th>Type</th><th>Description</th><th>Qty / hrs</th><th>Unit (${s.currency})</th><th class="right">Line</th><th></th></tr></thead><tbody id="items"></tbody></table></div>
            <div class="totals" id="totals"></div>
            <div class="row" style="margin-top:.8rem"><span class="spacer"></span><button class="btn btn-primary" id="save-items" disabled>Save job card</button></div>
          </div>

          <div class="card">
            <h2>Workshop notes <span class="muted small">(internal — never shown to customer)</span></h2>
            ${b.customer_notes ? html`<p><b>Customer said:</b> ${b.customer_notes}</p>` : ''}
            <textarea id="notes" rows="4" placeholder="Findings, parts ordered, follow-ups…">${b.internal_notes}</textarea>
            <div class="row" style="margin-top:.6rem"><label class="f" style="flex:1">Odometer<input id="odo" value="${b.odometer}" placeholder="e.g. 84,210 km"></label><span class="spacer"></span><button class="btn" id="save-notes">Save notes</button></div>
          </div>
        </div>

        <div>
          <div class="card">
            <h2>${b.customer_name}</h2>
            <p><a href="tel:${b.phone}">${b.phone}</a>${b.email ? html` · <a href="mailto:${b.email}">${b.email}</a>` : ''}</p>
            <div class="row">
              <a class="btn btn-sm" href="tel:${b.phone}">Call</a>
              <a class="btn btn-sm" href="sms:${b.phone}">SMS</a>
              ${wa ? html`<a class="btn btn-sm" target="_blank" rel="noopener" href="https://wa.me/${wa}?text=${encodeURIComponent(waMsgs.confirm)}">WA: confirm</a>
              <a class="btn btn-sm" target="_blank" rel="noopener" href="https://wa.me/${wa}?text=${encodeURIComponent(waMsgs.quote)}">WA: quote</a>
              <a class="btn btn-sm" target="_blank" rel="noopener" href="https://wa.me/${wa}?text=${encodeURIComponent(waMsgs.ready)}">WA: ready</a>` : ''}
            </div>
            <p style="margin-top:.8rem"><a href="#/customers/${b.customer_id}">Customer profile →</a></p>
            ${b.customer_profile_notes ? html`<p class="small"><b>Profile note:</b> ${b.customer_profile_notes}</p>` : ''}
          </div>
          <div class="card">
            <h2>Vehicle & appointment</h2>
            <dl class="kv"><dt>Vehicle</dt><dd>${vehicle(b)}</dd><dt>Rego</dt><dd class="mono">${b.rego || '—'}</dd><dt>Service</dt><dd>${b.service_name || '—'}</dd><dt>Source</dt><dd>${b.source}</dd><dt>Booked</dt><dd>${fmtStamp(b.created_at)}</dd></dl>
            <div class="grid2" style="margin-top:.8rem">
              <label class="f">Date<input type="date" id="r-date" value="${b.date}"></label>
              <label class="f">Time<input type="time" id="r-time" value="${b.time}" step="900"></label>
            </div>
            <label class="f" style="margin-top:.6rem">Service<select id="r-svc"><option value="">—</option>${services.map((x) => html`<option value="${x.id}" ${x.id === b.service_id ? raw('selected') : ''}>${x.name}</option>`)}</select></label>
            <button class="btn" id="reschedule" style="margin-top:.6rem">Update appointment</button>
          </div>
          <div class="card">
            <h2>Payment</h2>
            <p>Total <b>${money(b.totals.total)}</b> — ${b.paid ? html`<span class="paid">Paid${b.payment_method ? ' · ' + b.payment_method : ''}</span>` : html`<span class="unpaid">Unpaid</span>`}</p>
            ${b.paid
              ? html`<button class="btn btn-sm" id="unpay">Mark unpaid</button>`
              : html`<div class="row"><select id="pay-method" style="width:auto"><option>Card</option><option>Cash</option><option>Bank transfer</option><option>Other</option></select><button class="btn btn-gold" id="pay">Mark paid</button></div>`}
          </div>
          <div class="card">
            <h2>History</h2>
            <ul class="timeline">${b.activity.map((a) => html`<li>${a.message}<br><span class="muted">${fmtStamp(a.created_at)}${a.user_name ? ' · ' + a.user_name : ''}</span></li>`)}</ul>
            ${b.history.length ? html`<h3 style="margin-top:1rem">Previous visits</h3><ul class="timeline">${b.history.map((h) => html`<li><a href="#/bookings/${h.id}">${fmtDate(h.date)} · ${h.service_name || 'Job'}</a> ${pill(h.status)}</li>`)}</ul>` : ''}
          </div>
        </div>
      </div>`,
      nav,
    );

    // Job card editor
    let items = b.items.map((i) => ({ ...i }));
    const rate = Number(s.labour_rate_cents) || 0;
    const tbody = $('#items');
    const saveBtn = $('#save-items');
    const dirty = () => {
      saveBtn.disabled = false;
      saveBtn.classList.add('dirty');
    };
    function drawItems() {
      tbody.innerHTML = items.length
        ? items
            .map(
              (it, i) => html`<tr data-i="${i}">
            <td><select class="kind" data-k="kind">${['labour', 'part', 'other'].map((k) => html`<option ${k === it.kind ? raw('selected') : ''}>${k}</option>`)}</select></td>
            <td><input data-k="description" value="${it.description}" placeholder="Description"></td>
            <td><input class="qty" data-k="qty" type="number" step="0.25" min="0.25" value="${it.qty}"></td>
            <td><input class="unit" data-k="unit" type="number" step="0.01" value="${(it.unit_cents / 100).toFixed(2)}"></td>
            <td class="right">${money(Math.round(it.qty * it.unit_cents))}</td>
            <td><button class="btn btn-sm btn-danger" data-del="${i}" aria-label="Remove line">×</button></td></tr>`.s,
            )
            .join('')
        : '<tr><td colspan="6" class="empty">No lines yet — add labour, parts or a service.</td></tr>';
      drawTotals();
    }
    function drawTotals() {
      const sub = items.reduce((t, i) => t + Math.round(i.qty * i.unit_cents), 0);
      const tax = Math.round((sub * (Number(s.tax_rate) || 0)) / 100);
      $('#totals').innerHTML = html`<div><span>Subtotal</span><span>${money(sub)}</span></div>
        ${Number(s.tax_rate) ? html`<div><span>${s.tax_name} (${s.tax_rate}%)</span><span>${money(tax)}</span></div>` : ''}
        <div class="grand"><span>Total</span><span>${money(sub + tax)}</span></div>`.s;
    }
    tbody.addEventListener('input', (e) => {
      const tr = e.target.closest('tr[data-i]');
      if (!tr) return;
      const it = items[Number(tr.dataset.i)];
      const k = e.target.dataset.k;
      if (k === 'unit') it.unit_cents = Math.round(Number(e.target.value) * 100) || 0;
      else if (k === 'qty') it.qty = Number(e.target.value) || 0;
      else it[k] = e.target.value;
      tr.cells[4].textContent = money(Math.round(it.qty * it.unit_cents));
      drawTotals();
      dirty();
    });
    tbody.addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (!del) return;
      items.splice(Number(del.dataset.del), 1);
      drawItems();
      dirty();
    });
    $$('[data-add]').forEach(
      (btn) =>
        (btn.onclick = () => {
          const kind = btn.dataset.add;
          items.push({ kind, description: kind === 'labour' ? 'Labour' : '', qty: 1, unit_cents: kind === 'labour' ? rate : 0 });
          drawItems();
          dirty();
          $(`tr[data-i="${items.length - 1}"] [data-k=description]`)?.focus();
        }),
    );
    $('#quick-add').onchange = (e) => {
      const svc = services.find((x) => x.id === Number(e.target.value));
      e.target.value = '';
      if (!svc) return;
      items.push({ kind: 'labour', description: svc.name, qty: 1, unit_cents: svc.price_cents });
      drawItems();
      dirty();
    };
    saveBtn.onclick = async () => {
      const bad = items.find((i) => !String(i.description).trim() || !(i.qty > 0));
      if (bad) return toast('Every line needs a description and a quantity above 0', true);
      const r = await attempt(() => api('PUT', `/api/admin/bookings/${id}/items`, { items }), 'Job card saved');
      if (r) router();
    };
    drawItems();

    const patch = async (body, msg) => {
      const r = await attempt(() => api('PATCH', '/api/admin/bookings/' + id, body), msg);
      if (r) {
        refreshBadges();
        router();
      }
    };
    $$('[data-status]').forEach((btn) => (btn.onclick = () => patch({ status: btn.dataset.status }, 'Status updated')));
    $('#status-any').onchange = (e) => patch({ status: e.target.value }, 'Status updated');
    $('#save-notes').onclick = () => patch({ internal_notes: $('#notes').value, odometer: $('#odo').value }, 'Notes saved');
    $('#reschedule').onclick = () => patch({ date: $('#r-date').value, time: $('#r-time').value, service_id: $('#r-svc').value || null }, 'Appointment updated');
    $('#pay') && ($('#pay').onclick = () => patch({ paid: true, payment_method: $('#pay-method').value }, 'Marked paid'));
    $('#unpay') && ($('#unpay').onclick = () => patch({ paid: false }, 'Marked unpaid'));
  }

  // ---------- Invoice / quote ----------

  async function viewInvoice({ id, nav }) {
    const b = await get('/api/admin/bookings/' + id);
    const s = state.settings;
    const isInvoice = b.status === 'completed';
    shell(
      html`<div class="no-print row"><a class="btn" href="#/bookings/${b.id}">← Back</a><span class="spacer"></span><button class="btn btn-primary" id="print">Print / Save PDF</button></div>
      <article class="invoice">
        <div class="inv-head">
          <div><h1>CHOBBAR <span>GARAGE</span></h1><p class="muted small">${s.address}<br>${s.phone} · ${s.email}${s.abn ? html`<br>Business no. ${s.abn}` : ''}</p></div>
          <div class="inv-meta"><h2>${isInvoice ? 'Tax invoice' : 'Quote'}</h2><p class="mono">${b.ref}</p><p class="small">${isInvoice ? 'Date' : 'Issued'}: ${fmtDate(isInvoice ? b.date : today(), { day: 'numeric', month: 'long', year: 'numeric' })}</p></div>
        </div>
        <div class="grid2" style="margin-bottom:1.5rem">
          <div><h3>Bill to</h3><p>${b.customer_name}<br>${b.phone}${b.email ? html`<br>${b.email}` : ''}</p></div>
          <div><h3>Vehicle</h3><p>${vehicle(b)}<br><span class="mono">${b.rego || ''}</span>${b.odometer ? html`<br>Odometer: ${b.odometer}` : ''}</p></div>
        </div>
        <table><thead><tr><th>Description</th><th>Type</th><th class="right">Qty</th><th class="right">Unit</th><th class="right">Amount</th></tr></thead>
        <tbody>${b.items.length ? b.items.map((i) => html`<tr><td>${i.description}</td><td>${i.kind}</td><td class="right">${i.qty}</td><td class="right">${money(i.unit_cents)}</td><td class="right">${money(Math.round(i.qty * i.unit_cents))}</td></tr>`) : html`<tr><td colspan="5" class="empty">No items</td></tr>`}</tbody></table>
        <div class="totals"><div><span>Subtotal</span><span>${money(b.totals.subtotal)}</span></div>
          ${Number(s.tax_rate) ? html`<div><span>${s.tax_name} (${s.tax_rate}%)</span><span>${money(b.totals.tax)}</span></div>` : ''}
          <div class="grand"><span>Total</span><span>${money(b.totals.total)}</span></div>
          ${isInvoice ? html`<div><span>Status</span><span class="${b.paid ? 'paid' : 'unpaid'}">${b.paid ? 'PAID' + (b.payment_method ? ' · ' + b.payment_method : '') : 'DUE'}</span></div>` : ''}
        </div>
        <p class="small muted" style="margin-top:2rem">Warranty: ${s.warranty} on parts and labour supplied.${isInvoice ? '' : ' Quote valid for 14 days.'}<br>${s.invoice_footer}</p>
      </article>`,
      nav,
    );
    $('#print').onclick = () => window.print();
  }

  // ---------- Week board ----------

  async function viewCalendar({ params, nav }) {
    const t = today();
    const d = new Date((params.get('start') || t) + 'T00:00:00');
    const monday = iso(new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)));
    const end = addDays(monday, 6);
    const rows = (await get(`/api/admin/bookings?from=${monday}&to=${end}`)).filter((b) => !['cancelled', 'no_show'].includes(b.status));
    const days = [...Array(7)].map((_, i) => addDays(monday, i));
    shell(
      html`${topbar('Week board', html`<a class="btn" href="#/calendar?start=${addDays(monday, -7)}">← Prev</a><a class="btn" href="#/calendar">This week</a><a class="btn" href="#/calendar?start=${addDays(monday, 7)}">Next →</a>`)}
      <p class="muted">${fmtDate(monday, { day: 'numeric', month: 'long' })} – ${fmtDate(end, { day: 'numeric', month: 'long', year: 'numeric' })} · capacity ${state.settings.slot_capacity} car(s) per slot</p>
      <div class="week">${days.map((day) => {
        const list = rows.filter((b) => b.date === day).sort((a, b) => a.time.localeCompare(b.time));
        return html`<section class="week-day ${day === t ? 'today' : ''}"><h3><span>${fmtDate(day)}</span><span class="muted">${list.length}</span></h3>
          ${list.map((b) => html`<a class="chip st-${b.status}" href="#/bookings/${b.id}"><b>${fmtTime(b.time)} · ${b.customer_name}</b>${b.service_name || 'Job'}<br><span class="muted">${vehicle(b)} ${b.rego || ''}</span></a>`)}
        </section>`;
      })}</div>`,
      nav,
    );
  }

  // ---------- Customers ----------

  async function viewCustomers({ params, nav }) {
    const q = params.get('q') || '';
    const rows = await get('/api/admin/customers?q=' + encodeURIComponent(q));
    shell(
      html`${topbar('Customers')}
      <div class="card">
        <form id="search" class="search" style="margin-bottom:.8rem"><input name="q" type="search" placeholder="Search name, phone, rego, car…" value="${q}"></form>
        ${rows.length
          ? html`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Phone</th><th class="hide-sm">Vehicles</th><th class="right">Visits</th><th class="hide-sm">Last visit</th></tr></thead>
          <tbody>${rows.map((c) => html`<tr class="click" data-href="#/customers/${c.id}"><td><b>${c.name}</b></td><td>${c.phone}</td><td class="hide-sm">${c.vehicles || '—'}</td><td class="right">${c.visits}</td><td class="hide-sm">${fmtDate(c.last_visit)}</td></tr>`)}</tbody></table></div>`
          : html`<p class="empty">No customers yet. They're created automatically from bookings.</p>`}
      </div>`,
      nav,
    );
    bindRows();
    $('#search').onsubmit = (e) => {
      e.preventDefault();
      location.hash = '#/customers?q=' + encodeURIComponent(e.target.q.value.trim());
    };
  }

  async function viewCustomer({ id, nav }) {
    const c = await get('/api/admin/customers/' + id);
    shell(
      html`${topbar(c.name, html`<a class="btn" href="tel:${c.phone}">Call</a>${waNumber(c.phone) ? html`<a class="btn" target="_blank" rel="noopener" href="https://wa.me/${waNumber(c.phone)}">WhatsApp</a>` : ''}`)}
      <div class="stats"><div class="stat"><b>${c.bookings.length}</b><span>Bookings</span></div><div class="stat"><b>${money(c.lifetime)}</b><span>Lifetime spend</span></div><div class="stat"><b>${fmtDate(c.created_at.slice(0, 10), { month: 'short', year: 'numeric' })}</b><span>Customer since</span></div></div>
      <div class="detail">
        <div>
          <div class="card"><h2>Bookings</h2>${bookingTable(c.bookings)}</div>
          <div class="card"><h2>Vehicles</h2>
            ${c.vehicles.length
              ? html`<table><thead><tr><th>Rego</th><th>Make</th><th>Model</th><th>Year</th><th></th></tr></thead><tbody>${c.vehicles.map(
                  (v) => html`<tr data-v="${v.id}"><td><input name="rego" value="${v.rego}"></td><td><input name="make" value="${v.make}"></td><td><input name="model" value="${v.model}"></td><td><input name="year" value="${v.year}" maxlength="4"></td><td><button class="btn btn-sm" data-save-v="${v.id}">Save</button></td></tr>`,
                )}</tbody></table>`
              : html`<p class="muted">No vehicles on file.</p>`}
          </div>
        </div>
        <form class="card" id="cust">
          <h2>Details</h2>
          <label class="f">Name<input name="name" value="${c.name}" required></label><br>
          <label class="f">Phone<input name="phone" value="${c.phone}" required></label><br>
          <label class="f">Email<input name="email" value="${c.email}"></label><br>
          <label class="f">Private notes<textarea name="notes" rows="5" placeholder="Preferences, fleet account, prefers Punjabi…">${c.notes}</textarea></label><br>
          <button class="btn btn-primary">Save customer</button>
        </form>
      </div>`,
      nav,
    );
    bindRows();
    $('#cust').onsubmit = async (e) => {
      e.preventDefault();
      if (await attempt(() => api('PATCH', '/api/admin/customers/' + id, formObj(e.target)), 'Customer saved')) router();
    };
    $$('[data-save-v]').forEach(
      (btn) =>
        (btn.onclick = () => {
          const tr = btn.closest('tr');
          const body = Object.fromEntries($$('input', tr).map((i) => [i.name, i.value]));
          attempt(() => api('PATCH', '/api/admin/vehicles/' + btn.dataset.saveV, body), 'Vehicle saved');
        }),
    );
  }

  // ---------- Services & rates ----------

  const ICONS = ['wrench', 'gauge', 'drop', 'disc', 'scan', 'tyre', 'battery', 'snow', 'spring', 'gear', 'search', 'shine', 'bolt', 'shield'];

  function serviceForm(svc = {}) {
    return html`<label class="f">Name<input name="name" required value="${svc.name || ''}"></label>
      <div class="grid2">
        <label class="f">Category<input name="category" required value="${svc.category || 'Repairs'}" list="cats"></label>
        <label class="f">Icon<select name="icon">${ICONS.map((i) => html`<option ${i === (svc.icon || 'wrench') ? raw('selected') : ''}>${i}</option>`)}</select></label>
        <label class="f">Price type<select name="price_type">${[['fixed', 'Fixed price'], ['from', 'From (starting at)'], ['quote', 'On quote']].map(([v, l]) => html`<option value="${v}" ${v === (svc.price_type || 'from') ? raw('selected') : ''}>${l}</option>`)}</select></label>
        <label class="f">Price (${state.settings.currency})<input name="price" type="number" step="0.01" min="0" value="${((svc.price_cents || 0) / 100).toFixed(2)}"></label>
        <label class="f">Duration (minutes)<input name="duration_min" type="number" min="5" step="5" value="${svc.duration_min || 60}"></label>
        <label class="f">Sort order<input name="sort" type="number" value="${svc.sort ?? 0}"></label>
      </div>
      <label class="f">Description (shown on website)<textarea name="description" maxlength="400">${svc.description || ''}</textarea></label>
      <label class="row"><input type="checkbox" name="active" ${svc.active === 0 ? '' : raw('checked')}> Show on website & booking form</label>
      <datalist id="cats">${[...new Set(state.services.map((s) => s.category))].map((c) => html`<option value="${c}">`)}</datalist>`;
  }
  const toService = (d) => ({ ...d, price_cents: Math.round(Number(d.price) * 100), duration_min: Number(d.duration_min), sort: Number(d.sort) });

  async function viewServices({ nav }) {
    const rows = await get('/api/admin/services');
    state.services = rows;
    const s = state.settings;
    shell(
      html`${topbar('Services & rates', html`<button class="btn btn-gold" id="add">+ Add service</button>`)}
      <p class="muted">These prices appear on the website and booking form instantly. Labour rate: <b>${money(s.labour_rate_cents)}/hr</b> (change in Settings).</p>
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Service</th><th class="hide-sm">Category</th><th>Price</th><th class="hide-sm">Duration</th><th>On site</th><th></th></tr></thead>
        <tbody>${rows.map(
          (r) => html`<tr><td><b>${r.name}</b><br><span class="muted small">${r.description}</span></td><td class="hide-sm">${r.category}</td>
            <td>${r.price_type === 'quote' ? 'On quote' : (r.price_type === 'from' ? 'From ' : '') + money(r.price_cents)}</td><td class="hide-sm">${r.duration_min} min</td>
            <td>${r.active ? '✓' : html`<span class="muted">Hidden</span>`}</td>
            <td class="right"><button class="btn btn-sm" data-edit="${r.id}">Edit</button></td></tr>`,
        )}</tbody></table></div></div>`,
      nav,
    );
    $('#add').onclick = async () => {
      const d = await modal('Add service', serviceForm());
      if (d && (await attempt(() => api('POST', '/api/admin/services', toService(d)), 'Service added'))) router();
    };
    $$('[data-edit]').forEach(
      (btn) =>
        (btn.onclick = async () => {
          const svc = rows.find((r) => r.id === Number(btn.dataset.edit));
          const d = await modal('Edit service', html`${serviceForm(svc)}<button type="button" class="btn btn-danger btn-sm" id="del-svc" style="justify-self:start">Delete service</button>`, {
            onOpen: (dlg) =>
              ($('#del-svc', dlg).onclick = async () => {
                if (!confirm(`Delete "${svc.name}"? Services with past bookings are hidden instead.`)) return;
                const r = await attempt(() => api('DELETE', '/api/admin/services/' + svc.id));
                if (r) {
                  toast(r.archived ? 'Service hidden (it has booking history)' : 'Service deleted');
                  $('[data-close]', dlg).click();
                  router();
                }
              }),
          });
          if (d && (await attempt(() => api('PATCH', '/api/admin/services/' + svc.id, toService(d)), 'Service saved'))) router();
        }),
    );
  }

  // ---------- Enquiries ----------

  async function viewEnquiries({ nav }) {
    const rows = await get('/api/admin/enquiries');
    shell(
      html`${topbar('Enquiries')}
      <div class="card">${rows.length
        ? html`<div class="table-wrap"><table><thead><tr><th>Received</th><th>From</th><th>Message</th><th></th></tr></thead><tbody>${rows.map(
            (e) => html`<tr style="${e.status === 'closed' ? 'opacity:.55' : ''}"><td class="small">${fmtStamp(e.created_at)}</td>
              <td><b>${e.name}</b><br>${e.phone ? html`<a href="tel:${e.phone}">${e.phone}</a><br>` : ''}${e.email ? html`<a href="mailto:${e.email}">${e.email}</a>` : ''}</td>
              <td style="white-space:pre-wrap;max-width:480px">${e.message}</td>
              <td class="right">${e.phone && waNumber(e.phone) ? html`<a class="btn btn-sm" target="_blank" rel="noopener" href="https://wa.me/${waNumber(e.phone)}">WhatsApp</a> ` : ''}<button class="btn btn-sm" data-enq="${e.id}" data-to="${e.status === 'open' ? 'closed' : 'open'}">${e.status === 'open' ? 'Mark done' : 'Re-open'}</button></td></tr>`,
          )}</tbody></table></div>`
        : html`<p class="empty">No enquiries yet.</p>`}</div>`,
      nav,
    );
    $$('[data-enq]').forEach(
      (b) =>
        (b.onclick = async () => {
          if (await attempt(() => api('PATCH', '/api/admin/enquiries/' + b.dataset.enq, { status: b.dataset.to }))) {
            refreshBadges();
            router();
          }
        }),
    );
  }

  // ---------- Reviews ----------

  const reviewForm = (r = {}) => html`<div class="grid2"><label class="f">Customer name<input name="name" required value="${r.name || ''}"></label><label class="f">Vehicle (optional)<input name="vehicle" value="${r.vehicle || ''}" placeholder="2021 Mercedes C300"></label></div>
    <label class="f">Rating<select name="rating">${[5, 4, 3, 2, 1].map((n) => html`<option value="${n}" ${n === (r.rating || 5) ? raw('selected') : ''}>${'★'.repeat(n)}</option>`)}</select></label>
    <label class="f">Review text<textarea name="text" required maxlength="600">${r.text || ''}</textarea></label>
    <label class="row"><input type="checkbox" name="active" ${r.active === 0 ? '' : raw('checked')}> Show on website</label>`;

  async function viewReviews({ nav }) {
    const rows = await get('/api/admin/testimonials');
    shell(
      html`${topbar('Reviews', html`<button class="btn btn-gold" id="add">+ Add review</button>`)}
      <p class="muted">Copy real reviews from Google or Facebook (with the customer's OK). The reviews section on the website stays hidden until at least one is added.</p>
      <div class="card">${rows.length
        ? html`<table><tbody>${rows.map((r) => html`<tr><td><b>${r.name}</b> <span style="color:var(--gold)">${'★'.repeat(r.rating)}</span>${r.active ? '' : html` <span class="pill">Hidden</span>`}<br><span class="muted small">${r.vehicle}</span><p style="margin:.3rem 0 0">${r.text}</p></td><td class="right"><button class="btn btn-sm" data-edit="${r.id}">Edit</button> <button class="btn btn-sm btn-danger" data-del="${r.id}">Delete</button></td></tr>`)}</tbody></table>`
        : html`<p class="empty">No reviews yet.</p>`}</div>`,
      nav,
    );
    $('#add').onclick = async () => {
      const d = await modal('Add review', reviewForm());
      if (d && (await attempt(() => api('POST', '/api/admin/testimonials', d), 'Review added'))) router();
    };
    $$('[data-edit]').forEach(
      (b) =>
        (b.onclick = async () => {
          const d = await modal('Edit review', reviewForm(rows.find((r) => r.id === Number(b.dataset.edit))));
          if (d && (await attempt(() => api('PATCH', '/api/admin/testimonials/' + b.dataset.edit, d), 'Review saved'))) router();
        }),
    );
    $$('[data-del]').forEach(
      (b) =>
        (b.onclick = async () => {
          if (confirm('Delete this review?') && (await attempt(() => api('DELETE', '/api/admin/testimonials/' + b.dataset.del), 'Deleted'))) router();
        }),
    );
  }

  // ---------- Settings ----------

  async function viewSettings({ nav }) {
    const s = await get('/api/admin/settings');
    state.settings = s;
    const owner = state.me.role === 'owner';
    const users = owner ? await get('/api/admin/users') : [];
    const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const f = (key, label, attrs = '') => html`<label class="f">${label}<input name="${key}" value="${s[key]}" ${raw(attrs)} ${owner ? '' : raw('disabled')}></label>`;
    shell(
      html`${topbar('Settings')}
      ${owner ? '' : html`<p class="card muted">Only the owner can change business settings.</p>`}
      <form id="settings">
        <div class="detail">
          <div>
            <div class="card"><h2>Business details (shown on website & invoices)</h2>
              <div class="grid2">${f('business_name', 'Business name')}${f('tagline', 'Tagline')}${f('phone', 'Phone')}${f('whatsapp', 'WhatsApp number (digits, with country code)')}${f('email', 'Email', 'type="email"')}${f('abn', 'Business / tax number')}</div>
              <br>${f('address', 'Address')}<br>${f('maps_url', 'Google Maps link')}<br>${f('warranty', 'Warranty wording')}<br>${f('invoice_footer', 'Invoice footer')}
            </div>
            <div class="card"><h2>Opening hours</h2>
              <table>${[1, 2, 3, 4, 5, 6, 0].map((d) => {
                const r = s.hours[d];
                return html`<tr data-day="${d}"><td><label class="row"><input type="checkbox" class="open" ${r ? raw('checked') : ''} ${owner ? '' : raw('disabled')}> ${DAYS[d]}</label></td>
                  <td><input type="time" class="from" value="${r ? r[0] : '08:00'}" ${owner ? '' : raw('disabled')}></td><td><input type="time" class="to" value="${r ? r[1] : '17:00'}" ${owner ? '' : raw('disabled')}></td></tr>`;
              })}</table>
              <label class="f" style="margin-top:.8rem">Closed dates (holidays) — one per line, YYYY-MM-DD<textarea name="closed_dates" rows="3" ${owner ? '' : raw('disabled')}>${s.closed_dates.join('\n')}</textarea></label>
            </div>
          </div>
          <div>
            <div class="card"><h2>Rates, tax & booking rules</h2>
              <div class="grid2">
                ${f('currency', 'Currency symbol')}${f('country_code', 'Phone country code', 'inputmode="numeric"')}
                <label class="f">Labour rate / hr<input name="labour_rate" type="number" step="0.01" value="${(Number(s.labour_rate_cents) / 100).toFixed(2)}" ${owner ? '' : raw('disabled')}></label>
                ${f('tax_name', 'Tax name (GST, HST, VAT…)')}${f('tax_rate', 'Tax rate %', 'type="number" step="0.01" min="0"')}
                ${f('slot_minutes', 'Slot length (min)', 'type="number" min="15" step="15"')}${f('slot_capacity', 'Cars per slot (bays)', 'type="number" min="1"')}${f('booking_days_ahead', 'Book up to N days ahead', 'type="number" min="1"')}
              </div>
            </div>
            ${owner ? html`<div class="card"><button class="btn btn-primary">Save settings</button></div>` : ''}
          </div>
        </div>
      </form>
      <div class="grid2" style="margin-top:1rem">
        <form class="card" id="pw"><h2>Change my password</h2>
          <label class="f">Current password<input name="current" type="password" autocomplete="current-password" required></label><br>
          <label class="f">New password (10+ characters)<input name="next" type="password" autocomplete="new-password" minlength="10" required></label><br>
          <button class="btn">Update password</button></form>
        ${owner
          ? html`<div class="card"><h2>Staff accounts</h2><table>${users.map((u) => html`<tr><td><b>${u.name}</b><br><span class="small muted">${u.email} · ${u.role}</span></td><td class="right">${u.id === state.me.id ? html`<span class="muted small">You</span>` : html`<button class="btn btn-sm" data-user="${u.id}" data-active="${u.active ? 0 : 1}">${u.active ? 'Disable' : 'Enable'}</button>`}</td></tr>`)}</table>
            <button class="btn" id="add-user" style="margin-top:.8rem">+ Add staff member</button></div>`
          : ''}
      </div>`,
      nav,
    );
    $('#settings').onsubmit = async (e) => {
      e.preventDefault();
      const d = formObj(e.target);
      const hours = {};
      $$('tr[data-day]').forEach((tr) => (hours[tr.dataset.day] = $('.open', tr).checked ? [$('.from', tr).value, $('.to', tr).value] : null));
      d.hours = hours;
      d.closed_dates = d.closed_dates.split(/\s+/).filter(Boolean);
      d.labour_rate_cents = Math.round(Number(d.labour_rate) * 100);
      delete d.labour_rate;
      const r = await attempt(() => api('PUT', '/api/admin/settings', d), 'Settings saved — website updated');
      if (r) state.settings = r;
    };
    $('#pw').onsubmit = async (e) => {
      e.preventDefault();
      if (await attempt(() => api('POST', '/api/admin/password', formObj(e.target)), 'Password changed')) e.target.reset();
    };
    $$('[data-user]').forEach(
      (b) =>
        (b.onclick = async () => {
          if (await attempt(() => api('PATCH', '/api/admin/users/' + b.dataset.user, { active: b.dataset.active === '1' }), 'Updated')) router();
        }),
    );
    $('#add-user') &&
      ($('#add-user').onclick = async () => {
        const d = await modal(
          'Add staff member',
          html`<label class="f">Name<input name="name" required></label><label class="f">Email<input name="email" type="email" required></label>
          <label class="f">Temporary password (10+ chars)<input name="password" minlength="10" required></label>
          <label class="f">Role<select name="role"><option value="staff">Staff — bookings & customers</option><option value="owner">Owner — full access</option></select></label>`,
          { submit: 'Create account' },
        );
        if (d && (await attempt(() => api('POST', '/api/admin/users', d), 'Staff account created'))) router();
      });
  }

  // ---------- Boot ----------

  async function boot() {
    try {
      const me = await api('GET', '/api/admin/me');
      state.me = me;
      state.settings = me.settings;
    } catch {
      return;
    }
    await router();
    refreshBadges();
  }
  setInterval(() => state.me && refreshBadges(), 60_000);
  boot();
})();
