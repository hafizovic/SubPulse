# SubPulse

See how active the YouTube channels you're subscribed to are:

- days since the last upload
- how often each channel posts
- Shorts vs. regular videos
- average video length

It's a Node.js server with a SQLite database and a plain HTML/JS frontend. There are **no npm dependencies** and no build step: Node ≥ 22.13 has SQLite built in (`node:sqlite`).

---

## Developer setup

### Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js ≥ 22.13** | Needed for the built-in `node:sqlite` module. Check with `node --version`. |
| **A Google account** | Used to create the OAuth client and to sign in to the app. |
| **A Google Cloud project** | Free. Created in step 3 below. |

No database server, Docker or `npm install` is needed.

If your Node is older, install a current version, for example with [nvm](https://github.com/nvm-sh/nvm):

```bash
nvm install 22
```

```bash
nvm use 22
```

### 1. Get the code

Clone or copy the project to your machine and open a terminal in the project folder:

```bash
cd path/to/subpulse
```

### 2. Create your `.env`

```bash
cp .env.example .env
```

`.env` is git-ignored. You'll fill in the two Google values in the next step.

### 3. Google Cloud setup (one time per developer)

Each developer needs their own OAuth client (or must be added as a test user on a shared one).

1. Open <https://console.cloud.google.com/> and create a project.
2. **APIs & Services → Library** → enable **YouTube Data API v3**. That's the only API needed.
3. **OAuth consent screen** (called "Google Auth Platform" in newer consoles):
   - User type **External**, publishing status **Testing**
   - Fill in the app name and the support/developer emails
   - Scopes: `https://www.googleapis.com/auth/youtube.readonly`, plus `https://www.googleapis.com/auth/youtube` if you want to unsubscribe from inside the app
   - **Audience → Test users**: add every Google account that will sign in
4. **Credentials → Create credentials → OAuth client ID**:
   - Application type **Web application** (not Desktop)
   - Authorized **redirect URI**: `http://localhost:5173/auth/callback`
     (if you change `PORT` or `BASE_URL`, the redirect URI must be `<BASE_URL>/auth/callback`)
5. Copy the **Client ID** and **Client secret** into `.env`:

   ```
   GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=xxxxxxxx
   ```

### 4. Run it

```bash
npm start
```

This runs `node server/index.js`. Then open <http://localhost:5173>, click **Sign in with Google**, then **Sync**.

On first start the server creates `data/` with:

- `subpulse.db` — the SQLite database (schema is created and migrated automatically)
- `encryption.key` — a random key that encrypts stored Google refresh tokens

There is no file watcher: restart the server after changing files in `server/`. Changes in `public/` only need a browser reload.

### 5. Check that it works

- The terminal prints `SubPulse running at http://localhost:5173` and **no** `⚠ GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing` warning.
- The browser shows the **Sign in with Google** button, not the setup screen.
- After sign-in and **Sync**, the table fills with your subscriptions. A full sync of ~300 subscriptions uses roughly 900 of the 10,000 daily API units.

### Configuration reference (`.env`)

Real environment variables take precedence over `.env`.

| Variable | Default | Purpose |
|---|---|---|
| `GOOGLE_CLIENT_ID` | — (required) | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | — (required) | OAuth client secret |
| `PORT` | `5173` | HTTP port (server binds to `localhost` only) |
| `BASE_URL` | `http://localhost:<PORT>` | Public URL; used for the OAuth redirect. `https://…` turns on secure cookies |
| `DATA_DIR` | `data` | Folder for the database and encryption key |
| `DATABASE_PATH` | `<DATA_DIR>/subpulse.db` | SQLite file location |
| `CHANNEL_TTL_HOURS` | `6` | Reuse channel stats synced by anyone within this window |
| `YOUTUBE_DAILY_QUOTA` | `10000` | Stop syncing once this many API units were used today |
| `ENCRYPTION_KEY` | auto-generated | 32 bytes, base64. Generate with `openssl rand -base64 32` |

### Resetting local data

Stop the server and delete the `data/` folder. Everything is recreated on the next start; you'll need to sign in and sync again. Deleting only `encryption.key` forces everyone to sign in again.

### Troubleshooting

| Problem | Fix |
|---|---|
| `Cannot find module 'node:sqlite'` / `No such built-in module` | Node is too old. Upgrade to ≥ 22.13. |
| `ExperimentalWarning: SQLite is an experimental feature` | Harmless on some Node versions. |
| Browser shows the setup screen | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are empty in `.env`. Fill them in and restart. |
| Google: `redirect_uri_mismatch` | The redirect URI in Cloud Console must exactly match `<BASE_URL>/auth/callback`, e.g. `http://localhost:5173/auth/callback`. |
| Google: `access_denied` / "app has not completed verification" | Add your Google account under **Audience → Test users**. |
| `EADDRINUSE` | Port 5173 is taken. Stop the other process or set `PORT` (and update the redirect URI). |
| Signed out after about a week | Expected while the Google app is in **Testing** mode (see below). |
| Sync stops with a quota message | The daily `YOUTUBE_DAILY_QUOTA` is used up. It resets at midnight Pacific Time. |

---

## Using the app

- The app only calls YouTube when someone clicks **Sync**. Signing in and reloading just read the database.
- Sessions last 30 days. The server keeps an encrypted Google refresh token, so you stay signed in.
- **While the Google app is in Testing mode**, Google expires refresh tokens after **7 days**, so you'll have to sign in again weekly. Publishing and verifying the app removes this limit.

### Unsubscribing

Each row has an **Unsubscribe** button.

- The first time you use it, the app sends you to Google once to grant **"Manage your YouTube account"**. Normal sign-in only asks for read-only access.
- After that, each unsubscribe is one confirmation.
- Each unsubscribe costs **50 quota units**.
- There's no undo in SubPulse. To get a channel back, subscribe again on YouTube.

## Project layout

```
server/
  index.js    HTTP server + routes (entry point)
  auth.js     Google sign-in (OAuth code flow + PKCE), sessions, token encryption
  sync.js     background sync jobs, shared channel cache, quota guard
  youtube.js  YouTube API calls + per-channel stats
  db.js       ALL database code (SQLite) — the only file to change for Postgres/MySQL
  config.js   settings from .env
public/       frontend (index.html, app.js, styles.css), served as static files
data/         SQLite database + generated encryption key (git-ignored)
```

## Database

| Table | Holds |
|---|---|
| `users` | Google account ID (no email or name), encrypted refresh token, granted scopes, last sync time |
| `sessions` | hashed session IDs |
| `channels` | public channel stats, **shared by all users** |
| `subscriptions` | which user follows which channel, plus YouTube's subscription ID (needed to unsubscribe) |
| `api_usage` | YouTube API units used per day |

**Shared cache:** channel stats that anyone synced in the last `CHANNEL_TTL_HOURS` (default 6) are reused instead of fetched again. With many users, this is what keeps the app inside the quota.

**Retention:** a channel is deleted once no subscription list has included it for 30 days (the YouTube API storage limit), and a user's subscriptions are deleted after 30 days without a sync. **Disconnect & delete my data** revokes Google access and deletes the user immediately.

New columns are added to existing databases automatically at startup (`migrate()` in `db.js`).

**Moving to Postgres/MySQL later:** reimplement `server/db.js` with the same exported functions. The SQL is portable, and the file lists the few type changes needed at the top.

## Quota

Each channel costs about 3 units when it needs fetching. Reused channels cost nothing. The header shows the whole app's usage for today against the default limit of 10,000 units per day. Once `YOUTUBE_DAILY_QUOTA` is reached, syncs stop until the quota resets at midnight Pacific Time.

## Known limitations

- Frequency and averages only cover each channel's last ≤50 uploads.
- The `UUSH…` Shorts playlist is not an official API feature and could stop working without notice. Rows marked **est.** fall back to a ≤60 s duration check.
- Unverified apps are limited to 100 test users. A public launch needs Google OAuth verification, HTTPS (`BASE_URL=https://…` turns on secure cookies) and a privacy policy.
