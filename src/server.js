// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Spencer LeBlanc

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const { cfg, auth, canEditPerson, requireAdmin, requireSignedIn, routes: authRoutes } = require('./auth');
const holidays = require('./holidays');

const dayCount = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400e3);

const PORT = Number(process.env.PORT) || 8080;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
authRoutes(app);

// ---------- validation ----------

class BadRequest extends Error {}
class Forbidden extends Error {}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function str(v, field, { max = 200, optional = false } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) {
    if (optional) return null;
    throw new BadRequest(`${field} is required.`);
  }
  if (s.length > max) throw new BadRequest(`${field} is too long.`);
  return s;
}

function date(v, field) {
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) {
    throw new BadRequest(`${field} must be a date (YYYY-MM-DD).`);
  }
  return v;
}

function time(v, field) {
  if (typeof v !== 'string' || !TIME_RE.test(v)) throw new BadRequest(`${field} must be HH:MM.`);
  return v;
}

function timezone(v) {
  const tz = str(v, 'Time zone', { max: 64 });
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new BadRequest(`Unknown time zone: ${tz}`);
  }
  return tz;
}

function schedule(v) {
  const out = {};
  const src = v && typeof v === 'object' ? v : {};
  for (let d = 0; d < 7; d++) {
    const spans = Array.isArray(src[d]) ? src[d] : [];
    if (spans.length > 4) throw new BadRequest('At most 4 work spans per day.');
    out[d] = spans.map(([a, b]) => [time(a, 'Work start'), time(b, 'Work end')]);
  }
  return out;
}

function idOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequest('Bad id.');
  return n;
}

function id(v) {
  const n = idOrNull(v);
  if (n === null) throw new BadRequest('Bad id.');
  return n;
}

// Wraps a handler so validation and constraint errors come back as 400s.
function handle(fn) {
  return (req, res) => {
    try {
      const out = fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (err) {
      if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
      if (err instanceof Forbidden) return res.status(403).json({ error: err.message });
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That name is already used.' });
      if (err.code && err.code.startsWith('SQLITE_CONSTRAINT')) return res.status(400).json({ error: 'That would break a link to other data.' });
      console.error(err);
      res.status(500).json({ error: 'Server error.' });
    }
  };
}

// ---------- reference data ----------

const DEFAULT_SCHEDULE = { 0: [], 1: [['09:00', '17:00']], 2: [['09:00', '17:00']], 3: [['09:00', '17:00']], 4: [['09:00', '17:00']], 5: [['09:00', '17:00']], 6: [] };

// The calendar is public, so email addresses only go to signed-in viewers.
function loadPeople(showEmail) {
  const groups = db.prepare('SELECT person_id, group_id FROM person_groups').all();
  const byPerson = new Map();
  for (const g of groups) {
    if (!byPerson.has(g.person_id)) byPerson.set(g.person_id, []);
    byPerson.get(g.person_id).push(g.group_id);
  }
  return db.prepare('SELECT * FROM people ORDER BY name COLLATE NOCASE').all().map((p) => ({
    ...p,
    email: showEmail ? p.email : null,
    active: Boolean(p.active),
    schedule: JSON.parse(p.schedule),
    group_ids: byPerson.get(p.id) || [],
    // holidays is the stored setting (null = from time zone); holiday_key what applies.
    holiday_key: holidays.effectiveKey(p.holidays, p.timezone),
  }));
}

// { "US": [{date, name}], "FR": [...] } for every holiday key in use.
app.get('/api/holidays', handle((req) => {
  const from = date(req.query.from, 'from');
  const to = date(req.query.to, 'to');
  if (dayCount(from, to) > 800) throw new BadRequest('Range too long.');
  const keys = new Set(db.prepare('SELECT holidays, timezone FROM people WHERE active = 1').all()
    .map((p) => holidays.effectiveKey(p.holidays, p.timezone)).filter(Boolean));
  return Object.fromEntries([...keys].map((k) => [k, holidays.between(k, from, to)]));
}));

// Countries, or one country's states/regions, for the holiday picker.
app.get('/api/holiday-options', handle((req) => (req.query.country
  ? holidays.regions(String(req.query.country).toUpperCase())
  : holidays.countries())));

app.get('/api/data', handle((req) => ({
  departments: db.prepare('SELECT * FROM departments ORDER BY name COLLATE NOCASE').all(),
  groups: db.prepare('SELECT * FROM groups ORDER BY name COLLATE NOCASE').all(),
  leaveTypes: db.prepare('SELECT * FROM leave_types ORDER BY sort, name').all(),
  people: loadPeople(auth(req).signedIn || cfg.open),
})));

// Departments and groups share one shape.
for (const table of ['departments', 'groups']) {
  app.post(`/api/${table}`, requireAdmin, handle((req) => {
    const info = db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).run(str(req.body.name, 'Name', { max: 80 }));
    return { id: info.lastInsertRowid };
  }));
  app.put(`/api/${table}/:id`, requireAdmin, handle((req) => {
    db.prepare(`UPDATE ${table} SET name = ? WHERE id = ?`).run(str(req.body.name, 'Name', { max: 80 }), id(req.params.id));
  }));
  app.delete(`/api/${table}/:id`, requireAdmin, handle((req) => {
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id(req.params.id));
  }));
}

