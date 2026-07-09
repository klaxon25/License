# Tank Wars License Server

Handles activation codes: one code activates on exactly one PC, valid for 30
days from first activation, checked periodically ("heartbeat") while the
game runs.

## How it fits together

```
You sell the game
      │
      ▼
node generate-codes.js 1        ──► prints a code like TANK-XK4M-7QRT-2VWZ
      │                                you send this to the buyer
      ▼
Buyer opens the game
      │
      ▼
Activation screen (before the homepage) asks for the code
      │
      ▼
Game calls POST /activate ──► server binds the code to that PC's
                               hardware ID + starts the 30-day clock
      │
      ▼
Game plays normally. Every ~20 min it silently calls POST /heartbeat
to confirm the code is still valid, not expired, not revoked, and still
on the same PC. If the server says no, it's kicked back to the
activation screen.
```

## Local test run

```
cd license-server
npm install
set ADMIN_KEY=test123
set TOKEN_SECRET=testsecret
npm start
```

Then in another terminal:
```
set LICENSE_SERVER_URL=http://localhost:4100
set LICENSE_ADMIN_KEY=test123
node generate-codes.js 3
```

## Deploying so real buyers can activate

You need this running somewhere reachable over the internet — your own PC
running 24/7 behind a router is NOT reliable enough (buyers activating
while you're offline will fail). Easiest options, cheapest first:

1. **Render.com** (free tier works fine for this traffic level)
   - New → Web Service → connect this `license-server` folder (or upload it)
   - Build command: `npm install`
   - Start command: `npm start`
   - Add environment variables `ADMIN_KEY` and `TOKEN_SECRET` (long random
     strings — e.g. generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
   - Render gives you a public `https://something.onrender.com` URL — that's
     your `LICENSE_SERVER_URL`.
   - Free tier note: the service sleeps after inactivity and takes a few
     seconds to wake on the first request — fine for activation, and the
     client's heartbeat already tolerates a slow/failed check gracefully.

2. **Railway.app / Fly.io** — same idea, set the two env vars, get a URL.

3. **Your own VPS** — `pm2 start server.js`, put nginx + a free Let's
   Encrypt cert in front of it for HTTPS, point a subdomain at it.

Once deployed, put the URL into `src/license-config.js` in the main app:
```js
LICENSE_SERVER_URL: 'https://your-actual-url.onrender.com',
```

## Generating codes for sales

Every time someone buys:
```
set LICENSE_SERVER_URL=https://your-actual-url.onrender.com
set LICENSE_ADMIN_KEY=<your ADMIN_KEY>
node generate-codes.js 1
```
Send them the printed code.

## Revoking a code (refunds, chargebacks, leaked codes)

```
curl -X POST https://your-actual-url.onrender.com/admin/revoke ^
  -H "Content-Type: application/json" ^
  -H "x-admin-key: <your ADMIN_KEY>" ^
  -d "{\"code\":\"TANK-XK4M-7QRT-2VWZ\"}"
```
The next heartbeat (within ~20 min) will kick that install back to the
activation screen.

## Checking what's out there

```
curl https://your-actual-url.onrender.com/admin/status -H "x-admin-key: <your ADMIN_KEY>"
```

## Honest limits of this approach

This stops casual sharing effectively: a code only works on one PC, and a
revoked/expired code gets caught within one heartbeat cycle even if the
person never restarts the app. It will NOT stop someone who is willing to
decompile/patch the Electron app's JS to skip the check entirely — no
client-side license check can fully prevent that, for any game, on any
engine. The obfuscation step (see main project notes) raises the effort
bar for casual tampering but isn't unbeatable. The server-side revoke is
your real lever if a code gets shared.
