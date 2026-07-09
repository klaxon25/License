// =========================================================================
// TANK WARS — LICENSE SERVER
// -------------------------------------------------------------------------
// Small, self-contained activation server. One code = one machine, 30-day
// validity from first activation, revocable by you at any time. Storage is
// a single JSON file (codes.json) next to this script — plenty for an
// indie-scale number of activations; swap for a real DB later if needed.
//
// ENDPOINTS
//   POST /admin/generate   { count }         header: x-admin-key   -> { codes: [...] }
//   POST /admin/revoke     { code }          header: x-admin-key   -> { ok: true }
//   GET  /admin/status                       header: x-admin-key   -> summary of all codes
//   POST /activate         { code, hardwareId }                    -> { token, expiresAt }
//   POST /heartbeat        { token }                                -> { token, expiresAt }
//
// RUN LOCALLY
//   cd license-server
//   npm install
//   set ADMIN_KEY=some-long-random-string   (Windows: use `set`, macOS/Linux: `export`)
//   npm start
//
// DEPLOY (pick one — any Node host works, this needs no database):
//   - Render.com: New "Web Service" -> point at this folder -> build
//     command `npm install` -> start command `npm start` -> add an
//     environment variable ADMIN_KEY with your own secret. Free tier is
//     fine to start.
//   - Railway.app / Fly.io: same idea, just set ADMIN_KEY as an env var.
//   - Your own VPS: `pm2 start server.js` behind nginx, or run in a
//     screen/tmux session. Make sure port matches your reverse proxy.
//
// After deploying, put the public HTTPS URL into
// src/license-config.js -> LICENSE_SERVER_URL in the Electron app.
// =========================================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 4100;
const ADMIN_KEY = process.env.ADMIN_KEY;
// Signs activation tokens. MUST be set to your own long random value in
// production — if you don't set TOKEN_SECRET, one is generated at boot,
// which means every restart invalidates all existing tokens (fine for
// local testing, NOT fine for a real deploy).
const TOKEN_SECRET = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
const DB_PATH = path.join(__dirname, 'codes.json');
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

if (!ADMIN_KEY) {
  console.warn('[WARN] ADMIN_KEY is not set — /admin/* routes will refuse all requests until you set it.');
}
if (!process.env.TOKEN_SECRET) {
  console.warn('[WARN] TOKEN_SECRET is not set — using a random one for this process only. Set it as an env var so restarts do not invalidate everyone\'s activation.');
}

// --- tiny JSON "database" -------------------------------------------------
function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  } catch {
    return {};
  }
}
function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// --- code format: TANK-XXXX-XXXX-XXXX, no ambiguous chars ---------------
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
function generateCode() {
  const group = () => Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  return `TANK-${group()}-${group()}-${group()}`;
}

// --- token signing (mini HMAC-signed token, not JWT, no extra deps) -----
function signToken(payload) {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payloadB64).digest('hex');
  return `${payloadB64}.${sig}`;
}
function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payloadB64).digest('hex');
  const sigBuf = Buffer.from(sig || '', 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY || req.get('x-admin-key') !== ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

const app = express();
app.use(express.json());

// ---------------------------------------------------------------- admin --
app.post('/admin/generate', requireAdmin, (req, res) => {
  const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 1, 1), 200);
  const db = loadDb();
  const codes = [];
  for (let i = 0; i < count; i++) {
    let code;
    do { code = generateCode(); } while (db[code]); // avoid collisions
    db[code] = {
      hardwareId: null,
      activatedAt: null,
      expiresAt: null,
      revoked: false,
      createdAt: Date.now()
    };
    codes.push(code);
  }
  saveDb(db);
  res.json({ codes });
});

app.post('/admin/revoke', requireAdmin, (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  const db = loadDb();
  if (!db[code]) return res.status(404).json({ error: 'not_found' });
  db[code].revoked = true;
  saveDb(db);
  res.json({ ok: true });
});

app.get('/admin/status', requireAdmin, (req, res) => {
  const db = loadDb();
  const summary = Object.entries(db).map(([code, entry]) => ({
    code,
    status: entry.revoked ? 'revoked' : !entry.hardwareId ? 'unused' : (entry.expiresAt <= Date.now() ? 'expired' : 'active'),
    activatedAt: entry.activatedAt,
    expiresAt: entry.expiresAt,
    hardwareId: entry.hardwareId ? entry.hardwareId.slice(0, 8) + '…' : null
  }));
  res.json({ total: summary.length, codes: summary });
});

// ------------------------------------------------------------- activate --
app.post('/activate', (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  const hardwareId = String(req.body?.hardwareId || '').trim();
  if (!code || !hardwareId) return res.status(400).json({ error: 'missing_fields' });

  const db = loadDb();
  const entry = db[code];
  if (!entry) return res.status(404).json({ error: 'invalid_code' });
  if (entry.revoked) return res.status(403).json({ error: 'revoked' });

  const now = Date.now();

  if (!entry.hardwareId) {
    // First activation — bind to this machine and start the 30-day clock.
    entry.hardwareId = hardwareId;
    entry.activatedAt = now;
    entry.expiresAt = now + THIRTY_DAYS_MS;
    saveDb(db);
  } else if (entry.hardwareId !== hardwareId) {
    // Already bound to a different machine — one code, one PC.
    return res.status(409).json({ error: 'device_mismatch' });
  }
  // else: same machine re-activating (reinstall) — fall through, don't
  // touch activatedAt/expiresAt.

  if (entry.expiresAt <= now) return res.status(410).json({ error: 'expired' });

  const token = signToken({ code, hardwareId, expiresAt: entry.expiresAt, issuedAt: now });
  res.json({ token, expiresAt: entry.expiresAt });
});

// ------------------------------------------------------------- heartbeat --
app.post('/heartbeat', (req, res) => {
  const payload = verifyToken(req.body?.token);
  if (!payload) return res.status(401).json({ error: 'invalid_token' });

  const db = loadDb();
  const entry = db[payload.code];
  if (!entry) return res.status(401).json({ error: 'invalid_code' });
  if (entry.revoked) return res.status(403).json({ error: 'revoked' });
  if (entry.hardwareId !== payload.hardwareId) return res.status(409).json({ error: 'device_mismatch' });
  if (entry.expiresAt <= Date.now()) return res.status(410).json({ error: 'expired' });

  const token = signToken({ code: payload.code, hardwareId: payload.hardwareId, expiresAt: entry.expiresAt, issuedAt: Date.now() });
  res.json({ token, expiresAt: entry.expiresAt });
});

app.get('/', (req, res) => res.send('Tank Wars license server is running.'));

app.listen(PORT, () => console.log(`[license-server] listening on port ${PORT}`));
