# GHL Session Login & Capture - TJB Digital

Logs into `app.tjbdigitalservices.com` with email + password + a TOTP 2FA secret, then captures the
full browser session (`storageState`: cookies + localStorage) so the **appointment-booking-actor** can
reuse it — replacing the manual, headed `loginMode` login that currently has to be redone every ~30 days.

```
┌──────────────────┐   storageState   ┌──────────────────────────┐
│ session-login    │ ───────────────▶ │ appointment-booking      │
│ (email+pass+TOTP)│   (JSON object)  │ (uses storageState input)│
└──────────────────┘                  └──────────────────────────┘
        ▲                                         ▲
        └──────────────── n8n orchestration ──────┘
```

## Setup

```bash
cd session-login-actor
npm install
npx playwright install chromium   # local runs only
```

## Input

| Field        | Type    | Required | Description                                                             |
|--------------|---------|----------|-------------------------------------------------------------------------|
| email        | string  | yes      | Login email                                                             |
| password     | string  | yes      | Login password (stored encrypted on Apify)                              |
| encryptedKey | string  | yes      | TOTP 2FA secret — base32 (`JBSWY3DP...`) or an `otpauth://` URI (encrypted) |
| loginUrl     | string  | no       | Defaults to `https://app.tjbdigitalservices.com`                        |
| headless     | boolean | no       | `false` to watch the browser locally (or env `HEADLESS=false`)          |

## Output

Pushed to the dataset **and** saved to the key-value store under the key `SESSION`.

```json
{
  "success": true,
  "finalUrl": "https://app.tjbdigitalservices.com/v2/location/.../dashboard",
  "cookieCount": 23,
  "storageState": { "cookies": [ ... ], "origins": [ ... ] },
  "sessionUrl": "https://api.apify.com/v2/key-value-stores/STORE_ID/records/SESSION",
  "capturedAt": "2026-10-28T12:00:00.000Z",
  "error": null
}
```

`storageState` is exactly the object the appointment actor takes as its `storageState` input — pass it
through verbatim. In n8n you can either read the run's dataset item or `GET` the `sessionUrl`.

## Run locally (watch the browser)

```bash
# Put input in the local key-value store
mkdir -p storage/key_value_stores/default
cat > storage/key_value_stores/default/INPUT.json <<'JSON'
{
  "email": "you@example.com",
  "password": "...",
  "encryptedKey": "YOUR_TOTP_SECRET",
  "headless": false
}
JSON

HEADLESS=false npx tsx src/main.ts
```

The captured session lands in `storage/key_value_stores/default/SESSION.json`. Debug screenshots for each
step (`step-1-login-page`, `step-2-after-signin`, `step-3-2fa-screen`, and any `error-*`) land in the same
folder — useful for fixing selectors if the TJB/GHL login markup differs from the defaults.

## Run on cloud (API call)

```json
{
  "email": "you@example.com",
  "password": "...",
  "encryptedKey": "YOUR_TOTP_SECRET"
}
```

## Deploy

```bash
APIFY_TOKEN=your_token apify push --force
apify builds add-tag -b BUILD_ID -t latest
```

## How it works

1. Opens the login page; if already on a dashboard, skips straight to capture.
2. Fills email + password (tries several selector variants), clicks **Sign in**.
3. If a 2FA screen appears, selects the **authenticator / TOTP** method (if a chooser is shown).
4. Generates a TOTP code from `encryptedKey` with `otplib`, waiting for the next 30s window if the
   current code is about to expire, then enters it (single field or per-digit boxes) and submits.
   Rejected codes are retried up to 3× with a freshly generated code.
5. Waits for the dashboard (`#globalSearchOpener` or a `/dashboard`, `/v2/location`, `/agency_dashboard` URL).
6. Captures `context.storageState()` and writes it to the dataset and KVS key `SESSION`.

## Config

- **RAM:** 2048MB
- **Timeout:** 600s

## Notes

- Selectors are intentionally defensive (multiple candidates per field) because the exact TJB/GHL login
  markup is confirmed by the first real test run — check the `step-*` screenshots and adjust the selector
  lists at the top of [src/main.ts](src/main.ts) if any step cannot find its element.
- The session captured here is the same shape `appointment-booking-actor` already consumes, so no change is
  needed on that side.
