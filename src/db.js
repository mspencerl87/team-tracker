// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Spencer LeBlanc

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'team-tracker.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Each migration runs once, in order; user_version records how far we got.
// Append new entries, never edit old ones (existing databases already ran them).
const MIGRATIONS = [
  `
  CREATE TABLE departments (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );
  CREATE TABLE groups (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );
  -- schedule: JSON object keyed by weekday (0 = Sunday .. 6 = Saturday), each a
  -- list of ["HH:MM","HH:MM"] spans in the person's own time zone. An end at or
  -- before the start runs past midnight (night shifts).
  CREATE TABLE people (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    schedule TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE person_groups (
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (person_id, group_id)
  );
  CREATE TABLE leave_types (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0
  );
  -- Dates are calendar dates in the person's own time zone (a day off in Paris
  -- is the Paris day). part: full | am | pm | hours; for "hours", start_time and
  -- end_time are wall-clock times in the person's zone on every day of the range.
  CREATE TABLE time_off (
    id INTEGER PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    type_id INTEGER NOT NULL REFERENCES leave_types(id),
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    part TEXT NOT NULL DEFAULT 'full',
    start_time TEXT,
    end_time TEXT,
    status TEXT NOT NULL DEFAULT 'approved',
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX time_off_range ON time_off(end_date, start_date);
  INSERT INTO leave_types (name, color, sort) VALUES
    ('Vacation', '#16a34a', 1),
    ('Sick', '#f87171', 2),
    ('Remote / Travel', '#2dd4bf', 3),
    ('Public holiday', '#94a3b8', 4),
    ('Training', '#a78bfa', 5),
    ('Other', '#f59e0b', 6);
  `,
  // Accounts from OIDC sign-in. (issuer, sub) is the identity; email is what
  // the domain check and person linking use. A member edits only person_id.
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    issuer TEXT NOT NULL,
    sub TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'member',
    person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login TEXT,
    UNIQUE (issuer, sub)
  );
  CREATE UNIQUE INDEX users_person ON users(person_id) WHERE person_id IS NOT NULL;
  `,
];

function migrate() {
  const current = db.pragma('user_version', { simple: true });
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}
migrate();

module.exports = db;
