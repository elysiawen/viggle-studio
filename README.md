# Viggle Studio 1.0

A fully rewritten, locally hosted **multi-account AI video generation workbench**.

The original project was a course demo: a single ~1,400-line file mixing frontend and backend code (archived in `legacy/web/`). This rewrite splits it into a cleanly layered, full-stack Next.js + TypeScript application:

| Area | Original | 1.0 |
| --- | --- | --- |
| Architecture | One `server.js` + 3 static files | Next.js App Router + Route Handlers, layered `services` / `provider` |
| Language | Vanilla JS | Full-stack TypeScript (strict) |
| Accounts | A single plaintext `token.txt` | Multiple upstream accounts; JWTs encrypted with AES-256-GCM in SQLite, switchable from the UI |
| Data | None | Prisma + SQLite: accounts / assets / tasks / relation tables |
| Tasks | Unbounded `while(true)` polling every 4s in the browser | Server-side polling daemon + persisted tasks + SSE updates + timeout guard |
| Upstream | Signing logic scattered across routes | A `VideoProvider` contract hides signing, sessions and multipart details while talking to the real Viggle API |
| UI | Single page, imperative DOM | Dark workbench: side navigation, parameter panel, live preview, task queue, history gallery, asset library |
| Validation | Duplicated frontend/backend checks, no `mode` allowlist | Unified zod validation + hard free-tier constraints + per-account asset isolation |
| Engineering | No `.gitignore` / tests / config | `.env` config, unit tests, health check, structured logging |

---

## Requirements & Quick Start

Requires **Node.js >= 20.9** (verified on 22.12).

```bash
npm install          # postinstall runs prisma generate automatically
npm run db:push      # create the SQLite database and all tables
npm run dev          # http://localhost:3000
```

First run: open **Accounts**, add a valid JWT exported from a logged-in `viggle.ai` session (`localStorage.viggleToken`), click **Verify** until the status reads **Available**, then go to the **Studio** and start generating.

You can also bulk-import by clicking **Import Cookie File**: pick a JSON file exported by something like `cookie-profile-switcher`; only profiles with `site=viggle.ai` are imported (the JWT is read from `localStorage.viggleToken`) and everything else is ignored. A preview is shown before importing and duplicate JWTs are skipped automatically. Bulk import does not verify accounts; click **Verify** on individual cards as needed.

**Export Accounts** supports two formats: a cookie-profile format compatible with the browser plugin (`cookie-profiles-*.json`), and a project backup format with metadata such as notes, status, email and credits (`viggle-studio-accounts-*.json`). Both can be restored via **Import Cookie File**. Exported files contain plaintext JWTs — keep them safe.

### Automatic Account Selection

With auto mode enabled, every generation first walks the account list, verifies real-time credits, and activates the first account with enough credits. Free credits refresh **daily at 08:00 Beijing time (UTC 00:00)**.

When a verification shows fewer than 2 credits (one generation costs 2), the account is stamped with `creditsResetAt` (the next refresh time). Until that moment, auto selection skips the account **without any upstream request**; the account card shows a **Credits used up** badge with the refresh time in its tooltip. The badge is time-based and disappears on its own after the refresh — no re-verification is required, though the visible credit number only updates on the next verification.

If an upload draft already exists, the currently active account is locked so assets are never mixed across accounts.

Upstream tokens expire in roughly 30 days and there is no refresh endpoint. The built-in **renew assistant** can log in through a local Chrome and write a fresh token back (see below).

Production build:

```bash
npm run build
npm start
```

## Settings

A gear button in the top bar opens the **Settings** page. All storage options are stored in the `Setting` table and take effect immediately — no restart required:

- **Auto-save** — a master switch with two chips: video+cover and asset. The finished video and its cover are always saved together (encryption can still be toggled separately per type); asset keeps every uploaded reference file in the asset box (all on by default).
- **Encryption** — encrypt videos, covers and uploaded assets independently as `.ske` containers (requires `STORAGE_PASSWORD`).
- **Storage directory** — editable; validated for writability before saving.
- **Asset box** — every uploaded reference image/video is also kept on disk under the storage root; manage and delete them here.

