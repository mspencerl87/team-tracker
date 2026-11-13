// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Spencer LeBlanc
'use strict';

// Everything a person enters (work hours, days off, partial-day times) is in
// that person's own time zone; everything this page shows as a clock time is
// converted to the viewer's zone (the picker in the top bar).

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem('tt.' + key);
    localStorage.setItem('tt.' + key, value);
  } catch { /* private window or blocked storage: settings just don't stick */ }
  return null;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${res.status} ${res.statusText}`);
  return json;
}

// ---------- calendar-date helpers (plain YYYY-MM-DD strings, no zone) ----------

const DAY = 86400e3;
const parseD = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const fmtD = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (s, n) => fmtD(parseD(s) + n * DAY);
const weekday = (s) => new Date(parseD(s)).getUTCDay();
const mondayOf = (s) => addDays(s, -((weekday(s) + 6) % 7));
const dayDiff = (a, b) => Math.round((parseD(b) - parseD(a)) / DAY);
function isoWeek(s) {
  const thu = parseD(addDays(mondayOf(s), 3));
  const jan1 = Date.UTC(new Date(thu).getUTCFullYear(), 0, 1);
  return 1 + Math.floor((thu - jan1) / DAY / 7);
}
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthOf = (s) => MON[Number(s.slice(5, 7)) - 1];
const niceDate = (s) => `${WD[weekday(s)]} ${Number(s.slice(8))} ${monthOf(s)}`;

// ---------- time-zone helpers ----------

const fmtCache = new Map();
function cached(key, make) {
  let f = fmtCache.get(key);
  if (!f) { f = make(); fmtCache.set(key, f); }
  return f;
}
function wall(tz, ms) {
  const f = cached('w' + tz, () => new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }));
  const p = {};
  for (const x of f.formatToParts(ms)) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
function offsetMs(tz, ms) {
  const w = wall(tz, ms);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}
// Wall-clock date + time in `tz` -> UTC ms. Two passes so a time next to a DST
// change lands on the right side; a time skipped by DST resolves forward.
function zonedToUtc(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = (timeStr || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const o1 = offsetMs(tz, guess);
  let t = guess - o1;
  const o2 = offsetMs(tz, t);
  if (o2 !== o1) t = guess - o2;
  return t;
}
const dateIn = (tz, ms) => { const w = wall(tz, ms); return `${w.y}-${pad(w.m)}-${pad(w.d)}`; };
const fmtTime = (ms, tz) => cached('t' + tz, () => new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit' })).format(ms);
const fmtDayTime = (ms, tz) => cached('dt' + tz, () => new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })).format(ms);
function tzAbbr(tz, ms = Date.now()) {
  const f = cached('a' + tz, () => new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }));
  return f.formatToParts(ms).find((p) => p.type === 'timeZoneName')?.value || tz;
}
function diffLabel(tz, ms = Date.now()) {
  const diff = (offsetMs(tz, ms) - offsetMs(state.viewerTz, ms)) / 3600e3;
  if (diff === 0) return 'same time';
  const h = Math.trunc(diff), m = Math.round(Math.abs(diff - h) * 60);
  return `${diff > 0 ? '+' : '−'}${Math.abs(h)}${m ? ':' + pad(m) : ''}h`;
}
function validTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
const ALL_TZ = (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : ['UTC']).concat('UTC');

// ---------- state ----------

const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const state = {
  data: { departments: [], groups: [], leaveTypes: [], people: [] },
  timeOff: [],
  offIdx: new Map(),
  canEdit: false,
  loginRequired: false,
  view: store('view') || 'calendar',
  viewerTz: validTz(store('tz') || '') ? store('tz') : browserTz,
  mode: store('mode') === 'groups' ? 'groups' : 'departments',
  selected: new Set(),
  search: '',
  anchor: null,
  hoursDate: null,
};
try { (JSON.parse(store('sel') || '[]') || []).forEach((v) => state.selected.add(v)); } catch { /* ignore */ }
const viewerToday = () => dateIn(state.viewerTz, Date.now());
state.anchor = viewerToday();
state.hoursDate = viewerToday();

const typeById = (id) => state.data.leaveTypes.find((t) => t.id === id);
const personById = (id) => state.data.people.find((p) => p.id === id);

async function loadData() {
  const [session, data] = await Promise.all([api('GET', '/api/session'), api('GET', '/api/data')]);
  state.canEdit = session.canEdit;
  state.loginRequired = session.loginRequired;
  state.data = data;
  // Drop filter picks that no longer exist.
  const valid = new Set([...data.departments.map((d) => 'd' + d.id), ...data.groups.map((g) => 'g' + g.id), 'd0']);
  for (const v of state.selected) if (!valid.has(v)) state.selected.delete(v);
}

async function loadTimeOff(from, to) {
  state.timeOff = await api('GET', `/api/time-off?from=${from}&to=${to}`);
  state.offIdx = new Map();
  for (const e of state.timeOff) {
    if (!state.offIdx.has(e.person_id)) state.offIdx.set(e.person_id, new Map());
    const byDate = state.offIdx.get(e.person_id);
    const a = e.start_date < from ? from : e.start_date;
    const b = e.end_date > to ? to : e.end_date;
    for (let d = a; d <= b; d = addDays(d, 1)) {
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(e);
    }
  }
}
const entriesOn = (personId, d) => state.offIdx.get(personId)?.get(d) || [];

// ---------- work-hour maths ----------

// UTC [start, end) spans a time-off entry covers on local date `d`.
function offSpan(e, d, tz) {
  const next = addDays(d, 1);
  switch (e.part) {
    case 'am': return [zonedToUtc(d, '00:00', tz), zonedToUtc(d, '12:00', tz)];
    case 'pm': return [zonedToUtc(d, '12:00', tz), zonedToUtc(next, '00:00', tz)];
    case 'hours': return [zonedToUtc(d, e.start_time, tz), zonedToUtc(d, e.end_time, tz)];
    default: return [zonedToUtc(d, '00:00', tz), zonedToUtc(next, '00:00', tz)];
  }
}

function subtract(spans, cuts) {
  let out = spans;
  for (const [cs, ce] of cuts) {
    const next = [];
    for (const [s, e] of out) {
      if (ce <= s || cs >= e) { next.push([s, e]); continue; }
      if (cs > s) next.push([s, cs]);
      if (ce < e) next.push([ce, e]);
    }
    out = next;
  }
  return out;
}

// A person's working time and time off inside the UTC window [a, b).
function personDay(p, a, b) {
  const tz = p.timezone;
  const work = [];
  const off = [];
  const first = addDays(dateIn(tz, a), -1); // yesterday's night shift can run into today
  const last = dateIn(tz, b - 1);
  for (let d = first; d <= last; d = addDays(d, 1)) {
    for (const [st, en] of p.schedule[weekday(d)] || []) {
      const s = zonedToUtc(d, st, tz);
      const e = en <= st ? zonedToUtc(addDays(d, 1), en, tz) : zonedToUtc(d, en, tz);
      work.push([s, e, en <= st]);
    }
    for (const entry of entriesOn(p.id, d)) off.push([...offSpan(entry, d, tz), entry]);
  }
  const clip = ([s, e, ...rest]) => [Math.max(s, a), Math.min(e, b), ...rest];
  const left = [];
  for (const [s, e, night] of work) {
    for (const span of subtract([[s, e]], off)) left.push([...span, night]);
  }
  return {
    work: left.map(clip).filter(([s, e]) => e > s),
    off: off.map(clip).filter(([s, e]) => e > s),
  };
}

function statusNow(p) {
  const now = Date.now();
  const { work, off } = personDay(p, now, now + 1);
  if (work.length) return 'on';
  if (off.length) return 'away';
  return '';
}

// ---------- filtering ----------

function sections() {
  const q = state.search.trim().toLowerCase();
  const people = state.data.people.filter((p) => p.active && (!q || p.name.toLowerCase().includes(q)));
  const out = [];
  if (state.mode === 'departments') {
    const list = [...state.data.departments.map((d) => ({ key: 'd' + d.id, id: d.id, name: d.name })), { key: 'd0', id: null, name: 'No department' }];
    for (const d of list) {
      if (state.selected.size && !state.selected.has(d.key)) continue;
      const members = people.filter((p) => (p.department_id ?? null) === d.id);
      if (members.length) out.push({ title: d.name, people: members });
    }
  } else {
    for (const g of state.data.groups) {
      if (state.selected.size && !state.selected.has('g' + g.id)) continue;
      const members = people.filter((p) => p.group_ids.includes(g.id));
      if (members.length) out.push({ title: g.name, people: members });
    }
    if (!state.selected.size) {
      const loose = people.filter((p) => !p.group_ids.length);
      if (loose.length) out.push({ title: 'No group', people: loose });
    }
  }
  return out;
}

function renderFilter() {
  const prefix = state.mode === 'departments' ? 'd' : 'g';
  const items = state.mode === 'departments'
    ? [...state.data.departments.map((d) => ['d' + d.id, d.name]), ['d0', 'No department']]
    : state.data.groups.map((g) => ['g' + g.id, g.name]);
  const picked = items.filter(([k]) => state.selected.has(k));
  $('#filterChips').innerHTML = picked.length
    ? picked.map(([, n]) => `<span class="chip">${esc(n)}</span>`).join('')
    : `<span class="placeholder">All ${state.mode}</span>`;
  $('#filterClear').hidden = !picked.length;
  $('#filterPop').innerHTML = items.length
    ? items.map(([k, n]) => `<label><input type="checkbox" value="${k}" ${state.selected.has(k) ? 'checked' : ''}> ${esc(n)}</label>`).join('')
    : `<div class="empty">No ${state.mode} yet. Add some under Manage.</div>`;
  // Picks for the other mode stay stored but don't filter this one.
  for (const k of [...state.selected]) if (!k.startsWith(prefix)) state.selected.delete(k);
}

// ---------- calendar view ----------

function cellStyle(entries, base) {
  if (!entries.length) return '';
  const e = entries[0];
  const c = typeById(e.type_id)?.color || '#888888';
  const fill = e.status === 'pending'
    ? `repeating-linear-gradient(135deg, ${c} 0 4px, ${c}55 4px 8px)`
    : `linear-gradient(${c}, ${c})`;
  const mask = {
    am: `linear-gradient(to right, transparent 50%, ${base} 50%)`,
    pm: `linear-gradient(to left, transparent 50%, ${base} 50%)`,
    hours: `linear-gradient(to top, transparent 40%, ${base} 40%)`,
  }[e.part];
  return `background-image:${mask ? mask + ',' : ''}${fill}`;
}

async function renderCalendar() {
  const view = $('#view');
  const nameW = window.innerWidth < 760 ? 150 : 220;
  const n = Math.max(14, Math.floor((view.clientWidth - 40 - nameW - 4) / 26));
  const start = addDays(mondayOf(state.anchor), -7);
  const days = Array.from({ length: n }, (_, i) => addDays(start, i));
  const end = days[days.length - 1];
  await loadTimeOff(start, end);
  const today = viewerToday();
  const secs = sections();

  if (!state.data.people.length) return renderEmpty();

  // Week header: one cell per (partial) ISO week.
  const weeks = [];
  for (const d of days) {
    const w = isoWeek(d);
    if (!weeks.length || weeks[weeks.length - 1].w !== w) weeks.push({ w, days: [] });
    weeks[weeks.length - 1].days.push(d);
  }
  const wkHead = weeks.map(({ w, days: ds }) => {
    const months = [...new Set(ds.map(monthOf))].join(' / ');
    const label = ds.length >= 3 ? `<span class="wknum">${w}</span><span class="mon">${months}</span>` : `<span class="wknum">${w}</span>`;
    return `<th colspan="${ds.length}">${label}</th>`;
  }).join('');
  const dayHead = days.map((d) => {
    const wd = weekday(d);
    return `<th class="${wd === 0 || wd === 6 ? 'weekend' : ''} ${d === today ? 'today' : ''}"><small>${WD[wd][0]}</small><span>${Number(d.slice(8))}</span></th>`;
  }).join('');

  let body = '';
  for (const sec of secs) {
    body += `<tr class="section"><td colspan="${n + 1}">${esc(sec.title)}</td></tr>`;
    for (const p of sec.people) {
      const st = statusNow(p);
      body += `<tr><td class="person" data-person="${p.id}"><span class="dot ${st}"></span><span class="pname">${esc(p.name)}</span><span class="plocal">${fmtTime(Date.now(), p.timezone)}</span></td>`;
      for (const d of days) {
        const off = !(p.schedule[weekday(d)] || []).length;
        const ents = entriesOn(p.id, d);
        const base = off ? 'var(--offday)' : 'var(--cell)';
        const cls = ['day', off && 'off', d === today && 'today', ents.length && 'has'].filter(Boolean).join(' ');
        body += `<td class="${cls}" data-p="${p.id}" data-d="${d}"${ents.length ? ` data-e="${ents[0].id}"` : ''} style="${cellStyle(ents, base)}"></td>`;
      }
      body += '</tr>';
    }
  }
  if (!secs.length) body = `<tr><td colspan="${n + 1}" class="person" style="text-align:center;color:var(--muted);height:60px">No one matches the current filter.</td></tr>`;

  view.innerHTML = `<div class="grid-wrap"><table class="grid">
    <colgroup><col class="name">${'<col class="day">'.repeat(n)}</colgroup>
    <thead>
      <tr class="wk"><th class="corner" rowspan="2">${esc(niceDate(start))} – ${esc(niceDate(end))}</th>${wkHead}</tr>
      <tr class="days">${dayHead}</tr>
    </thead>
    <tbody>${body}</tbody></table></div>`;
  renderLegend(true);
}

function renderEmpty() {
  $('#view').innerHTML = `<div class="empty-state">
    <p><b>No one here yet.</b></p>
    <p>Add your team under <b>Manage</b>${state.canEdit ? ', or load a sample team to look around (you can delete it later).' : '.'}</p>
    ${state.canEdit ? '<button class="btn primary" id="demoBtn">Load a sample team</button>' : ''}
  </div>`;
  $('#demoBtn')?.addEventListener('click', async () => {
    try { await api('POST', '/api/demo'); await loadData(); render(); } catch (err) { alert(err.message); }
  });
  renderLegend(false);
}

function renderLegend(show) {
  $('#legend').innerHTML = show
    ? state.data.leaveTypes.map((t) => `<span><i style="background:${t.color}"></i>${esc(t.name)}</span>`).join('') +
      `<span><i style="background:repeating-linear-gradient(135deg,#888 0 3px,#8885 3px 6px)"></i>Pending</span>` +
      `<span><i style="background:linear-gradient(to right,#888 50%,transparent 50%);border:1px solid var(--line)"></i>Half day</span>` +
      `<span><i style="background:var(--offday)"></i>Not a working day</span>`
    : '';
}

// ---------- hours view ----------

async function renderHours() {
  const tz = state.viewerTz;
  const day = state.hoursDate;
  const a = zonedToUtc(day, '00:00', tz);
  const b = zonedToUtc(addDays(day, 1), '00:00', tz);
  const span = b - a;
  await loadTimeOff(addDays(day, -2), addDays(day, 2));
  if (!state.data.people.length) return renderEmpty();
  const pct = (t) => ((t - a) / span) * 100;
  const secs = sections();

  let ticks = '';
  for (let t = a, i = 0; t < b; t += 3600e3, i++) {
    const h = wall(tz, t).h;
    ticks += `<div class="tick ${h % 6 === 0 ? 'major' : ''}" style="left:${pct(t)}%">${i % (window.innerWidth < 760 ? 3 : 1) === 0 ? `<span>${pad(h)}</span>` : ''}</div>`;
  }
  const now = Date.now();
  const nowLine = now >= a && now < b ? `<div class="nowline" style="left:${pct(now)}%"></div>` : '';

  const seen = new Set();
  const workers = [];
  let rows = '';
  for (const sec of secs) {
    rows += `<div class="hsection">${esc(sec.title)}</div>`;
    for (const p of sec.people) {
      const { work, off } = personDay(p, a, b);
      if (!seen.has(p.id)) { seen.add(p.id); workers.push(work); }
      let bars = '';
      for (const [s, e, entry] of off) {
        const t = typeById(entry.type_id);
        const c = t?.color || '#888888';
        const bg = entry.status === 'pending' ? `repeating-linear-gradient(135deg, ${c} 0 5px, ${c}66 5px 10px)` : c;
        bars += `<div class="bar offbar" data-e="${entry.id}" style="left:${pct(s)}%;width:${pct(e) - pct(s)}%;background:${bg}">${esc(t?.name || 'Off')}</div>`;
      }
      for (const [s, e, night] of work) {
        bars += `<div class="bar ${night ? 'night' : ''}" data-person="${p.id}" style="left:${pct(s)}%;width:${pct(e) - pct(s)}%">${fmtTime(s, p.timezone)}–${fmtTime(e, p.timezone)} their time</div>`;
      }
      const st = statusNow(p);
      rows += `<div class="hrow"><div class="hname" data-person="${p.id}"><span><span class="dot ${st}"></span>${esc(p.name)}</span>
        <span class="sub">${fmtTime(now, p.timezone)} ${esc(tzAbbr(p.timezone))} · ${diffLabel(p.timezone)}</span></div>
        <div class="track">${ticks.replace(/<span>.*?<\/span>/g, '')}${bars}${nowLine}</div></div>`;
    }
  }

  // Coverage: how many of the shown people are working in each half hour.
  const slots = Math.round(span / 1800e3);
  const counts = [];
  for (let i = 0; i < slots; i++) {
    const mid = a + (i + 0.5) * 1800e3;
    counts.push(workers.filter((w) => w.some(([s, e]) => s <= mid && mid < e)).length);
  }
  const max = Math.max(1, ...counts);
  const peak = Math.max(...counts, 0);
  const cov = counts.map((c, i) => {
    const t = a + i * 1800e3;
    return `<div class="cov ${c === peak && peak > 0 ? 'best' : ''}" title="${fmtTime(t, tz)}–${fmtTime(t + 1800e3, tz)}: ${c} working"><i style="height:${(c / max) * 100}%"></i></div>`;
  }).join('');
  let best = '';
  if (peak > 0) {
    // Longest run of half hours at the peak.
    let runStart = -1, bestStart = 0, bestLen = 0;
    counts.forEach((c, i) => {
      if (c === peak) { if (runStart < 0) runStart = i; if (i - runStart + 1 > bestLen) { bestLen = i - runStart + 1; bestStart = runStart; } } else runStart = -1;
    });
    const s = a + bestStart * 1800e3;
    best = `Most overlap: <b>${peak} of ${workers.length}</b> working ${fmtTime(s, tz)}–${fmtTime(s + bestLen * 1800e3, tz)} your time (${esc(tzAbbr(tz, s))}).`;
  } else {
    best = 'Nobody shown is working on this day.';
  }

  $('#view').innerHTML = `<div class="hours"><div class="hours-inner">
    <div class="hrow hhead"><div class="hname">${esc(niceDate(day))} · your time</div><div class="track">${ticks}${nowLine}</div></div>
    ${rows || '<div class="hours-note" style="padding:20px">No one matches the current filter.</div>'}
    <div class="hrow coverage"><div class="hname"><b>Coverage</b><span class="sub">people working, per half hour</span></div><div class="track">${cov}</div></div>
  </div></div><p class="hours-note">${best}</p>`;
  renderLegend(false);
}

// ---------- manage view ----------

function scheduleSummary(p) {
  const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => (p.schedule[d] || []).length);
  if (!days.length) return '<span class="muted">No hours</span>';
  const first = JSON.stringify(p.schedule[days[0]]);
  const same = days.every((d) => JSON.stringify(p.schedule[d]) === first);
  const span = p.schedule[days[0]].map(([s, e]) => `${s}–${e}`).join(', ');
  // Mon Tue Wed Thu Fri -> Mon–Fri (runs in Monday-first order).
  const runs = [];
  for (const d of days) {
    const i = SCHED_ORDER.indexOf(d);
    const last = runs[runs.length - 1];
    if (last && SCHED_ORDER.indexOf(last[1]) === i - 1) last[1] = d; else runs.push([d, d]);
  }
  const names = runs.map(([a, b]) => (a === b ? WD[a] : `${WD[a]}–${WD[b]}`)).join(', ');
  return same ? `${esc(names)} · ${span}` : `${esc(names)} · varies`;
}

function renderManage() {
  const { people, departments, groups, leaveTypes } = state.data;
  const dep = (id) => departments.find((d) => d.id === id)?.name || '';
  const grp = (ids) => ids.map((id) => groups.find((g) => g.id === id)?.name).filter(Boolean).join(', ');
  const ro = !state.canEdit;
  const simpleList = (kind, list, label) => `<div class="card"><h3>${label}</h3>
    <table class="list"><tbody>${list.map((x) => `<tr><td>${esc(x.name)}</td><td class="actions">${ro ? '' : `<button class="link" data-rename="${kind}" data-id="${x.id}">Rename</button><button class="link danger" data-del="${kind}" data-id="${x.id}">Delete</button>`}</td></tr>`).join('') || '<tr><td class="muted">None yet</td></tr>'}</tbody></table>
    ${ro ? '' : `<form class="inline-add" data-add="${kind}"><input type="text" name="name" placeholder="New ${label.toLowerCase().replace(/s$/, '')}" required maxlength="80"><button class="btn">Add</button></form>`}</div>`;

  $('#view').innerHTML = `${ro ? `<div class="notice">You're viewing read-only. ${state.loginRequired ? 'Log in as admin (top right) to make changes.' : ''}</div>` : ''}
  <div class="manage">
    <div class="card"><h3>People <span class="muted">${people.length}</span>${ro ? '' : '<button class="btn primary" id="addPerson">Add person</button>'}</h3>
      <table class="list"><thead><tr><th>Name</th><th>Department</th><th>Groups</th><th>Time zone</th><th>Work hours (their time)</th><th></th></tr></thead><tbody>
      ${people.map((p) => `<tr class="${p.active ? '' : 'inactive'}"><td>${esc(p.name)}${p.active ? '' : ' <span class="muted">(inactive)</span>'}</td><td>${esc(dep(p.department_id))}</td><td>${esc(grp(p.group_ids))}</td>
        <td>${esc(p.timezone)} <span class="muted">${diffLabel(p.timezone)}</span></td><td>${scheduleSummary(p)}</td>
        <td class="actions">${ro ? '' : `<button class="link" data-edit-person="${p.id}">Edit</button>`}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No one yet</td></tr>'}
      </tbody></table></div>
    <div>
      ${simpleList('departments', departments, 'Departments')}
      ${simpleList('groups', groups, 'Groups')}
      <div class="card"><h3>Time-off types</h3>
        <table class="list"><tbody>${leaveTypes.map((t) => `<tr><td><span class="swatch" style="background:${t.color}"></span> ${esc(t.name)}</td><td class="actions">${ro ? '' : `<input type="color" value="${t.color}" data-color="${t.id}" title="Change color"><button class="link" data-rename="leave-types" data-id="${t.id}">Rename</button><button class="link danger" data-del="leave-types" data-id="${t.id}">Delete</button>`}</td></tr>`).join('')}</tbody></table>
        ${ro ? '' : '<form class="inline-add" data-add="leave-types"><input type="color" name="color" value="#0ea5e9"><input type="text" name="name" placeholder="New type" required maxlength="60"><button class="btn">Add</button></form>'}
      </div>
    </div>
  </div>`;
  renderLegend(false);
}

async function manageAction(fn) {
  try { await fn(); await loadData(); render(); } catch (err) { alert(err.message); }
}

$('#view').addEventListener('submit', (ev) => {
  const form = ev.target.closest('[data-add]');
  if (!form) return;
  ev.preventDefault();
  const kind = form.dataset.add;
  const body = { name: form.name.value };
  if (kind === 'leave-types') { body.color = form.color.value; body.sort = state.data.leaveTypes.length + 1; }
  manageAction(() => api('POST', `/api/${kind}`, body));
});

$('#view').addEventListener('change', (ev) => {
  const id = ev.target.dataset.color;
  if (!id) return;
  const t = typeById(Number(id));
  manageAction(() => api('PUT', `/api/leave-types/${id}`, { ...t, color: ev.target.value }));
});

$('#view').addEventListener('click', (ev) => {
  const t = ev.target;
  if (t.id === 'addPerson') return openPerson(null);
  if (t.dataset.editPerson) return openPerson(personById(Number(t.dataset.editPerson)));
  if (t.dataset.rename) {
    const kind = t.dataset.rename;
    const list = kind === 'leave-types' ? state.data.leaveTypes : state.data[kind];
    const item = list.find((x) => x.id === Number(t.dataset.id));
    const name = prompt('New name', item.name);
    if (name && name.trim() !== item.name) manageAction(() => api('PUT', `/api/${kind}/${item.id}`, { ...item, name }));
    return;
  }
  if (t.dataset.del) {
    if (confirm('Delete this? It cannot be undone.')) manageAction(() => api('DELETE', `/api/${t.dataset.del}/${t.dataset.id}`));
  }
});

// ---------- person dialog ----------

let editingPerson = null;
const SCHED_ORDER = [1, 2, 3, 4, 5, 6, 0];

function openPerson(p) {
  editingPerson = p;
  const f = $('#personForm');
  $('#personTitle').textContent = p ? `Edit ${p.name}` : 'Add person';
  $('#personError').textContent = '';
  f.name.value = p?.name || '';
  f.email.value = p?.email || '';
  f.timezone.value = p?.timezone || state.viewerTz;
  f.active.checked = p ? p.active : true;
  f.department_id.innerHTML = '<option value="">None</option>' + state.data.departments.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  f.department_id.value = p?.department_id ?? '';
  $('#personGroups').innerHTML = state.data.groups.map((g) => `<label><input type="checkbox" value="${g.id}" ${p?.group_ids.includes(g.id) ? 'checked' : ''}> ${esc(g.name)}</label>`).join('') || '<span class="muted">No groups yet</span>';
  const sched = p?.schedule || { 1: [['09:00', '17:00']], 2: [['09:00', '17:00']], 3: [['09:00', '17:00']], 4: [['09:00', '17:00']], 5: [['09:00', '17:00']] };
  // One span per day here; a span whose end is at or before its start runs past midnight.
  $('#personSched').innerHTML = SCHED_ORDER.map((d) => {
    const [s, e] = (sched[d] || [])[0] || ['09:00', '17:00'];
    const on = (sched[d] || []).length > 0;
    return `<label class="inline"><input type="checkbox" data-day="${d}" ${on ? 'checked' : ''}> ${WD[d]}</label>
      <input type="time" data-start="${d}" value="${s}" ${on ? '' : 'disabled'}><input type="time" data-end="${d}" value="${e}" ${on ? '' : 'disabled'}>`;
  }).join('');
  $('#personDelete').hidden = !p;
  $('#personDlg').showModal();
}

$('#personSched').addEventListener('change', (ev) => {
  const d = ev.target.dataset.day;
  if (d === undefined) return;
  $(`[data-start="${d}"]`).disabled = !ev.target.checked;
  $(`[data-end="${d}"]`).disabled = !ev.target.checked;
});

$('#copyMon').addEventListener('click', () => {
  const on = $('[data-day="1"]').checked, s = $('[data-start="1"]').value, e = $('[data-end="1"]').value;
  for (const d of [2, 3, 4, 5]) {
    $(`[data-day="${d}"]`).checked = on;
    $(`[data-start="${d}"]`).value = s; $(`[data-end="${d}"]`).value = e;
    $(`[data-start="${d}"]`).disabled = $(`[data-end="${d}"]`).disabled = !on;
  }
});

$('#personForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  if (!validTz(f.timezone.value.trim())) { $('#personError').textContent = 'Pick a time zone from the list, like Europe/Paris.'; return; }
  const schedule = {};
  for (const d of SCHED_ORDER) {
    const s = $(`[data-start="${d}"]`).value, e = $(`[data-end="${d}"]`).value;
    schedule[d] = $(`[data-day="${d}"]`).checked && s && e ? [[s, e]] : [];
  }
  const body = {
    name: f.name.value, email: f.email.value, timezone: f.timezone.value.trim(),
    department_id: f.department_id.value || null, active: f.active.checked, schedule,
    group_ids: $$('#personGroups input:checked').map((i) => Number(i.value)),
  };
  try {
    await api(editingPerson ? 'PUT' : 'POST', editingPerson ? `/api/people/${editingPerson.id}` : '/api/people', body);
    $('#personDlg').close();
    await loadData(); render();
  } catch (err) { $('#personError').textContent = err.message; }
});

