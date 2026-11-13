# Team Tracker

A small self-hosted web app for seeing who on your team is around: work
hours, vacations, sick days and other time off, across time zones. Runs as
one Docker container with a SQLite file for storage.

- **Calendar**: a row per person, a column per day, grouped by department
  or group. Time off is colored by type; half days, specific hours and
  pending requests have their own look; each person's non-working days are
  shaded. Drag across days to add time off, click an entry to edit it.
  **Weeks** shows a rolling range; **Month** shows exactly one month.
- **Hours**: one day as a 24-hour timeline **in your time zone**, with each
  person's work hours converted from theirs, their time off, a "now" line
  and a coverage row showing how many people are working each half hour
  (plus the best overlap window). **Month** shows a person × day grid of
  working hours in your time with daily coverage; days that are an hour
  off because only one side has changed for daylight saving are in bold.
- **Time zones**: everyone has a home zone. Their work hours and days off
  are stored in it (a day off in Paris is the Paris day); everything shown
  as a clock time is converted to the viewer's zone, which defaults to the
  browser's and can be changed in the top bar. Hovering a person shows
  their local time and their hours in yours; hovering time off shows when
  it starts and ends for you. DST is handled by the browser's own zone data.
- **Manage**: people (zone, department, groups, weekly hours, including
  night shifts that run past midnight), departments, groups and time-off
  types with their colors.
- **Sign-in**: anyone can view without signing in. People sign in with
  their Matrix account (homeservers using Matrix Authentication Service,
  set up automatically) or your company's OIDC provider (Google Workspace,
  Microsoft Entra, Authentik, Keycloak...) limited to your email domains,
  and then edit their own profile and time off. Admins edit everything.

## Run it

```bash
docker compose up -d --build
```

Then open http://localhost:8080. On an empty install you can load a sample
team to look around and delete it later.

### Settings

Put them in a `.env` next to `docker-compose.yml` (start from `.env.example`).

| Variable | Default | What it does |
| --- | --- | --- |
| `PUBLIC_URL` | | The address people open, e.g. `https://team.example.com`. Required with sign-in. |
| `MATRIX_SERVER_NAME` | | Sign in with Matrix: the domain in your Matrix IDs, e.g. `https://example.com`. Use this **or** the `OIDC_*` settings. |
| `ADMIN_USER_IDS` | | Matrix IDs (`@you:example.com`) made admins when they sign in. Same as `ADMIN_EMAILS`, which accepts Matrix IDs too. |
| `OIDC_ISSUER` | | Your provider's issuer URL (see below). Setting it and `OIDC_CLIENT_ID` turns on sign-in. |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | | From the app registration at your provider. |
| `OIDC_LABEL` | `Sign in with SSO` | Text on the sign-in button. |
| `ALLOWED_EMAIL_DOMAINS` | | Comma-separated, e.g. `example.com,example.co.uk`. Only these can sign in. **Leave it set**: without it, anyone the provider accepts gets in. |
| `ADMIN_EMAILS` | | Comma-separated; these accounts are made admins when they sign in. Others can be promoted under Manage → Accounts. |
| `ADMIN_PASSWORD` | | Optional break-glass admin login, for first setup or when the provider is down. |
| `SESSION_SECRET` | random per start | Signs session cookies. Set it, or everyone is signed out on each restart. |
| `OIDC_REQUIRE_VERIFIED_EMAIL` | `true` | Set `false` only if your provider doesn't mark emails verified but owns them anyway (some Authentik/Keycloak setups). |
| `OIDC_SCOPES` | `openid email profile` | |
| `PORT` | `8080` | Port inside the container. |
| `DATA_DIR` | `/data` | Where `team-tracker.db` lives (a volume in the compose file). |

With neither OIDC nor `ADMIN_PASSWORD` set, **anyone who can open the page
can edit**: fine for a quick look on a trusted network, not otherwise.

Serve it behind HTTPS (Caddy, Traefik, nginx) when it's reachable from
outside. Cookies are marked Secure when `PUBLIC_URL` is https.

### Who can do what

