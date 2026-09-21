# Korafi — Report. Track. Reward. Resolve.

Hausa-first customer support and service-incident platform that works on any phone, powered by [Africa's Talking](https://africastalking.com) USSD, SMS, Voice and Airtime.

Customers dial a USSD code, pick a problem and an area, and get an SMS ticket. Korafi clusters reports into **incidents** (same problem + same area + short window), lets the business broadcast one SMS update to everyone affected, then asks customers to confirm the fix and pays an **airtime reward**.

## Run it (60 seconds, no keys needed)

```bash
npm install
cp .env.example .env
npm start            # http://localhost:3000  (dashboard: /dashboard/, password from .env, default korafi-demo)
npm test
```

With no `AT_API_KEY`, Korafi runs in **dry-run**: all SMS/airtime are logged (status `simulated`) instead of sent, and an embedded Postgres (PGlite, stored in `./data`) is used. Use **Dashboard → Demo tools** to file reports and watch incidents form.

Production: `docker compose up -d` (Postgres included) or set `DATABASE_URL` yourself.

## Africa's Talking setup

1. Set `AT_USERNAME` and `AT_API_KEY` (`AT_USERNAME=sandbox` uses the sandbox host).
2. Expose the server (e.g. `ngrok http 3000`), set `PUBLIC_URL`, then in the AT dashboard set callbacks:

| Product | URL |
|---|---|
| USSD | `POST {PUBLIC_URL}/at/ussd` |
| SMS incoming | `POST {PUBLIC_URL}/at/sms` |
| SMS delivery reports | `POST {PUBLIC_URL}/at/sms/delivery` |
| Voice | `POST {PUBLIC_URL}/at/voice` |

Set `WEBHOOK_KEY` and append `?key=<value>` to each URL to reject unauthenticated callers.

Notes: Africa's Talking TTS has no Hausa voice — put MP3 prompts in `public/audio/ha/` (see the README there); otherwise Voice falls back to TTS. Airtime needs a funded AT wallet and NGN airtime enabled on your account.

## Configuration (one instance per customer)

See [.env.example](.env.example): `BUSINESS_NAME`, `USSD_CODE`, `SMS_SENDER_ID`, `DEFAULT_REWARD`, `SUPPORTED_AREAS`, `SUPPORTED_CATEGORIES`, `DEFAULT_LANGUAGE`, `INCIDENT_THRESHOLD`, `INCIDENT_WINDOW_MINUTES`, `AT_*`, `DATABASE_URL`, `DASHBOARD_PASSWORD`, `SESSION_SECRET`. Marketplace metadata: [marketplace/listing.json](marketplace/listing.json).

## How it works

- `src/routes/webhooks.js` — USSD, SMS, delivery reports, Voice (XML).
- `src/services/reports.js` — tickets, incident engine, broadcasts, resolution, rewards.
- `src/services/conversation.js` — channel-agnostic menus and replies (Hausa/English in `src/i18n.js`).
- `src/at.js` — Africa's Talking SMS + Airtime client.
- `public/` — landing page and live dashboard (SSE updates, Leaflet map).

Abuse controls: one open ticket per customer/problem/area per hour, one reward per ticket, daily reward cap per phone (`MAX_REWARDS_PER_PHONE_PER_DAY`). Report creation is serialised per process, so run a single replica per instance.