$('#personDelete').addEventListener('click', async () => {
  if (!confirm(`Delete ${editingPerson.name} and all their time off? This cannot be undone.`)) return;
  try { await api('DELETE', `/api/people/${editingPerson.id}`); $('#personDlg').close(); await loadData(); render(); } catch (err) { $('#personError').textContent = err.message; }
});

// ---------- time-off dialog ----------

let editingOff = null;

function openTimeOff(entry, defaults = {}) {
  if (!state.canEdit && !entry) return;
  editingOff = entry;
  const f = $('#offForm');
  const src = entry || { person_id: defaults.person_id, type_id: state.data.leaveTypes[0]?.id, start_date: defaults.start, end_date: defaults.end, part: 'full', status: 'approved' };
  $('#offTitle').textContent = entry ? 'Edit time off' : 'Add time off';
  $('#offError').textContent = '';
  f.person_id.innerHTML = state.data.people.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  f.type_id.innerHTML = state.data.leaveTypes.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  f.person_id.value = src.person_id; f.type_id.value = src.type_id;
  f.start_date.value = src.start_date; f.end_date.value = src.end_date;
  f.part.value = src.part; f.status.value = src.status;
  f.start_time.value = src.start_time || '09:00'; f.end_time.value = src.end_time || '12:00';
  f.note.value = src.note || '';
  $('#offDelete').hidden = !entry || !state.canEdit;
  for (const el of f.elements) if (el.dataset.close === undefined && el.type !== 'button') el.disabled = !state.canEdit;
  $('#offForm button[type=submit]').hidden = !state.canEdit;
  updateOffHint();
  $('#offDlg').showModal();
}

