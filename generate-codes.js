// =========================================================================
// Code generator CLI — run this on YOUR machine whenever someone buys the
// game, then hand them the printed code.
//
// Usage:
//   set LICENSE_SERVER_URL=https://your-server.example.com   (Windows)
//   set LICENSE_ADMIN_KEY=the-same-ADMIN_KEY-you-set-on-the-server
//   node generate-codes.js 5        <- generates 5 codes
//
// (macOS/Linux: use `export` instead of `set`)
// =========================================================================

const http = require('http');
const https = require('https');

const SERVER = process.env.LICENSE_SERVER_URL || 'http://localhost:4100';
const ADMIN_KEY = process.env.LICENSE_ADMIN_KEY;
const count = parseInt(process.argv[2] || '1', 10);

if (!ADMIN_KEY) {
  console.error('Set LICENSE_ADMIN_KEY first (must match ADMIN_KEY on the server).');
  process.exit(1);
}

let url;
try {
  url = new URL('/admin/generate', SERVER);
} catch (e) {
  console.error('Invalid LICENSE_SERVER_URL:', SERVER);
  process.exit(1);
}

const lib = url.protocol === 'https:' ? https : http;
const body = JSON.stringify({ count });

const req = lib.request(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-admin-key': ADMIN_KEY,
    'Content-Length': Buffer.byteLength(body)
  }
}, (res) => {
  let data = '';
  res.on('data', (c) => (data += c));
  res.on('end', () => {
    if (res.statusCode !== 200) {
      console.error(`Failed (${res.statusCode}):`, data);
      process.exit(1);
    }
    const parsed = JSON.parse(data);
    console.log(`\nGenerated ${parsed.codes.length} code(s):\n`);
    parsed.codes.forEach((c) => console.log('  ' + c));
    console.log('');
  });
});

req.on('error', (e) => {
  console.error('Request failed:', e.message);
  process.exit(1);
});
req.write(body);
req.end();
