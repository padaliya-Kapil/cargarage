'use strict';
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  // ---- Nav ----
  const nav = $('.nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 20);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  const toggle = $('.nav-toggle');
  const links = $('#nav-links');
  const setMenu = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    links.classList.toggle('open', open);
    nav.classList.toggle('menu-open', open);
  };
  toggle.addEventListener('click', () => setMenu(toggle.getAttribute('aria-expanded') !== 'true'));
  links.addEventListener('click', (e) => e.target.closest('a') && setMenu(false));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && setMenu(false));

  // ---- Helpers ----
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fmtTime = (t) => {
    const [h, m] = t.split(':').map(Number);
    return `${h % 12 || 12}${m ? ':' + pad(m) : ''}${h >= 12 ? 'pm' : 'am'}`;
  };
  async function post(url, data) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Something went wrong. Please call us.');
    return body;
  }
  const formData = (form) => {
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    }
    return out;
  };
  function showError(form, msg) {
    const box = $('.form-error', form);
    box.textContent = msg;
    box.hidden = !msg;
  }

  // ---- Booking form ----
  const form = $('#book-form');
  if (form) {
    const cfg = JSON.parse(form.dataset.hours);
    const daysEl = $('#days');
    const slotsEl = $('#slots');
    const select = form.elements.service_id;

    // "Book" links on service cards pre-select that service.
    document.addEventListener('click', (e) => {
      const a = e.target.closest('[data-service], [data-service-name]');
      if (!a) return;
      if (a.dataset.service) select.value = a.dataset.service;
      else {
        const opt = [...select.options].find((o) => o.dataset.name === a.dataset.serviceName);
        if (opt) select.value = opt.value;
      }
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const span = Math.min(cfg.days || 45, 60);
    for (let i = 0; i < span; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      const date = iso(d);
      const closed = !cfg.hours[d.getDay()] || cfg.closed.includes(date);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'day';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.dataset.date = date;
      b.disabled = closed;
      const wd = i === 0 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' });
      b.innerHTML = `<small></small><b></b><small></small>`;
      b.children[0].textContent = wd;
      b.children[1].textContent = d.getDate();
      b.children[2].textContent = d.toLocaleDateString(undefined, { month: 'short' });
      b.setAttribute('aria-label', d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) + (closed ? ' (closed)' : ''));
      daysEl.append(b);
    }

    let reqId = 0;
    async function pickDay(btn) {
      $$('.day', daysEl).forEach((d) => d.setAttribute('aria-checked', String(d === btn)));
      form.elements.date.value = btn.dataset.date;
      form.elements.time.value = '';
      slotsEl.innerHTML = '<p class="muted small">Checking free times…</p>';
      const id = ++reqId;
      try {
        const res = await fetch('/api/slots?date=' + btn.dataset.date);
        const data = await res.json();
        if (id !== reqId) return;
        const free = (data.slots || []).filter((s) => s.available);
        if (!data.open || !free.length) {
          slotsEl.innerHTML = `<p class="muted small">${data.open ? 'Fully booked that day — try another day or call us.' : 'Closed that day.'}</p>`;
          return;
        }
        slotsEl.textContent = '';
        for (const s of data.slots) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'slot';
          b.setAttribute('role', 'radio');
          b.setAttribute('aria-checked', 'false');
          b.dataset.time = s.time;
          b.textContent = fmtTime(s.time);
          b.disabled = !s.available;
          slotsEl.append(b);
        }
      } catch {
        slotsEl.innerHTML = '<p class="muted small">Could not load times. Please call us.</p>';
      }
    }
    daysEl.addEventListener('click', (e) => {
      const b = e.target.closest('.day');
      if (b && !b.disabled) pickDay(b);
    });
    slotsEl.addEventListener('click', (e) => {
      const b = e.target.closest('.slot');
      if (!b || b.disabled) return;
      $$('.slot', slotsEl).forEach((s) => s.setAttribute('aria-checked', String(s === b)));
      form.elements.time.value = b.dataset.time;
    });
    const firstOpen = $('.day:not(:disabled)', daysEl);
    // Defer the first slot fetch until the form is near the viewport so the landing page stays light.
    if (firstOpen) {
      const io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          if (!form.elements.date.value) pickDay(firstOpen);
        }
      }, { rootMargin: '400px' });
      io.observe(form);
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError(form, '');
      const data = formData(form);
      $$('[aria-invalid]', form).forEach((el) => el.removeAttribute('aria-invalid'));
      const missing = [];
      for (const name of ['name', 'phone']) if (!data[name].trim()) missing.push(form.elements[name]);
      missing.forEach((el) => el.setAttribute('aria-invalid', 'true'));
      if (!data.date || !data.time) return showError(form, 'Please pick a day and a time.');
      if (missing.length) {
        missing[0].focus();
        return showError(form, 'Please add your name and mobile number.');
      }
      if (!data.consent) return showError(form, 'Please tick the box so we can confirm your booking.');
      const btn = $('button[type=submit]', form);
      btn.disabled = true;
      btn.textContent = 'Booking…';
      try {
        const res = await post('/api/bookings', data);
        showDone(res.ref, data, select.selectedOptions[0]?.dataset.name || 'Car service');
      } catch (err) {
        showError(form, err.message);
        if (/taken/.test(err.message)) {
          const day = $('.day[aria-checked="true"]', daysEl);
          if (day) pickDay(day);
        }
      } finally {
        btn.disabled = false;
        btn.textContent = 'Confirm booking';
      }
    });

    function showDone(ref, data, service) {
      const done = $('#book-done');
      $('#done-ref').textContent = ref;
      const when = new Date(`${data.date}T${data.time}:00`);
      $('#done-when').textContent = `${service} · ${when.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} at ${fmtTime(data.time)}`;
      const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      const end = new Date(when.getTime() + 60 * 60e3);
      const name = document.querySelector('.logo-text').textContent.replace('GARAGE', ' Garage');
      const ics = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Chobbar Garage//Booking//EN', 'BEGIN:VEVENT',
        `UID:${ref}@chobbargarage`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(when)}`, `DTEND:${stamp(end)}`,
        `SUMMARY:${service} at ${name}`, `DESCRIPTION:Booking ref ${ref}`, 'END:VEVENT', 'END:VCALENDAR',
      ].join('\r\n');
      $('#done-ics').href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
      const wa = $('#done-wa');
      wa.href = `${wa.href.split('?')[0]}?text=${encodeURIComponent(`Sat Sri Akal! I just booked ${service} (ref ${ref}).`)}`;
      form.hidden = true;
      done.hidden = false;
      done.focus();
    }
  }

  // ---- Enquiry form ----
  const enq = $('#enquiry-form');
  if (enq) {
    enq.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError(enq, '');
      $('.form-ok', enq).hidden = true;
      const data = formData(enq);
      if (!data.name.trim() || !data.message.trim()) return showError(enq, 'Please add your name and a message.');
      if (!data.phone.trim() && !data.email.trim()) return showError(enq, 'Please leave a phone number or email so we can reply.');
      const btn = $('button[type=submit]', enq);
      btn.disabled = true;
      try {
        await post('/api/enquiries', data);
        enq.reset();
        $('.form-ok', enq).hidden = false;
      } catch (err) {
        showError(enq, err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }
})();