| | Visitor | Member (signed in) | Admin |
| --- | --- | --- | --- |
| View calendar and hours | ✓ | ✓ | ✓ |
| See email addresses | | ✓ | ✓ |
| Edit own name, zone, hours, department, groups | | ✓ | ✓ |
| Add/edit/delete own time off | | ✓ | ✓ |
| Edit other people and their time off | | | ✓ |
| Departments, groups, time-off types, accounts | | | ✓ |

The first time someone signs in, they're linked to the person with the same
email (an admin can pre-fill emails), or a new person is created in their
browser's time zone with Mon–Fri 09:00–17:00 hours for them to adjust under
**My profile**. Admins can relink accounts under Manage → Accounts.

### Setting up sign-in

**Matrix (Matrix Authentication Service)**: if your homeserver uses MAS
(its `.well-known/matrix/client` has `org.matrix.msc2965.authentication`),
there's nothing to register by hand:

```
PUBLIC_URL=https://team.example.com
MATRIX_SERVER_NAME=https://example.com
ADMIN_USER_IDS=@you:example.com
```

On the first sign-in Team Tracker finds the login server from
`MATRIX_SERVER_NAME`, registers itself as a client there, and saves that
in `oauth_client.json` in the data volume (it registers again if
`PUBLIC_URL` changes; delete the file and restart to force it). It asks only
for `openid email`: it learns who you are and your email, gets no access to
your messages or rooms, and adds no device to your account. Anyone with an
account on the homeserver can sign in; set `ALLOWED_EMAIL_DOMAINS` as well
to also require an email address at those domains on the account. People
start with a name made from their user ID (`@jane.doe` → "Jane Doe"),
which they can change under My profile.

**Other OIDC providers**: register a web application with your provider,
with redirect URI `PUBLIC_URL/auth/callback`
(e.g. `https://team.example.com/auth/callback`).

**Google Workspace**: Google Cloud console → APIs & Services → OAuth consent
screen, user type **Internal** (only your Workspace can sign in), then
Credentials → Create OAuth client ID → Web application.

```
OIDC_ISSUER=https://accounts.google.com
OIDC_LABEL=Sign in with Google
ALLOWED_EMAIL_DOMAINS=yourcompany.com
```

**Microsoft Entra ID (Microsoft 365)**: Entra admin center → App
registrations → New registration, "Accounts in this organizational directory
only", platform Web with the redirect URI; then Certificates & secrets → New
client secret. Use your tenant ID in the issuer (not `common`): the app
then trusts the sign-in name (UPN) Entra gives, which only your tenant's
admins control.

```
OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
OIDC_LABEL=Sign in with Microsoft
ALLOWED_EMAIL_DOMAINS=yourcompany.com
```

**Authentik / Keycloak / others**: create an OIDC provider/client
(confidential, authorization code), and use its issuer URL (the one that
serves `/.well-known/openid-configuration`).

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

JSON over HTTP with the session cookie. Reads are public; writes follow the
table above (401 when signed out, 403 when not allowed).

| Route | |
| --- | --- |
| `GET /api/data` | departments, groups, time-off types, people (emails only when signed in) |
| `GET /api/time-off?from=YYYY-MM-DD&to=YYYY-MM-DD` | entries overlapping the range |
| `PUT /api/people/:id` | `name, email, department_id, timezone, schedule, group_ids, active` (members: own row, email and active ignored) |
| `POST/DELETE /api/people[/:id]` | admin |
| `POST/PUT/DELETE /api/time-off[/:id]` | `person_id, type_id, start_date, end_date, part (full/am/pm/hours), start_time, end_time, status (approved/pending), note` |
| `POST/PUT/DELETE /api/departments`, `/api/groups`, `/api/leave-types` | admin; `name` (and `color` for types) |
| `GET /api/users`, `PUT/DELETE /api/users/:id` | admin; `role (member/admin), person_id` |
| `GET /api/session` | who's signed in and which sign-in methods exist |
| `GET /auth/login?tz=Zone`, `GET /auth/callback` | OIDC sign-in |
| `POST /api/login`, `POST /api/logout` | admin password, sign out |
| `GET /healthz` | liveness |

`schedule` is `{ "0": [], "1": [["09:00","17:00"]], ... }` keyed by weekday
(0 = Sunday), times in the person's zone; an end at or before the start
runs past midnight.

## License

AGPL-3.0-only. Copyright (C) 2026 Spencer LeBlanc.