function updateOffHint() {
  const f = $('#offForm');
  $('#offHours').hidden = f.part.value !== 'hours';
  const p = personById(Number(f.person_id.value));
  if (!p || !f.start_date.value) { $('#offTzHint').textContent = ''; return; }
  const fake = { part: f.part.value, start_time: f.start_time.value, end_time: f.end_time.value };
  const s = offSpan(fake, f.start_date.value, p.timezone)[0];
  const e = offSpan(fake, f.end_date.value || f.start_date.value, p.timezone)[1];
  const same = offsetMs(p.timezone, s) === offsetMs(state.viewerTz, s);
  $('#offTzHint').textContent = `Dates and times are ${p.name}'s, in ${p.timezone}.` +
    (same ? '' : ` Your time: ${fmtDayTime(s, state.viewerTz)} → ${fmtDayTime(e, state.viewerTz)}.`);
}
['person_id', 'part', 'start_date', 'end_date', 'start_time', 'end_time'].forEach((n) => $('#offForm')[n].addEventListener('input', updateOffHint));

$('#offForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const body = Object.fromEntries(['person_id', 'type_id', 'start_date', 'end_date', 'part', 'start_time', 'end_time', 'status', 'note'].map((k) => [k, f[k].value]));
  try {
    await api(editingOff ? 'PUT' : 'POST', editingOff ? `/api/time-off/${editingOff.id}` : '/api/time-off', body);
    $('#offDlg').close(); render();
  } catch (err) { $('#offError').textContent = err.message; }
});

