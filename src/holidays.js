// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Spencer LeBlanc

// Public holidays from the date-holidays package (offline data, no service
// called). A person's holiday key is a country ("FR") or country-state
// ("US-CA", "DE-BY"); a NULL setting means "from their time zone".

const Holidays = require('date-holidays');

const COUNTRIES = new Holidays().getCountries('en');

// Time zone -> country. Many zones are listed by several countries (seen:
// Africa/Lagos came out as Angola on a first-come basis), so a country that
// lists the zone as its main (first) one wins over one that only shares it.
const zoneCountry = new Map();
{
  const later = [];
  for (const code of Object.keys(COUNTRIES)) {
    const zones = new Holidays(code).getTimezones() || [];
    zones.forEach((z, i) => (i === 0 ? (zoneCountry.has(z) || zoneCountry.set(z, code)) : later.push([z, code])));
  }
  for (const [z, code] of later) if (!zoneCountry.has(z)) zoneCountry.set(z, code);
  // Zones that are the only zone of several countries (Africa/Lagos is
  // Nigeria's and nine neighbours'): use the country of the city they're named after.
  const CITY = {
    'Africa/Lagos': 'NG', 'Africa/Abidjan': 'CI', 'Africa/Maputo': 'MZ', 'Africa/Nairobi': 'KE',
    'Africa/Johannesburg': 'ZA', 'America/Port_of_Spain': 'TT', 'America/Curacao': 'CW',
    'America/Panama': 'PA', 'Europe/Helsinki': 'FI', 'Europe/Belgrade': 'RS', 'Europe/Zurich': 'CH',
    'Europe/Rome': 'IT', 'Europe/Oslo': 'NO',
  };
  for (const [z, code] of Object.entries(CITY)) if (COUNTRIES[code]) zoneCountry.set(z, code);
}

const KEY_RE = /^([A-Z]{2})(?:-([A-Z0-9]{1,6}))?$/;

function validKey(key) {
  const m = KEY_RE.exec(key);
  if (!m || !COUNTRIES[m[1]]) return false;
  return !m[2] || Boolean(new Holidays(m[1]).getStates(m[1], 'en')?.[m[2]]);
}

// The key actually used: the person's setting, '' for none, or their zone's country.
const effectiveKey = (setting, timezone) => (setting === null || setting === undefined ? zoneCountry.get(timezone) || '' : setting);

const cache = new Map();
// Public holidays (type "public" only: not observances such as Valentine's
// Day, nor "optional" ones like Christmas Eve in the US) for one key and year.
function forYear(key, year) {
  const ck = `${key}/${year}`;
  if (!cache.has(ck)) {
    const [country, state] = key.split('-');
    const out = [];
    for (const h of new Holidays(country, state).getHolidays(year, 'en') || []) {
      if (h.type !== 'public') continue;
      // A few last several days; list each day (dates are local to the country).
      const first = h.date.slice(0, 10);
      const days = Math.max(1, Math.round((h.end - h.start) / 86400e3));
      for (let i = 0; i < days; i++) {
        const d = new Date(Date.parse(first + 'T00:00:00Z') + i * 86400e3).toISOString().slice(0, 10);
        out.push({ date: d, name: h.name });
      }
    }
    cache.set(ck, out);
  }
  return cache.get(ck);
}

function between(key, from, to) {
  const out = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
    for (const h of forYear(key, y)) if (h.date >= from && h.date <= to) out.push(h);
  }
  return out;
}

const countries = () => COUNTRIES;
const regions = (country) => (COUNTRIES[country] ? new Holidays(country).getStates(country, 'en') || {} : {});

module.exports = { effectiveKey, validKey, between, countries, regions, zoneCountry };