The storage directory is also snapshotted onto every `LocalVideo` record. Changing it only affects files saved afterwards: old files stay in their original directory and remain playable/deletable, and nothing is moved or deleted. The directory defaults to `./storage` and is written to the database on first use; change it on the **Settings** page.

The same page shows read-only system information: app version, runtime and Node version, uptime, database and storage paths, upstream base URL, polling intervals, and whether the access/encryption passwords are configured.

## Asset Box

Uploaded reference media is stored locally as well, so it can be reused without picking the file again:

- Files live in `<storage root>/assets/`, named `<sha256>.<ext>`; identical content is stored once. With encryption enabled, new uploads are stored as `.ske` and decrypted on the fly for previews and uploads.
- Saving uploads can be turned off on the **Settings** page; existing files stay until deleted.
- The **Files** picker in the generation panel has two tabs: **Local assets** (local files, uploaded to Viggle only when you submit a generation) and **Account library** (the upstream library of the active account).
- Deleting assets on the **Settings** page removes local files only. History, generated videos and upstream uploads are untouched.
- Pickers reuse the upstream upload for the same local file and account when possible, so repeated generations do not re-upload it.
- Asset encryption follows its own toggle: encrypted assets are decrypted server-side for previews and re-uploads, so Viggle always receives the original plaintext bytes.

## Video Persistence

The storage root has three subdirectories created automatically: `videos/` holds `<taskId>.mp4`, `covers/` holds `<taskId>.<jpg|webp|png>`, and `assets/` holds uploaded reference media. Automatic download, encryption and the directory itself are configured on the **Settings** page.

Each saved file is recorded in the `LocalVideo` table together with its prompt and generation parameters (mode / duration / resolution / aspect ratio / quality / account / creation time). The **Local Files** list reads from this table and never scans the disk, so full metadata remains visible even after the task history is deleted. Deleting a local file removes its table row too.

The **Local Files** tab in the gallery can play, download and delete videos on disk. On the **History** tab, every succeeded card has a save button that manually persists the video and its cover, even when auto-save is off. The two sides are independent: **deleting local files never touches history, and deleting history never deletes local files**.

Older successful tasks can be backfilled with a script (safe to re-run; already-registered tasks are skipped):

```bash
npm run storage:backfill -- --dry-run                 # list only, no downloads
npm run storage:backfill                              # backfill everything
npm run storage:backfill -- --limit 20                # only the 20 most recent
npm run storage:backfill -- --account 3fa2            # filter by account ID prefix / label
npm run storage:backfill -- --interval 1500           # 1.5s between items to ease upstream rate limits
```

### Encryption at Rest (Optional)

Set a master password in `.env` to enable the encryption toggle on the **Settings** page:

```env
STORAGE_PASSWORD="your-master-password"
```

- The on/off switch is stored in the `Setting` table and only affects **newly saved files**; existing files are untouched.
- The format is Sakura Encryptor's `.ske` container (v001: AES-256-GCM + PBKDF2-HMAC-SHA256 with 100k iterations, 1 MiB chunks). It follows SKE's **encrypted filename** convention: files on disk are named `<KDF-derived-token>.ske`, so the official CLI/GUI can open them directly (the name is restored before decryption). Plaintext files keep readable names like `<taskId>.mp4`.
- Playback and cover endpoints decrypt on demand server-side (Range requests only decrypt the covered chunks), transparently to the frontend.
- The master password is read from the environment only — never stored in the database or sent to the browser.

## Environment Variables