$('#offDelete').addEventListener('click', async () => {
  if (!confirm('Delete this time off?')) return;
  try { await api('DELETE', `/api/time-off/${editingOff.id}`); $('#offDlg').close(); render(); } catch (err) { $('#offError').textContent = err.message; }
});

for (const btn of $$('[data-close]')) btn.addEventListener('click', () => btn.closest('dialog').close());

// ---------- grid interaction: drag to add, click to open ----------

let drag = null;
$('#view').addEventListener('pointerdown', (ev) => {
  const td = ev.target.closest('td.day');
  if (!td || ev.button !== 0) return;
  if (td.dataset.e) { drag = { entry: Number(td.dataset.e) }; return; }
  if (!state.canEdit) return;
  drag = { person: td.dataset.p, from: td.dataset.d, to: td.dataset.d };
  td.classList.add('sel');
});
$('#view').addEventListener('pointerover', (ev) => {
  if (!drag || drag.entry) return;
  const td = ev.target.closest('td.day');
  if (!td || td.dataset.p !== drag.person) return;
  drag.to = td.dataset.d;
  const [a, b] = drag.from <= drag.to ? [drag.from, drag.to] : [drag.to, drag.from];
  for (const c of $$(`td.day[data-p="${drag.person}"]`)) c.classList.toggle('sel', c.dataset.d >= a && c.dataset.d <= b);
});
window.addEventListener('pointerup', () => {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.entry) return openTimeOff(state.timeOff.find((e) => e.id === d.entry));
  const [a, b] = d.from <= d.to ? [d.from, d.to] : [d.to, d.from];
  openTimeOff(null, { person_id: Number(d.person), start: a, end: b });
});
$('#offDlg').addEventListener('close', () => $$('td.sel').forEach((c) => c.classList.remove('sel')));
$('#view').addEventListener('click', (ev) => {
  const bar = ev.target.closest('.bar[data-e]');
  if (bar) openTimeOff(state.timeOff.find((e) => e.id === Number(bar.dataset.e)));
});

