(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = { cfg: null, data: null, known: null, filter: 'all', openIncident: null, map: null, markers: {}, es: null };

  /* ───────────── helpers ───────────── */
  async function api(path, body) {
    const res = await fetch('/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    if (res.status === 401 && path !== '/auth/login') { showLogin(); throw new Error('Signed out'); }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Request failed');
    return json;
  }
  const catLabel = (k) => state.cfg?.categories.find((c) => c.key === k)?.label || k;
  const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
  const stamp = (iso) => (iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  const ago = (iso) => {
    if (!iso) return '—';
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
  };
  const mask = (p) => (p && p.length > 8 ? p.slice(0, 7) + '••••' + p.slice(-3) : p || '');
  const sev = (i) => (i.status === 'resolved' ? 'green' : i.confidence === 'LOW' ? 'amber' : 'red');
  const isActive = (i) => i.status !== 'resolved';

  function toast(msg, kind = '') {
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.textContent = msg;
    $('#toasts').append(t);
    setTimeout(() => t.remove(), 4500);
  }

  function confirmDialog(title, text, okLabel = 'Confirm', danger = false) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'overlay';
      ov.style.zIndex = 70;
      ov.innerHTML = `<div class="modal" style="max-width:440px" role="alertdialog" aria-modal="true"><div class="confirm-box">
        <h2>${esc(title)}</h2><p class="muted">${esc(text)}</p>
        <div class="actions" style="justify-content:flex-end"><button class="btn ghost" data-r="0">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(okLabel)}</button></div></div></div>`;
      ov.addEventListener('click', (e) => {
        const b = e.target.closest('[data-r]');
        if (b || e.target === ov) { ov.remove(); resolve(b?.dataset.r === '1'); }
      });
      document.body.append(ov);
      $('[data-r="1"]', ov).focus();
    });
  }

  /* ───────────── auth ───────────── */
  function showLogin() {
    closeStream();
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#pw').value = '';
    setTimeout(() => $('#pw').focus(), 50);
  }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#loginErr').textContent = '';
    try {
      await api('/auth/login', { password: $('#pw').value });
      await boot();
    } catch (err) {
      $('#loginErr').textContent = err.message;
    }
  });
  $('#pwToggle').addEventListener('click', (e) => {
    const show = $('#pw').type === 'password';
    $('#pw').type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'Hide' : 'Show';
    e.currentTarget.setAttribute('aria-pressed', show);
    e.currentTarget.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    $('#pw').focus();
  });
  $('#logout').addEventListener('click', async () => {
    await api('/auth/logout', {}).catch(() => {});
    showLogin();
  });

  /* ───────────── boot & live updates ───────────── */
  async function boot() {
    const me = await fetch('/api/auth/me').then((r) => r.json());
    if (!me.signedIn) return showLogin();
    state.cfg = await api('/config');
    $('#login').hidden = true;
    $('#app').hidden = false;
    setupStatic();
    await load(true);
    openStream();
  }

  let loading = false, again = false;
  async function load(first = false) {
    if (loading) { again = true; return; }
    loading = true;
    try {
      const data = await api('/overview');
      detectNew(data, first);
      state.data = data;
      render();
      if (state.openIncident) refreshModal();
    } catch (e) {
      if (e.message !== 'Signed out') console.error(e);
    } finally {
      loading = false;
      if (again) { again = false; load(); }
    }
  }

  function detectNew(data, first) {
    const activeIds = new Set(data.incidents.filter(isActive).map((i) => i.id));
    if (state.known && !first) {
      for (const inc of data.incidents) {
        if (isActive(inc) && !state.known.has(inc.id)) {
          const box = $('#alert');
          box.hidden = false;
          box.innerHTML = `<span>🚨 POSSIBLE ${esc(catLabel(inc.category)).toUpperCase()} — ${esc(inc.area)} · ${inc.report_count} reports</span><button data-open="${inc.id}">Review incident</button>`;
        }
      }
    }
    state.known = activeIds;
  }

  function openStream() {
    closeStream();
    const es = new EventSource('/api/stream');
    state.es = es;
    let t;
    es.addEventListener('change', () => { clearTimeout(t); t = setTimeout(() => load(), 200); });
    es.onopen = () => $('#live').classList.add('on');
    es.onerror = () => $('#live').classList.remove('on');
  }
  function closeStream() { state.es?.close(); state.es = null; }
  setInterval(() => { if (!$('#app').hidden) load(); }, 20000);

  /* ───────────── static parts ───────────── */
  function setupStatic() {
    const c = state.cfg;
    $('#biz').textContent = c.business;
    const mb = $('#modeBadge');
    mb.textContent = c.africasTalking === 'live' ? 'AT live' : c.africasTalking === 'sandbox' ? 'AT sandbox' : 'AT dry-run';
    mb.className = 'badge' + (c.africasTalking === 'live' ? ' live' : '');
    mb.title = c.africasTalking === 'dry-run' ? 'No AT_API_KEY set: messages are logged, not sent' : `Africa's Talking (${c.africasTalking})`;
    const catOpts = c.categories.map((k) => `<option value="${esc(k.key)}">${esc(k.label)} · ${esc(k.labelHa)}</option>`).join('');
    const areaOpts = c.areas.map((a) => `<option>${esc(a)}</option>`).join('');
    $('#simCat').innerHTML = catOpts; $('#incCat').innerHTML = catOpts;
    $('#simArea').innerHTML = areaOpts; $('#incArea').innerHTML = areaOpts;
    $('#simHint').textContent = `Threshold: ${c.threshold} distinct customers within ${c.windowMinutes} minutes opens a possible incident.`;
    const base = location.origin;
    $('#hooks').innerHTML = [
      ['USSD callback', '/at/ussd'], ['Incoming SMS callback', '/at/sms'], ['SMS delivery reports', '/at/sms/delivery'], ['Voice callback', '/at/voice'],
    ].map(([k, p]) => `<tr><td>${k}</td><td><code>${esc(base + p)}</code></td></tr>`).join('') +
      `<tr><td>USSD code</td><td><code>${esc(c.ussdCode)}</code></td></tr>`;
    initMap();
  }

  function initMap() {
    if (state.map || !window.L) {
      if (!window.L && !state.map) $('#map').innerHTML = '<div class="map-fallback">Map unavailable offline. Incident data is shown in the lists.</div>';
      return;
    }
    const m = L.map('map', { scrollWheelZoom: false }).setView(state.cfg.mapCenter, 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(m);
    state.map = m;
  }

  /* ───────────── render ───────────── */
  const COLORS = { red: '#e5484d', amber: '#f5a524', green: '#12a37d' };

  function render() {
    const { stats, incidents, reports, messages, rewards, charts, map } = state.data;

    $('#kpis').innerHTML = [
      { b: stats.reports, l: 'Reports', s: `${stats.last24h} in the last 24 h` },
      { b: stats.incidentsActive, l: 'Active incidents', s: `${stats.incidentsTotal} in total`, hot: stats.incidentsActive > 0 },
      { b: stats.resolvedPct + '%', l: 'Resolved', s: `${stats.confirmed} confirmed by customers` },
      { b: stats.areasAffected, l: 'Areas affected', s: `${stats.rewardsCount} rewards · ${state.cfg.currency} ${stats.rewardsTotal}` },
    ].map((k) => `<div class="kpi ${k.hot ? 'hot' : ''}"><b>${esc(k.b)}</b><span>${esc(k.l)}</span><small>${esc(k.s)}</small></div>`).join('');

    const active = incidents.filter(isActive);
    $('#incHint').textContent = active.length ? 'Click one to act' : '';
    $('#activeList').innerHTML = active.length
      ? active.map(incRow).join('')
      : `<div class="empty"><b>All clear</b>No active incidents. Reports will cluster here automatically.</div>`;

    const filtered = incidents.filter((i) => state.filter === 'all' || (state.filter === 'active' ? isActive(i) : !isActive(i)));
    $('#allIncidents').innerHTML = filtered.length ? filtered.map(incRow).join('') : `<div class="empty"><b>Nothing here yet</b>No incidents match this filter.</div>`;

    // charts
    const max = Math.max(1, ...charts.hourly.map((h) => h.n));
    $('#chartHourly').innerHTML = `<div class="hourly">${charts.hourly.map((h) =>
      `<div class="${h.n ? '' : 'zero'}" style="height:${h.n ? Math.max(6, (h.n / max) * 100) : 2}%" title="${esc(time(h.hour))} — ${h.n} report${h.n === 1 ? '' : 's'}"></div>`).join('')}</div>
      <div class="hourly-x"><span>24 h ago</span><span>now</span></div>`;
    $('#chartCat').innerHTML = barList(charts.byCategory.map((c) => [c.label, c.n]));
    $('#chartArea').innerHTML = barList(charts.byArea.map((a) => [a.area, a.n]));

    renderMap(map);

    $('#reportsTable').innerHTML = `<thead><tr><th>Ticket</th><th>Phone</th><th>Problem</th><th>Area</th><th>Channel</th><th>Status</th><th>Reported</th><th></th></tr></thead><tbody>${
      reports.length ? reports.map((r) => `<tr>
        <td><b>#${esc(r.code)}</b></td><td>${esc(mask(r.phone))}</td><td>${esc(catLabel(r.category))}</td><td>${esc(r.area)}</td>
        <td>${esc(r.channel)}${r.recording_url ? ` · <a href="${esc(r.recording_url)}" target="_blank" rel="noopener noreferrer">▶ voice note</a>` : ''}</td>
        <td><span class="pill ${esc(r.status)}">${esc(r.status)}</span></td><td title="${esc(stamp(r.created_at))}">${esc(ago(r.created_at))}</td>
        <td>${['open', 'linked'].includes(r.status) ? `<button class="btn ghost sm" data-resolve-ticket="${r.id}">Mark fixed</button>` : ''}</td></tr>`).join('')
        : `<tr><td colspan="8"><div class="empty"><b>No reports yet</b>Dial the USSD code or use Demo tools.</div></td></tr>`}</tbody>`;

    $('#msgTable').innerHTML = `<thead><tr><th>When</th><th>Phone</th><th>Type</th><th>Message</th><th>Status</th></tr></thead><tbody>${
      messages.length ? messages.map((m) => `<tr><td title="${esc(stamp(m.created_at))}">${esc(time(m.created_at))}</td><td>${esc(mask(m.phone))}</td>
        <td>${esc(m.direction === 'in' ? '↩ ' + m.kind : m.kind)}</td><td class="msg">${esc(m.body)}</td>
        <td><span class="pill ${esc(m.status)}" title="${esc(m.detail || '')}">${esc(m.status)}</span></td></tr>`).join('')
        : `<tr><td colspan="5"><div class="empty"><b>No messages yet</b></div></td></tr>`}</tbody>`;

    $('#rewardTable').innerHTML = `<thead><tr><th>When</th><th>Phone</th><th>Amount</th><th>Status</th></tr></thead><tbody>${
      rewards.length ? rewards.map((r) => `<tr><td>${esc(time(r.created_at))}</td><td>${esc(mask(r.phone))}</td><td>${esc(r.currency)} ${esc(r.amount)}</td>
        <td><span class="pill ${esc(r.status)}" title="${esc(r.detail || '')}">${esc(r.status)}</span></td></tr>`).join('')
        : `<tr><td colspan="4"><div class="empty"><b>No rewards yet</b>Rewards are sent when customers confirm a fix.</div></td></tr>`}</tbody>`;
  }

  function incRow(i) {
    const s = sev(i);
    return `<button class="inc" data-open="${i.id}">
      <span class="dot ${s}"></span>
      <span><strong>${esc(i.area)} — ${esc(catLabel(i.category))}</strong>
        <span class="meta"><span class="pill ${esc(i.status)}">${esc(i.status)}</span><span class="conf">${esc(i.confidence)}</span> · first report ${esc(time(i.first_report_at))} · ${esc(i.code)}</span></span>
      <span class="n">${i.report_count}<small>reports</small></span></button>`;
  }

  function barList(rows) {
    if (!rows.length) return '<div class="empty">No data yet</div>';
    const max = Math.max(...rows.map((r) => r[1]));
    return `<div class="bars">${rows.map(([l, n]) => `<div class="bar-row"><span>${esc(l)}</span><span class="t"><i style="width:${(n / max) * 100}%"></i></span><b>${n}</b></div>`).join('')}</div>`;
  }

  function renderMap(points) {
    if (!state.map) return;
    for (const p of points) {
      const color = COLORS[p.severity];
      const radius = 10 + Math.min(26, Math.sqrt(p.reports) * 5);
      const tip = `<b>${esc(p.area)}</b><br>${p.reports} report${p.reports === 1 ? '' : 's'}${p.incident ? `<br>${esc(catLabel(p.incident.category))} incident` : ''}`;
      let mk = state.markers[p.area];
      if (!mk) {
        mk = L.circleMarker([p.lat, p.lng], { weight: 3, color: '#fff', fillOpacity: .85 }).addTo(state.map);
        mk.on('click', () => { if (mk._inc) openIncident(mk._inc); });
        state.markers[p.area] = mk;
      }
      mk._inc = p.incident?.id;
      mk.setStyle({ fillColor: color });
      mk.setRadius(radius);
      mk.bindTooltip(tip, { direction: 'top' });
    }
    const pts = points.map((p) => [p.lat, p.lng]);
    if (pts.length && !state.fitted) { state.map.fitBounds(pts, { padding: [40, 40], maxZoom: 13 }); state.fitted = true; }
    setTimeout(() => state.map.invalidateSize(), 50);
  }

  /* ───────────── incident modal ───────────── */
  async function openIncident(id) {
    state.openIncident = id;
    $('#overlay').hidden = false;
    document.body.style.overflow = 'hidden';
    $('#modal').innerHTML = '<div class="confirm-box"><p class="muted">Loading…</p></div>';
    await refreshModal();
  }

  function closeModal() {
    state.openIncident = null;
    $('#overlay').hidden = true;
    document.body.style.overflow = '';
  }

  async function refreshModal() {
    if (!state.openIncident) return;
    let d;
    try { d = await api('/incidents/' + state.openIncident); } catch (e) { toast(e.message, 'err'); return closeModal(); }
    const i = d.incident;
    const composerOpen = $('#composer') && !$('#composer').hidden;
    const draft = $('#bMsg')?.value || '';
    const done = i.status === 'resolved';
    const waiting = d.tickets.filter((t) => t.status === 'resolved').length;
    const confirmed = d.tickets.filter((t) => t.status === 'confirmed').length;
    const disputed = d.tickets.filter((t) => t.status === 'disputed').length;
    $('#modal').innerHTML = `
      <div class="m-head"><div>
        <span class="pill ${esc(i.status)}">${esc(i.status)}</span><span class="conf">${esc(i.confidence)} CONFIDENCE · ${esc(i.code)} · ${i.source === 'manual' ? 'opened manually' : 'auto-detected'}</span>
        <h2 id="mTitle">${esc(catLabel(i.category))} — ${esc(i.area)}</h2></div>
        <button class="m-x" data-close aria-label="Close">×</button></div>
      <div class="m-body">
        <dl class="facts" style="margin:0">
          <div><dt>Reports</dt><dd>${i.report_count}</dd></div>
          <div><dt>Affected customers</dt><dd>${i.customer_count}${i.customer_count ? '+' : ''}</dd></div>
          <div><dt>Broadcasts sent</dt><dd>${i.broadcast_count}</dd></div>
          <div><dt>First reported</dt><dd>${esc(time(i.first_report_at))}</dd></div>
          <div><dt>Latest report</dt><dd>${esc(time(i.last_report_at))}</dd></div>
          <div><dt>${done ? 'Resolved' : 'Status'}</dt><dd>${done ? esc(time(i.resolved_at)) : esc(i.status.toUpperCase())}</dd></div>
        </dl>
        ${done ? `<p class="muted">Customers were asked to confirm the fix: <b>${confirmed}</b> confirmed · <b>${disputed}</b> say it is not fixed · <b>${waiting}</b> waiting.${i.status === 'resolved' && disputed ? ' Enough “not fixed” answers re-open the incident automatically.' : ''}</p>` : `
        <div class="actions">
          <button class="btn primary" data-act="broadcast-default">Send SMS update</button>
          <button class="btn ghost" data-act="toggle-composer">Create broadcast</button>
          ${i.status === 'possible' ? '<button class="btn ghost" data-act="investigate">Mark investigating</button>' : ''}
          <button class="btn amber" data-act="resolve" style="margin-left:auto">Mark resolved</button>
        </div>
        <div class="composer" id="composer" ${composerOpen ? '' : 'hidden'}>
          <label>Custom message <span class="muted small">(sent to all ${i.customer_count} affected customers; “KORAFI:” is added)</span>
            <textarea id="bMsg" maxlength="300" placeholder="Ana aiki a kai. Za mu sanar da kai idan an gyara.">${esc(draft)}</textarea></label>
          <div class="row"><span class="muted small" id="bCount">0 / 300</span><button class="btn primary" data-act="broadcast-custom">Send broadcast</button></div>
        </div>`}
        <div class="m-sec"><h3>Customer reports (${d.tickets.length})</h3><div class="table-wrap"><table>
          <thead><tr><th>Ticket</th><th>Phone</th><th>Channel</th><th>Status</th><th>Reported</th></tr></thead><tbody>${
          d.tickets.slice(0, 40).map((t) => `<tr><td>#${esc(t.code)}</td><td>${esc(mask(t.phone))}</td><td>${esc(t.channel)}</td><td><span class="pill ${esc(t.status)}">${esc(t.status)}</span></td><td>${esc(time(t.created_at))}</td></tr>`).join('')
          || '<tr><td colspan="5" class="muted">No reports linked yet.</td></tr>'}</tbody></table></div></div>
        <div class="m-sec"><h3>Messages sent</h3><div class="table-wrap"><table><tbody>${
          d.messages.slice(0, 8).map((m) => `<tr><td>${esc(time(m.created_at))}</td><td>${esc(m.kind)}</td><td class="msg">${esc(m.body)}</td><td><span class="pill ${esc(m.status)}">${esc(m.status)}</span></td></tr>`).join('')
          || '<tr><td class="muted">Nothing sent yet.</td></tr>'}</tbody></table></div></div>
      </div>`;
    const ta = $('#bMsg');
    if (ta) { const upd = () => ($('#bCount').textContent = `${ta.value.length} / 300`); ta.addEventListener('input', upd); upd(); }
  }

  async function incidentAction(act) {
    const id = state.openIncident;
    const d = await api('/incidents/' + id);
    const n = d.incident.customer_count;
    try {
      if (act === 'toggle-composer') { const c = $('#composer'); c.hidden = !c.hidden; if (!c.hidden) $('#bMsg').focus(); return; }
      if (act === 'investigate') { await api(`/incidents/${id}/status`, { status: 'investigating' }); toast('Marked as investigating', 'ok'); }
      if (act === 'broadcast-default') {
        if (!(await confirmDialog('Send SMS update?', `Every customer who reported (${n}) will get a short update in their language.`, 'Send SMS'))) return;
        const r = await api(`/incidents/${id}/broadcast`, {});
        toast(`Update sent to ${r.total} customer${r.total === 1 ? '' : 's'}${r.failed ? ` (${r.failed} failed)` : ''}`, r.failed ? 'err' : 'ok');
      }
      if (act === 'broadcast-custom') {
        const msg = $('#bMsg').value.trim();
        if (!msg) return toast('Write a message first', 'err');
        if (!(await confirmDialog('Send broadcast?', `“${msg}” will be sent to ${n} customer${n === 1 ? '' : 's'}.`, 'Send broadcast'))) return;
        const r = await api(`/incidents/${id}/broadcast`, { message: msg });
        $('#bMsg').value = '';
        toast(`Broadcast sent to ${r.total} customer${r.total === 1 ? '' : 's'}${r.failed ? ` (${r.failed} failed)` : ''}`, r.failed ? 'err' : 'ok');
      }
      if (act === 'resolve') {
        if (!(await confirmDialog('Mark as resolved?', `Customers will be told it is fixed and asked to confirm. Each confirmation earns them ${state.cfg.currency} ${state.cfg.reward} airtime.`, 'Mark resolved'))) return;
        const r = await api(`/incidents/${id}/resolve`, {});
        toast(`Resolved. ${r.total} customer${r.total === 1 ? '' : 's'} asked to confirm.`, 'ok');
      }
      await load();
    } catch (e) { toast(e.message, 'err'); }
  }

  /* ───────────── events ───────────── */
  document.addEventListener('click', async (e) => {
    const t = e.target;
    const open = t.closest('[data-open]');
    if (open) { $('#alert').hidden = true; return openIncident(Number(open.dataset.open)); }
    if (t.closest('[data-close]') || t === $('#overlay')) return closeModal();
    const act = t.closest('[data-act]');
    if (act) return incidentAction(act.dataset.act);
    const rt = t.closest('[data-resolve-ticket]');
    if (rt) {
      try { const r = await api(`/tickets/${rt.dataset.resolveTicket}/resolve`, {}); toast('Customer asked to confirm the fix', 'ok'); await load(); } catch (err) { toast(err.message, 'err'); }
    }
    const tab = t.closest('[data-tab]');
    if (tab) switchTab(tab.dataset.tab);
    const f = t.closest('#incFilter [data-f]');
    if (f) { state.filter = f.dataset.f; $$('#incFilter button').forEach((b) => b.classList.toggle('on', b === f)); render(); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.openIncident && !$('.overlay[style]')) closeModal(); });

  function switchTab(name) {
    $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    $$('[data-view]').forEach((s) => (s.hidden = s.dataset.view !== name));
    if (name === 'overview' && state.map) setTimeout(() => state.map.invalidateSize(), 60);
  }

  $('#simForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = { category: f.get('category'), area: f.get('area'), count: Number(f.get('count')) || 1 };
    if (f.get('phone')) body.phone = f.get('phone');
    try {
      const r = await api('/simulate', body);
      toast(`${r.created} report${r.created === 1 ? '' : 's'} filed`, 'ok');
      switchTab('overview');
    } catch (err) { toast(err.message, 'err'); }
  });
  $('#incForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const inc = await api('/incidents', { category: f.get('category'), area: f.get('area') });
      toast('Incident created', 'ok');
      switchTab('overview');
      await load();
      openIncident(inc.id);
    } catch (err) { toast(err.message, 'err'); }
  });

  boot().catch(showLogin);
})();
