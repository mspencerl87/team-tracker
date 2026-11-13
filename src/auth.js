// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Spencer LeBlanc

// Sign-in: OIDC for everyone (Google Workspace, Microsoft Entra, Authentik,
// Keycloak...), limited to the email domains in ALLOWED_EMAIL_DOMAINS, plus
// ADMIN_PASSWORD as a break-glass admin login. Viewing never needs either.

const crypto = require('crypto');
const { Issuer, generators } = require('openid-client');
const db = require('./db');

const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const cfg = {
  publicUrl: String(process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  issuer: process.env.OIDC_ISSUER || '',
  clientId: process.env.OIDC_CLIENT_ID || '',
  clientSecret: process.env.OIDC_CLIENT_SECRET || '',
  label: process.env.OIDC_LABEL || 'Sign in with SSO',
  scopes: process.env.OIDC_SCOPES || 'openid email profile',
  domains: list(process.env.ALLOWED_EMAIL_DOMAINS),
  adminEmails: list(process.env.ADMIN_EMAILS),
  // Some providers (Authentik, Keycloak) mark emails unverified unless told
  // otherwise; only turn this off when the provider itself owns the addresses.
  requireVerified: process.env.OIDC_REQUIRE_VERIFIED_EMAIL !== 'false',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  // A random secret per start logs everyone out on restart; set it to keep sessions.
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
};
cfg.oidc = Boolean(cfg.issuer && cfg.clientId);
// With no sign-in configured at all, anyone who can open the page can edit.
cfg.open = !cfg.oidc && !cfg.adminPassword;

if (cfg.oidc && !cfg.publicUrl) throw new Error('PUBLIC_URL is required with OIDC (the redirect URI is PUBLIC_URL/auth/callback).');
if (cfg.oidc && !cfg.domains.length) {
  // Without a domain list anyone the provider lets sign in gets an account;
  // with a public Google or Microsoft client that is anyone on the internet.
  console.warn('WARNING: ALLOWED_EMAIL_DOMAINS is empty: every account your OIDC provider accepts can sign in and edit.');
}

const SESSION = 'tt_session';
const FLOW = 'tt_oidc';
const SESSION_DAYS = 30;

// ---------- signed cookies ----------

function seal(obj) {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sig = crypto.createHmac('sha256', cfg.secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function unseal(raw) {
  if (!raw) return null;
  const [body, sig] = raw.split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', cfg.secret).update(body).digest('base64url');
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString());
    return obj.exp > Date.now() ? obj : null;
  } catch { return null; }
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function isSecure(req) {
  return cfg.publicUrl.startsWith('https://') || req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function setCookie(req, res, name, value, maxAgeSec) {
  const prev = res.getHeader('Set-Cookie');
  const line = `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isSecure(req) ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', [].concat(prev || [], line));
}

function startSession(req, res, data) {
  setCookie(req, res, SESSION, seal({ ...data, exp: Date.now() + SESSION_DAYS * 86400e3 }), SESSION_DAYS * 86400);
}

// ---------- who is asking ----------

// { user, admin }: user is the users row (null for the password admin or a
// visitor); admin covers open mode, the password login and admin accounts.
function auth(req) {
  if (req._auth) return req._auth;
  const s = unseal(readCookie(req, SESSION));
  let user = null;
  if (s?.u) user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.u) || null;
  const pwAdmin = Boolean(s?.pw && cfg.adminPassword);
  req._auth = { user, admin: cfg.open || pwAdmin || user?.role === 'admin', signedIn: Boolean(user || pwAdmin) };
  return req._auth;
}

const canEditPerson = (req, personId) => {
  const a = auth(req);
  return a.admin || (a.user?.person_id != null && a.user.person_id === Number(personId));
};

function requireAdmin(req, res, next) {
  if (auth(req).admin) return next();
  res.status(auth(req).signedIn ? 403 : 401).json({ error: auth(req).signedIn ? 'Only admins can do that.' : 'Sign in to make changes.' });
}

function requireSignedIn(req, res, next) {
  const a = auth(req);
  if (a.admin || a.user) return next();
  res.status(401).json({ error: 'Sign in to make changes.' });
}

// ---------- OIDC ----------

let clientPromise = null;
function oidcClient() {
  // Discovered on first use and retried after a failure, so a provider that
  // is briefly down at startup doesn't take the app down with it.
  if (!clientPromise) {
    clientPromise = Issuer.discover(cfg.issuer).then((issuer) => new issuer.Client({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret || undefined,
      token_endpoint_auth_method: cfg.clientSecret ? 'client_secret_basic' : 'none',
      redirect_uris: [`${cfg.publicUrl}/auth/callback`],
      response_types: ['code'],
    })).catch((err) => { clientPromise = null; throw err; });
  }
  return clientPromise;
}

// The address the domain check uses. A verified email claim if there is one;
// otherwise Microsoft Entra's preferred_username (the UPN its tenant admins
// own; Entra sends no email_verified), and only for that issuer.
function pickEmail(claims) {
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
  if (email && (claims.email_verified === true || claims.email_verified === 'true')) return email;
  if (/^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/.test(cfg.issuer)) {
    const upn = String(claims.preferred_username || '').toLowerCase();
    if (upn.includes('@')) return upn;
  }
  if (email && !cfg.requireVerified) return email;
  return null;
}

const domainOk = (email) => !cfg.domains.length || cfg.domains.includes(email.split('@').pop());

// Find or create the people row for a newly signed-in user: one with the same
// email that nobody has claimed yet, else a fresh one in their browser's zone.
function linkPerson(user, name, tz) {
  if (user.person_id) return;
  const match = db.prepare(`SELECT id FROM people WHERE lower(email) = ? AND id NOT IN
    (SELECT person_id FROM users WHERE person_id IS NOT NULL) ORDER BY id LIMIT 1`).get(user.email);
  let personId = match?.id;
  if (!personId) {
    const schedule = JSON.stringify({ 0: [], 1: [['09:00', '17:00']], 2: [['09:00', '17:00']], 3: [['09:00', '17:00']], 4: [['09:00', '17:00']], 5: [['09:00', '17:00']], 6: [] });
    personId = db.prepare('INSERT INTO people (name, email, timezone, schedule) VALUES (?, ?, ?, ?)')
      .run(name || user.email.split('@')[0], user.email, tz, schedule).lastInsertRowid;
  }
  db.prepare('UPDATE users SET person_id = ? WHERE id = ?').run(personId, user.id);
}

function validTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function loginPage(res, status, message) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  res.status(status).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Team Tracker</title><body style="font:15px system-ui,sans-serif;background:#f3f5fc;color:#1f2337;display:grid;place-items:center;min-height:90vh;margin:0 16px">
<div style="background:#fff;border:1px solid #d6dcef;border-radius:12px;padding:24px 28px;max-width:420px"><h2 style="margin-top:0">Couldn't sign you in</h2>
<p>${esc(message)}</p><p><a href="/" style="color:#5b4fd6">Back to Team Tracker</a></p></div></body>`);
}

function routes(app) {
  app.get('/api/session', (req, res) => {
    const a = auth(req);
    res.json({
      me: a.user ? { id: a.user.id, email: a.user.email, name: a.user.name, role: a.user.role, person_id: a.user.person_id } : null,
      isAdmin: a.admin,
      signedIn: a.signedIn,
      open: cfg.open,
      oidc: cfg.oidc ? cfg.label : null,
      password: Boolean(cfg.adminPassword),
    });
  });

  app.post('/api/login', (req, res) => {
    const given = crypto.createHash('sha256').update(String(req.body?.password || '')).digest();
    const want = crypto.createHash('sha256').update(cfg.adminPassword).digest();
    if (!cfg.adminPassword || !crypto.timingSafeEqual(given, want)) return res.status(401).json({ error: 'Wrong password.' });
    startSession(req, res, { pw: 1 });
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    setCookie(req, res, SESSION, '', 0);
    res.json({ ok: true });
  });

  app.get('/auth/login', async (req, res) => {
    if (!cfg.oidc) return loginPage(res, 404, 'Single sign-on is not set up on this server.');
    try {
      const client = await oidcClient();
      const verifier = generators.codeVerifier();
      const flow = {
        state: generators.state(),
        nonce: generators.nonce(),
        verifier,
        tz: validTz(String(req.query.tz || '')) ? String(req.query.tz) : 'UTC',
        exp: Date.now() + 10 * 60e3,
      };
      setCookie(req, res, FLOW, seal(flow), 600);
      res.redirect(client.authorizationUrl({
        scope: cfg.scopes,
        state: flow.state,
        nonce: flow.nonce,
        code_challenge: generators.codeChallenge(verifier),
        code_challenge_method: 'S256',
        // Google: preselects (but doesn't enforce) a Workspace domain; the
        // email check below is what enforces it.
        ...(cfg.domains.length === 1 && /accounts\.google\.com/.test(cfg.issuer) ? { hd: cfg.domains[0] } : {}),
      }));
    } catch (err) {
      console.error('OIDC login:', err.message);
      loginPage(res, 502, 'The sign-in provider could not be reached. Try again in a minute.');
    }
  });

  app.get('/auth/callback', async (req, res) => {
    const flow = unseal(readCookie(req, FLOW));
    setCookie(req, res, FLOW, '', 0);
    if (!flow) return loginPage(res, 400, 'The sign-in took too long or was started in another browser. Please try again.');
    let claims;
    try {
      const client = await oidcClient();
      const params = client.callbackParams(req);
      const tokens = await client.callback(`${cfg.publicUrl}/auth/callback`, params, { state: flow.state, nonce: flow.nonce, code_verifier: flow.verifier });
      claims = tokens.claims();
      // Some providers put email only in userinfo.
      if (!claims.email && tokens.access_token) {
        try { claims = { ...(await client.userinfo(tokens.access_token)), ...claims }; } catch { /* id token is enough if it has what we need */ }
      }
    } catch (err) {
      console.error('OIDC callback:', err.message);
      return loginPage(res, 400, `Sign-in failed: ${err.message}`);
    }
    const email = pickEmail(claims);
    if (!email) return loginPage(res, 403, 'Your account did not give us a verified email address.');
    if (!domainOk(email)) return loginPage(res, 403, `${email} is not allowed here. Sign in with an address at ${cfg.domains.join(' or ')}.`);

    const name = String(claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || '').slice(0, 120) || null;
    const user = db.transaction(() => {
      let u = db.prepare('SELECT * FROM users WHERE issuer = ? AND sub = ?').get(claims.iss, String(claims.sub));
      if (u) {
        db.prepare("UPDATE users SET email = ?, name = COALESCE(?, name), last_login = datetime('now') WHERE id = ?").run(email, name, u.id);
      } else {
        const role = cfg.adminEmails.includes(email) ? 'admin' : 'member';
        const id = db.prepare("INSERT INTO users (issuer, sub, email, name, role, last_login) VALUES (?, ?, ?, ?, ?, datetime('now'))")
          .run(claims.iss, String(claims.sub), email, name, role).lastInsertRowid;
        u = { id, email, person_id: null };
      }
      // ADMIN_EMAILS promotes on every sign-in, so adding someone there works
      // for existing accounts too. Removing them is done in Manage > Users.
      if (cfg.adminEmails.includes(email)) db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(u.id);
      linkPerson(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id), name, flow.tz);
      return db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
    })();
    startSession(req, res, { u: user.id });
    res.redirect('/');
  });
}

module.exports = { cfg, auth, canEditPerson, requireAdmin, requireSignedIn, routes };