// ---------- tooltip ----------

function describeEntry(e) {
  const p = personById(e.person_id);
  const t = typeById(e.type_id);
  const range = e.start_date === e.end_date ? niceDate(e.start_date) : `${niceDate(e.start_date)} – ${niceDate(e.end_date)}`;
  const part = { full: 'Full day', am: 'Morning', pm: 'Afternoon', hours: `${e.start_time}–${e.end_time}` }[e.part];
  let yours = '';
  if (p && offsetMs(p.timezone, Date.now()) !== offsetMs(state.viewerTz, Date.now())) {
    const s = offSpan(e, e.start_date, p.timezone)[0];
    const en = offSpan(e, e.end_date, p.timezone)[1];
    yours = `<div class="tl">Your time: ${esc(fmtDayTime(s, state.viewerTz))} → ${esc(fmtDayTime(en, state.viewerTz))}${e.part === 'hours' && e.start_date !== e.end_date ? ' (each day)' : ''}</div>`;
  }
  return `<b>${esc(t?.name || 'Time off')}</b>${e.status === 'pending' ? ' · pending' : ''}<div>${esc(p?.name || '')}</div>
    <div>${esc(range)} · ${esc(part)} <span class="tl">(${esc(p?.timezone || '')})</span></div>${yours}${e.note ? `<div class="tl">${esc(e.note)}</div>` : ''}`;
}

