# Team Tracker

A small self-hosted web app for seeing who on your team is around: work
hours, vacations, sick days and other time off, across time zones. Runs as
one Docker container with a SQLite file for storage.

- **Calendar**: a row per person, a column per day, grouped by department
  or group. Time off is colored by type; half days, specific hours and
  pending requests have their own look; each person's non-working days are
  shaded. Drag across days to add time off, click an entry to edit it.
- **Hours**: one day as a 24-hour timeline **in your time zone**, with each
  person's work hours converted from theirs, their time off, a "now" line
  and a coverage row showing how many people are working each half hour
  (plus the best overlap window).
- **Time zones**: everyone has a home zone. Their work hours and days off
  are stored in it (a day off in Paris is the Paris day); everything shown
  as a clock time is converted to the viewer's zone, which defaults to the
  browser's and can be changed in the top bar. Hovering a person shows
  their local time and their hours in yours; hovering time off shows when
  it starts and ends for you. DST is handled by the browser's own zone data.
- **Manage**: people (zone, department, groups, weekly hours, including
  night shifts that run past midnight), departments, groups and time-off
  types with their colors.

## Run it

```bash
docker compose up -d --build
```

Then open http://localhost:8080. On an empty install you can load a sample
team to look around and delete it later.

### Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `ADMIN_PASSWORD` | empty | When set, anyone can view but changes need the admin login. When empty, **anyone who can open the page can edit**: fine on a trusted network or behind an auth proxy, not on the open internet. |
| `SESSION_SECRET` | random per start | Signs the admin login cookie. Set it to keep logins across restarts. |
| `PORT` | `8080` | Port inside the container. |
| `DATA_DIR` | `/data` | Where `team-tracker.db` lives (a volume in the compose file). |

Put them in a `.env` next to `docker-compose.yml` (see `.env.example`).
Serve it behind HTTPS (Caddy, Traefik, nginx) if it's reachable from
outside; the login cookie is marked Secure when the proxy sends
`X-Forwarded-Proto: https`.

### Backups

All data is in one SQLite file in the volume. Copy it while running with:

```bash
docker compose exec team-tracker node -e "require('better-sqlite3')('/data/team-tracker.db').backup('/data/backup.db')"
```

## Run without Docker

Node 20 or newer:

```bash
npm install
npm start
```

## API

JSON over HTTP; write routes need the admin cookie when `ADMIN_PASSWORD` is set.

| Route | |
| --- | --- |
| `GET /api/data` | departments, groups, time-off types, people |
| `GET /api/time-off?from=YYYY-MM-DD&to=YYYY-MM-DD` | entries overlapping the range |
| `POST/PUT/DELETE /api/people[/:id]` | `name, email, department_id, timezone, schedule, group_ids, active` |
| `POST/PUT/DELETE /api/time-off[/:id]` | `person_id, type_id, start_date, end_date, part (full/am/pm/hours), start_time, end_time, status (approved/pending), note` |
| `POST/PUT/DELETE /api/departments`, `/api/groups`, `/api/leave-types` | `name` (and `color` for types) |
| `GET /api/session`, `POST /api/login`, `POST /api/logout` | admin login |
| `GET /healthz` | liveness |

`schedule` is `{ "0": [], "1": [["09:00","17:00"]], ... }` keyed by weekday
(0 = Sunday), times in the person's zone; an end at or before the start
runs past midnight.

## License

AGPL-3.0-only. Copyright (C) 2026 Spencer LeBlanc.