See `.env.example`. Key entries:

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | `file:./viggle-studio.db` | Path is relative to `prisma/schema.prisma` |
| `CREDENTIALS_KEY` | Required (production) | 64 hex chars (32 bytes). **Changing it makes all encrypted JWTs unreadable — back it up** |
| `ACCESS_PASSWORD` | Empty (disabled) | When set, the page requires this password. Changing it requires a rebuild (`npm run build`) |
| `VIGGLE_BASE_URL` / `VIGGLE_USER_AGENT` / `VIGGLE_SIGN_SALT` | See template | Upstream base URL, user agent and signing salt |
| `VIGGLE_REQUEST_TIMEOUT_MS` / `VIGGLE_UPLOAD_TIMEOUT_MS` | 60000 / 120000 | Upstream timeouts (converted to seconds internally for httpcloak) |
| `TASK_POLL_INTERVAL_MS` / `TASK_POLL_MAX_AGE_MS` | 4000 / 900000 | Polling interval and maximum task lifetime |
| `STORAGE_PASSWORD` | Empty | Encryption master password (SKE container). Leave empty to disable encryption; once set, toggle encryption on the **Settings** page |

## Project Layout

```
prisma/schema.prisma            Account / Asset / Task / TaskAsset / Setting / LocalVideo (saved-file index)
src/lib/                        Shared types, parameter constants, API client, formatting
src/server/
  config.ts  crypto.ts  db.ts  errors.ts  logger.ts  events.ts  validation.ts  task-manager.ts
  provider/
    types.ts                    VideoProvider contract
    index.ts                    Single Viggle instance (supports test injection)
    viggle/                     signature / session / client / index
  crypto/ske.ts                 Node implementation of the Sakura Encryptor (.ske v001) container
  services/                     accounts.ts  assets.ts  tasks.ts  video-store.ts  local-videos.ts  storage-settings.ts
src/app/api/                    Route Handlers (all forced to the nodejs runtime)
src/components/                 Workbench UI and global state (SSE)
src/app/globals.css             Dark design system
renew-agent/                    Local renew assistant (Chrome automation + CDP)
legacy/web/                     Full archive of the original project (node_modules included, gitignored)
Viggle视频生成接口文档.md        Source of the upstream API specification
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Health check + database connectivity |
| GET | `/api/me` | Active account, credits and provider info |
| GET / POST | `/api/accounts` | List accounts / create one (verifies the JWT automatically) |
| PATCH / DELETE | `/api/accounts/:id` | Update (including replacing the JWT) / delete |
| POST | `/api/accounts/:id/activate` | Switch the active account (transactional uniqueness) |
| POST | `/api/accounts/:id/verify` | Re-verify the JWT and credits |
| POST | `/api/accounts/auto` | Auto-select an account with enough credits |
| POST | `/api/accounts/verify-all` | Batch verification (optional ID list) |
| POST | `/api/accounts/import` | Bulk import from cookie-profile JSON |
| GET | `/api/accounts/export` | Export accounts (`format=cookie-profile\|studio`) |
| POST | `/api/accounts/batch-delete` | Delete multiple accounts |
| GET | `/api/accounts/:id/credentials` | Plaintext login credentials for the renew assistant |
| POST | `/api/assets` | Upload assets (multipart) |
| GET | `/api/assets/library` | List the account's Viggle library (paginated, read-only) |
| POST | `/api/assets/library` | Register selected library assets locally |
| GET / POST | `/api/tasks` | List tasks (optional account filter) / create a task |
| POST | `/api/tasks/batch-delete` | Delete multiple tasks |
| GET / DELETE | `/api/tasks/:id` | Single task / delete the local record (optionally the upstream video too) |
| POST | `/api/tasks/:id/refresh` | Manually refresh status |
| POST | `/api/tasks/:id/resume` | Resume a task wrongly marked failed while still running upstream (no re-creation, no credits spent) |
| GET | `/api/tasks/:id/download` | Streaming download (resolves the latest URL, forwards Range) |
| GET | `/api/tasks/:id/stream` / `/cover` / `/source` | Preview stream / cover / original source media |
| GET / POST / DELETE | `/api/videos/local/:id` | Play / manually save a finished task to local storage / delete the local copy |
| GET | `/api/videos/local/:id/cover` | Saved local cover |
| GET / PATCH | `/api/storage/settings` | Read / update auto-save, encryption and storage directory |
| GET | `/api/system/info` | Read-only system information for the Settings page |
| POST | `/api/auth/login` / `/api/auth/logout` · GET `/api/auth/status` | Access-password session |
| GET | `/api/events` | SSE: snapshot / task progress / account sync / heartbeat |

Unified response envelope: `{ ok: true, data }` or `{ ok: false, error: { code, message, details } }`.

## Upstream Provider

The `VideoProvider` contract exposes `verify / upload / create / poll / deleteRemoteTask / listLibraryAssets / getVideoStream`. Business logic depends only on the contract and knows nothing about `t/u/s` signing, multipart or httpcloak. The implementation talks to the real Viggle API, with every detail confined to `src/server/provider/viggle/`: MD5 signing, a per-account `httpcloak` fingerprint session, asset upload, three generation modes (references / start-end frames / text only), status polling, upstream deletion and lookup, and streaming downloads.

Provider instances are shared across Next.js chunks (`globalThis`), and configuration is read through dynamic environment keys so it is never inlined at build time.

> The local login endpoint cannot be used on `127.0.0.1` because its Turnstile sitekey is bound to the domain (same as the original project), hence the **paste a JWT** flow. Tokens last about 30 days and there is no refresh endpoint, so either re-add the token or use the renew assistant once it expires.

## Renew Assistant

`renew-agent/` is a small client-side helper. Clicking **Renew** in the web UI launches a local Chrome instance that pre-fills the Viggle email and password; you only click **Log in** and complete the Cloudflare check, and the assistant captures the token, writes it back to the server and verifies it automatically.

It must run on the client machine because the Cloudflare challenge cannot be solved headlessly on a server, whereas the server only needs to receive the resulting token. Requirements: Node.js 20+ and Chrome; no `npm install` needed. Start it with `renew-agent/renew-agent.bat` (Windows). Configuration lives in `renew-agent/renew-agent.json` (gitignored), and the assistant listens on `127.0.0.1:3021`. See `renew-agent/README.md` for details.

## Testing & Verification

```bash
npm run typecheck    # tsc --noEmit
npm test             # unit tests
npm run build        # production build
```

Unit tests cover: AES-GCM encryption/decryption and tamper detection, JWT normalization, **regression of the signing algorithm against real captured samples from the API docs**, GET/POST signing payload rules, parameter allowlists and free-tier constraints, multipart construction, and provider instance sharing.

## Security & Compliance

- JWTs are stored only as AES-256-GCM ciphertext; the UI shows a masked string. `CREDENTIALS_KEY` is enforced in production.
- `.gitignore` covers `.env`, `*.db`, `legacy/web/token.txt`, the renew assistant's config/profile directories, and more. Do not publish plaintext credentials from the old project or test-account details from the docs.
- The server binds to localhost by default. If exposed publicly, set `ACCESS_PASSWORD` and use HTTPS.
- The upstream is a third-party site's private web API that relies on your own login session. Make sure your usage complies with its terms of service, and accept the risks of API changes, credit consumption and account issues.
- Downloaded videos and covers are stored locally (optionally encrypted) and are independent of the ~13-hour presigned URLs; history entries keep metadata only.

## Known Limitations

- The background polling daemon is an in-process timer in a long-running Node process, so it is not suitable for stateless serverless deployment; local or always-on hosting works fine.
- `httpcloak` depends on `koffi` native FFI binaries, so all related Route Handlers are forced to `runtime = "nodejs"` with `serverExternalPackages` configured; prebuilt binaries only cover the five officially supported platforms.
- Asset URLs are valid for about 2 hours and are only meant for short-term previews. Switching accounts clears the current unsubmitted draft assets to prevent cross-account mixing.