function describePerson(p) {
  const now = Date.now();
  const lines = SCHED_ORDER.filter((d) => (p.schedule[d] || []).length).map((d) => {
    // Convert using the coming occurrence of that weekday so DST is current.
    const today = dateIn(p.timezone, now);
    const date = addDays(today, (d - weekday(today) + 7) % 7);
    return p.schedule[d].map(([s, e]) => {
      const us = zonedToUtc(date, s, p.timezone);
      const ue = e <= s ? zonedToUtc(addDays(date, 1), e, p.timezone) : zonedToUtc(date, e, p.timezone);
      const vd = dateIn(state.viewerTz, us);
      const shifted = vd !== date ? ` (${WD[weekday(vd)]})` : '';
      return `<div>${WD[d]} ${s}–${e} <span class="tl">→ ${fmtTime(us, state.viewerTz)}–${fmtTime(ue, state.viewerTz)}${shifted} yours</span></div>`;
    }).join('');
  }).join('');
  const st = statusNow(p);
  return `<b>${esc(p.name)}</b><div>${esc(fmtTime(now, p.timezone))} ${esc(tzAbbr(p.timezone))} · ${esc(p.timezone)} · ${diffLabel(p.timezone)}</div>
    <div class="tl">${st === 'on' ? 'Working now' : st === 'away' ? 'Off today' : 'Outside work hours'}</div>${lines || '<div class="tl">No work hours set</div>'}`;
}