function leaveTypeFields(body) {
  const color = str(body.color, 'Color', { max: 7 });
  if (!COLOR_RE.test(color)) throw new BadRequest('Color must look like #16a34a.');
  return [str(body.name, 'Name', { max: 60 }), color, Number.isInteger(body.sort) ? body.sort : 0];
}

app.post('/api/leave-types', requireAdmin, handle((req) => {
  const info = db.prepare('INSERT INTO leave_types (name, color, sort) VALUES (?, ?, ?)').run(...leaveTypeFields(req.body));
  return { id: info.lastInsertRowid };
}));
app.put('/api/leave-types/:id', requireAdmin, handle((req) => {
  db.prepare('UPDATE leave_types SET name = ?, color = ?, sort = ? WHERE id = ?').run(...leaveTypeFields(req.body), id(req.params.id));
}));
app.delete('/api/leave-types/:id', requireAdmin, handle((req) => {
  const used = db.prepare('SELECT COUNT(*) AS n FROM time_off WHERE type_id = ?').get(id(req.params.id)).n;
  if (used) throw new BadRequest(`${used} time-off entries use this type; change or delete them first.`);
  db.prepare('DELETE FROM leave_types WHERE id = ?').run(id(req.params.id));
}));

// ---------- people ----------

function holidaySetting(v) {
  if (v === null || v === undefined) return null; // from time zone
  if (v === '') return '';                         // none
  const key = String(v).toUpperCase();
  if (!holidays.validKey(key)) throw new BadRequest(`Unknown holiday country/region: ${v}`);
  return key;
}

function personFields(body) {
  return {
    name: str(body.name, 'Name', { max: 120 }),
    email: str(body.email, 'Email', { max: 200, optional: true }),
    department_id: idOrNull(body.department_id),
    timezone: timezone(body.timezone),
    schedule: JSON.stringify(body.schedule ? schedule(body.schedule) : DEFAULT_SCHEDULE),
    active: body.active === false ? 0 : 1,
    holidays: holidaySetting(body.holidays),
  };
}

function setGroups(personId, groupIds) {
  db.prepare('DELETE FROM person_groups WHERE person_id = ?').run(personId);
  const add = db.prepare('INSERT INTO person_groups (person_id, group_id) VALUES (?, ?)');
  for (const g of new Set((Array.isArray(groupIds) ? groupIds : []).map(id))) add.run(personId, g);
}

app.post('/api/people', requireAdmin, handle((req) => db.transaction(() => {
  const f = personFields(req.body);
  const info = db.prepare(`INSERT INTO people (name, email, department_id, timezone, schedule, active, holidays)
    VALUES (@name, @email, @department_id, @timezone, @schedule, @active, @holidays)`).run(f);
  setGroups(info.lastInsertRowid, req.body.group_ids);
  return { id: info.lastInsertRowid };
})()));

// Members edit their own row: name, department, groups, zone and hours. Email
// (it links their sign-in) and active stay as an admin left them.
app.put('/api/people/:id', requireSignedIn, handle((req) => db.transaction(() => {
  const pid = id(req.params.id);
  if (!canEditPerson(req, pid)) throw new Forbidden('You can only edit your own profile.');
  const current = db.prepare('SELECT * FROM people WHERE id = ?').get(pid);
  if (!current) throw new BadRequest('No such person.');
  const f = { ...personFields(req.body), id: pid };
  if (!auth(req).admin) { f.email = current.email; f.active = current.active; }
  db.prepare(`UPDATE people SET name = @name, email = @email, department_id = @department_id,
    timezone = @timezone, schedule = @schedule, active = @active, holidays = @holidays WHERE id = @id`).run(f);
  setGroups(f.id, req.body.group_ids);
})()));

app.delete('/api/people/:id', requireAdmin, handle((req) => {
  db.prepare('DELETE FROM people WHERE id = ?').run(id(req.params.id));
}));

// ---------- time off ----------

