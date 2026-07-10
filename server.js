const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 4100;
const ADMIN_KEY = process.env.ADMIN_KEY;
const TOKEN_SECRET = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
const DB_PATH = path.join(__dirname, 'codes.json');
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DURATION_DAYS = 30;
const MAX_DURATION_DAYS = 3650; // 10 years — generous ceiling, just guards against a typo'd huge number

if (!ADMIN_KEY) {
  console.warn('[WARN] ADMIN_KEY is not set — /admin/* routes will refuse all requests until you set it.');
}
if (!process.env.TOKEN_SECRET) {
  console.warn('[WARN] TOKEN_SECRET is not set — using a random one for this process only. Restarts will invalidate every existing token.');
}

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

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
function generateCode() {
  const group = () => Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  return `-${group()}-${group()}-${group()}`;
}

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

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.post('/admin/generate', requireAdmin, (req, res) => {
  const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 1, 1), 200);
  // Per-batch validity window in days (e.g. 7 for a trial code, 365 for a
  // yearly code). Stored per-code so a later batch with a different
  // duration doesn't affect codes already generated. Falls back to 30 if
  // omitted or invalid.
  const durationDays = Math.min(Math.max(parseInt(req.body?.days, 10) || DEFAULT_DURATION_DAYS, 1), MAX_DURATION_DAYS);
  const db = loadDb();
  const codes = [];
  for (let i = 0; i < count; i++) {
    let code;
    do { code = generateCode(); } while (db[code]);
    db[code] = {
      hardwareId: null,
      activatedAt: null,
      expiresAt: null,
      durationDays,
      revoked: false,
      createdAt: Date.now()
    };
    codes.push(code);
  }
  saveDb(db);
  res.json({ codes, durationDays });
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
    durationDays: entry.durationDays || DEFAULT_DURATION_DAYS,
    hardwareId: entry.hardwareId ? entry.hardwareId.slice(0, 8) + '…' : null
  }));
  res.json({ total: summary.length, codes: summary });
});

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
    entry.hardwareId = hardwareId;
    entry.activatedAt = now;
    // durationDays is set at generation time (see /admin/generate). Codes
    // created before this field existed fall back to the original 30-day
    // behavior.
    entry.expiresAt = now + (entry.durationDays || DEFAULT_DURATION_DAYS) * ONE_DAY_MS;
    saveDb(db);
  } else if (entry.hardwareId !== hardwareId) {
    return res.status(409).json({ error: 'device_mismatch' });
  }

  if (entry.expiresAt <= now) return res.status(410).json({ error: 'expired' });

  const token = signToken({ code, hardwareId, expiresAt: entry.expiresAt, issuedAt: now });
  res.json({ token, expiresAt: entry.expiresAt });
});

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