const tip = $('#tooltip');
document.addEventListener('pointermove', (ev) => {
  if (drag) { tip.hidden = true; return; }
  const el = ev.target.closest?.('[data-e],[data-person]');
  if (!el || !$('#view').contains(el)) { tip.hidden = true; return; }
  let html = '';
  if (el.dataset.e) {
    const e = state.timeOff.find((x) => x.id === Number(el.dataset.e));
    if (e) html = describeEntry(e);
  } else {
    const p = personById(Number(el.dataset.person));
    if (p) html = describePerson(p);
  }
  if (!html) { tip.hidden = true; return; }
  if (tip.dataset.key !== (el.dataset.e || 'p' + el.dataset.person)) {
    tip.innerHTML = html;
    tip.dataset.key = el.dataset.e || 'p' + el.dataset.person;
  }
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - 14;
  if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - 14;
  tip.style.left = Math.max(8, x) + 'px';
  tip.style.top = Math.max(8, y) + 'px';
});

// ---------- toolbar and chrome ----------

function render() {
  for (const b of $$('#tabs button')) b.classList.toggle('active', b.dataset.view === state.view);
  for (const b of $$('#modeSeg button')) b.classList.toggle('active', b.dataset.mode === state.mode);
  document.body.classList.toggle('can-edit', state.canEdit);
  $('#toolbar').hidden = state.view === 'manage';
  $('#datePick').value = state.view === 'hours' ? state.hoursDate : state.anchor;
  const auth = $('#authBtn');
  auth.hidden = !state.loginRequired;
  auth.textContent = state.canEdit ? 'Log out' : 'Admin login';
  renderFilter();
  tip.hidden = true;
  const run = { calendar: renderCalendar, hours: renderHours, manage: renderManage }[state.view];
  Promise.resolve(run()).catch((err) => { $('#view').innerHTML = `<div class="empty-state">Couldn't load: ${esc(err.message)}</div>`; });
}