app.get('/api/time-off', handle((req) => {
  const from = date(req.query.from, 'from');
  const to = date(req.query.to, 'to');
  return db.prepare('SELECT * FROM time_off WHERE end_date >= ? AND start_date <= ? ORDER BY start_date').all(from, to);
}));

function timeOffFields(body) {
  const f = {
    person_id: id(body.person_id),
    type_id: id(body.type_id),
    start_date: date(body.start_date, 'Start date'),
    end_date: date(body.end_date, 'End date'),
    part: ['full', 'am', 'pm', 'hours'].includes(body.part) ? body.part : 'full',
    start_time: null,
    end_time: null,
    status: body.status === 'pending' ? 'pending' : 'approved',
    note: str(body.note, 'Note', { max: 500, optional: true }),
  };
  if (f.end_date < f.start_date) throw new BadRequest('End date is before the start date.');
  if (f.part === 'hours') {
    f.start_time = time(body.start_time, 'Start time');
    f.end_time = time(body.end_time, 'End time');
    if (f.end_time <= f.start_time) throw new BadRequest('End time must be after the start time.');
  }
  return f;
}

function ownedEntry(req) {
  const row = db.prepare('SELECT * FROM time_off WHERE id = ?').get(id(req.params.id));
  if (!row) throw new BadRequest('No such entry.');
  if (!canEditPerson(req, row.person_id)) throw new Forbidden('You can only change your own time off.');
  return row;
}

app.post('/api/time-off', requireSignedIn, handle((req) => {
  const f = timeOffFields(req.body);
  if (!canEditPerson(req, f.person_id)) throw new Forbidden('You can only add your own time off.');
  const info = db.prepare(`INSERT INTO time_off (person_id, type_id, start_date, end_date, part, start_time, end_time, status, note)
    VALUES (@person_id, @type_id, @start_date, @end_date, @part, @start_time, @end_time, @status, @note)`).run(f);
  return { id: info.lastInsertRowid };
}));

app.put('/api/time-off/:id', requireSignedIn, handle((req) => {
  const row = ownedEntry(req);
  const f = timeOffFields(req.body);
  if (!canEditPerson(req, f.person_id)) throw new Forbidden('You can only move time off between people you can edit.');
  db.prepare(`UPDATE time_off SET person_id = @person_id, type_id = @type_id, start_date = @start_date, end_date = @end_date,
    part = @part, start_time = @start_time, end_time = @end_time, status = @status, note = @note WHERE id = @id`)
    .run({ ...f, id: row.id });
}));

app.delete('/api/time-off/:id', requireSignedIn, handle((req) => {
  db.prepare('DELETE FROM time_off WHERE id = ?').run(ownedEntry(req).id);
}));

// ---------- users (admin) ----------

app.get('/api/users', requireAdmin, handle(() =>
  db.prepare('SELECT id, email, name, role, person_id, created_at, last_login FROM users ORDER BY email').all()));

app.put('/api/users/:id', requireAdmin, handle((req) => {
  const uid = id(req.params.id);
  const role = req.body.role === 'admin' ? 'admin' : 'member';
  const me = auth(req).user;
  if (me && me.id === uid && role !== 'admin') throw new BadRequest("You can't remove your own admin role.");
  db.prepare('UPDATE users SET role = ?, person_id = ? WHERE id = ?').run(role, idOrNull(req.body.person_id), uid);
}));

// Removes the account only; the person and their time off stay. Signing in
// again recreates the account (and relinks by email), so block people at the
// provider or drop their domain to keep them out.
app.delete('/api/users/:id', requireAdmin, handle((req) => {
  const uid = id(req.params.id);
  if (auth(req).user?.id === uid) throw new BadRequest("You can't delete your own account.");
  db.prepare('DELETE FROM users WHERE id = ?').run(uid);
}));

// ---------- sample team ----------