function tickClock() {
  $('#clock').textContent = `${fmtTime(Date.now(), state.viewerTz)} ${tzAbbr(state.viewerTz)}`;
}

$('#tabs').addEventListener('click', (ev) => {
  const v = ev.target.dataset.view;
  if (!v) return;
  state.view = v; store('view', v); render();
});
$('#modeSeg').addEventListener('click', (ev) => {
  const m = ev.target.dataset.mode;
  if (!m || m === state.mode) return;
  state.mode = m; store('mode', m); state.selected.clear(); store('sel', '[]'); render();
});
$('#filterBtn').addEventListener('click', (ev) => {
  if (ev.target.closest('#filterClear')) {
    state.selected.clear(); store('sel', '[]'); $('#filterPop').hidden = true; render(); return;
  }
  $('#filterPop').hidden = !$('#filterPop').hidden;
});
$('#filterPop').addEventListener('change', (ev) => {
  const v = ev.target.value;
  if (ev.target.checked) state.selected.add(v); else state.selected.delete(v);
  store('sel', JSON.stringify([...state.selected]));
  const pop = $('#filterPop');
  render();
  pop.hidden = false;
});
document.addEventListener('pointerdown', (ev) => {
  if (!ev.target.closest('#filter')) $('#filterPop').hidden = true;
});
$('#searchBtn').addEventListener('click', () => {
  const inp = $('#searchInput');
  inp.hidden = !inp.hidden;
  if (!inp.hidden) inp.focus(); else if (state.search) { state.search = ''; inp.value = ''; render(); }
});
$('#searchInput').addEventListener('input', (ev) => { state.search = ev.target.value; render(); });
$('#todayBtn').addEventListener('click', () => { state.anchor = state.hoursDate = viewerToday(); render(); });
$('#datePick').addEventListener('change', (ev) => {
  if (!ev.target.value) return;
  if (state.view === 'hours') state.hoursDate = ev.target.value; else state.anchor = ev.target.value;
  render();
});
function step(dir) {
  if (state.view === 'hours') state.hoursDate = addDays(state.hoursDate, dir);
  else state.anchor = addDays(state.anchor, dir * 7);
  render();
}
$('#prevBtn').addEventListener('click', () => step(-1));
$('#nextBtn').addEventListener('click', () => step(1));
document.addEventListener('keydown', (ev) => {
  if (ev.target.closest('input, select, textarea, dialog') || state.view === 'manage') return;
  if (ev.key === 'ArrowLeft') step(-1);
  if (ev.key === 'ArrowRight') step(1);
  if (ev.key === 't') { state.anchor = state.hoursDate = viewerToday(); render(); }
});

const tzInput = $('#viewerTz');
$('#tzList').innerHTML = ALL_TZ.map((z) => `<option value="${z}">`).join('');
tzInput.value = state.viewerTz;
tzInput.addEventListener('change', () => {
  const v = tzInput.value.trim();
  if (!validTz(v)) { tzInput.value = state.viewerTz; return; }
  state.viewerTz = v;
  store('tz', v);
  tickClock(); render();
});
tzInput.addEventListener('focus', () => tzInput.select());

$('#authBtn').addEventListener('click', async () => {
  if (state.canEdit) { await api('POST', '/api/logout'); await loadData(); render(); return; }
  $('#loginError').textContent = '';
  $('#loginForm').password.value = '';
  $('#loginDlg').showModal();
});
$('#loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await api('POST', '/api/login', { password: ev.target.password.value });
    $('#loginDlg').close(); await loadData(); render();
  } catch (err) { $('#loginError').textContent = err.message; }
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.view === 'calendar') render(); }, 150);
});

// Refresh the "working now" dots, local clocks and other people's edits.
setInterval(() => {
  tickClock();
  if (document.hidden || document.querySelector('dialog[open]') || drag) return;
  loadData().then(render).catch(() => {});
}, 60e3);

tickClock();
loadData().then(render).catch((err) => { $('#view').innerHTML = `<div class="empty-state">Couldn't reach the server: ${esc(err.message)}</div>`; });