// One click on an empty install fills in a team spread over several zones, so
// the calendar and hours views have something to show. Refused once anyone exists.
app.post('/api/demo', requireAdmin, handle(() => db.transaction(() => {
  if (db.prepare('SELECT COUNT(*) AS n FROM people').get().n) throw new BadRequest('There are already people; the sample team only loads into an empty tracker.');
  const dep = (name) => db.prepare('INSERT OR IGNORE INTO departments (name) VALUES (?)').run(name) &&
    db.prepare('SELECT id FROM departments WHERE name = ?').get(name).id;
  const grp = (name) => db.prepare('INSERT OR IGNORE INTO groups (name) VALUES (?)').run(name) &&
    db.prepare('SELECT id FROM groups WHERE name = ?').get(name).id;
  const support = dep('Technical Support');
  const eng = dep('Engineering');
  const emea = grp('EMEA');
  const amer = grp('Americas');
  const apac = grp('APAC');
  const oncall = grp('On-call');
  const wk = (s, e, days = [1, 2, 3, 4, 5]) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, days.includes(d) ? [[s, e]] : []]));
  const people = [
    ['Ana Souza', support, 'America/Sao_Paulo', wk('08:00', '17:00'), [amer]],
    ['Ben Carter', support, 'America/New_York', wk('09:00', '17:30'), [amer, oncall]],
    ['Chloé Martin', support, 'Europe/Paris', wk('09:00', '18:00'), [emea]],
    ['Daniel Okafor', support, 'Africa/Lagos', wk('08:00', '16:00'), [emea, oncall]],
    ['Emma Wilson', support, 'Europe/London', wk('08:30', '17:00', [1, 2, 3, 4]), [emea]],
    ['Hiro Tanaka', eng, 'Asia/Tokyo', wk('10:00', '19:00'), [apac]],
    ['Isha Patel', eng, 'Asia/Kolkata', wk('10:00', '18:30'), [apac, oncall]],
    ['Jack Nguyen', eng, 'Australia/Sydney', wk('08:00', '16:30'), [apac]],
    ['Lucas Meyer', eng, 'Europe/Berlin', wk('22:00', '06:00', [0, 1, 2, 3, 4]), [emea, oncall]],
    ['Maya Brooks', eng, 'America/Los_Angeles', wk('09:00', '17:00'), [amer]],
  ];
  const addPerson = db.prepare('INSERT INTO people (name, department_id, timezone, schedule) VALUES (?, ?, ?, ?)');
  const ids = people.map(([name, d, tz, sched, groups]) => {
    const pid = addPerson.run(name, d, tz, JSON.stringify(sched)).lastInsertRowid;
    setGroups(pid, groups);
    return pid;
  });
  const types = Object.fromEntries(db.prepare('SELECT id, name FROM leave_types').all().map((t) => [t.name, t.id]));
  const day = (n) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
  const off = db.prepare(`INSERT INTO time_off (person_id, type_id, start_date, end_date, part, start_time, end_time, status, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const t = (name) => types[name] || types[Object.keys(types)[0]];
  off.run(ids[0], t('Vacation'), day(3), day(9), 'full', null, null, 'approved', 'Beach week');
  off.run(ids[1], t('Sick'), day(0), day(0), 'full', null, null, 'approved', null);
  off.run(ids[2], t('Remote / Travel'), day(-2), day(-1), 'full', null, null, 'approved', 'Customer visit');
  off.run(ids[2], t('Vacation'), day(14), day(18), 'full', null, null, 'pending', null);
  off.run(ids[3], t('Other'), day(1), day(1), 'pm', null, null, 'approved', 'Appointment');
  off.run(ids[4], t('Training'), day(6), day(7), 'full', null, null, 'approved', null);
  off.run(ids[5], t('Public holiday'), day(10), day(10), 'full', null, null, 'approved', null);
  off.run(ids[6], t('Other'), day(2), day(2), 'hours', '14:00', '16:00', 'approved', 'Dentist');
  off.run(ids[7], t('Vacation'), day(20), day(30), 'full', null, null, 'approved', 'Summer holidays');
  off.run(ids[9], t('Vacation'), day(-6), day(-3), 'full', null, null, 'approved', null);
  return { ok: true };
})()));

app.get('/healthz', (req, res) => res.send('ok'));

// The page links its script and stylesheet with a hash of their contents
// (app.js?v=1a2b3c), so after an update browsers and proxies fetch the new
// files instead of running a cached old app.js against the new page (seen
// live: the 0.4.0 Month button did nothing until a hard refresh). The page
// itself is never cached, so it always carries the current hashes.
const PUBLIC = path.join(__dirname, '..', 'public');
const hashOf = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC, file))).digest('hex').slice(0, 12);
const indexHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
  .replace('href="style.css"', `href="style.css?v=${hashOf('style.css')}"`)
  .replace('src="app.js"', `src="app.js?v=${hashOf('app.js')}"`);
app.get(['/', '/index.html'], (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(indexHtml);
});

app.use(express.static(PUBLIC, { maxAge: 0, index: false }));

app.listen(PORT, () => {
  const how = cfg.open ? 'open editing: set up OIDC or ADMIN_PASSWORD to restrict'
    : [cfg.oidc && `OIDC sign-in${cfg.domains.length ? ' for ' + cfg.domains.join(', ') : ''}`, cfg.adminPassword && 'admin password'].filter(Boolean).join(' + ');
  console.log(`Team Tracker listening on :${PORT} (${how})`);
});
