# easyChat — messaging workspace

A unified messaging inbox built with TypeScript, NestJS, React, and PostgreSQL. Facebook Page uses official Meta OAuth, Graph API, signed webhooks and the shared worker/outbox for two-way messaging within the standard 24-hour reply window. Existing Zalo OA connections use OAuth and authenticated webhooks and remain read-only. Zalo Personal connects by QR through the unofficial `zca-js` adapter and supports one-to-one text replies through a separate worker and PostgreSQL transactional outbox. There is no chatbot, global history import, or sample customer data in the application.

The Vietnamese **easyChat** interface provides a unified inbox and an application/account hub at `/apps`. Its provider registry supports adding future integrations without redesigning navigation. Zalo Personal, Zalo OA and Facebook Page are integrated. Messenger Personal is explicitly unsupported pending a verified E2EE-capable adapter; Instagram, WhatsApp and Email remain planned. See [frontend workspace architecture](docs/frontend-workspace.md).

**For personal accounts, start with [Zalo Personal setup and operations](docs/zalo-personal.md).** No OA or Zalo Developer App is required for that channel. The unofficial integration carries account restriction/lock risks described in that guide.

**For Facebook, see [Page setup, Meta permissions, API, workers and manual verification](docs/facebook-page-setup.md)** and the [Personal compatibility evaluation](docs/facebook-personal-evaluation.md). Page credentials must be configured before live authorization; Personal does not offer fake login or messaging.

## Architecture

```text
apps/api/           NestJS REST API, authentication, Prisma, Zalo integration
  prisma/           PostgreSQL schema and committed SQL migration
  src/modules/auth/ Administrator sessions and origin checks
  src/modules/zalo/ OAuth, encrypted credentials, API client, webhook, history
  src/modules/zalo-personal/ QR adapter, sessions, shared durable dispatch/worker
  src/modules/facebook-page/ Official Graph adapter, OAuth, webhook, sync/send
  src/modules/facebook-personal/ Isolated unsupported capability boundary
  src/modules/messaging/     Shared persistence module and channel send policy
  src/modules/realtime/     PostgreSQL notifications and authenticated SSE
  src/modules/inbox/        Shared conversation/message persistence and APIs
  test/             Protocol fixtures, unit tests, PostgreSQL integration tests
apps/web/           React + Vite + Tailwind + shadcn/ui components
packages/shared/    Zod API contracts and inferred types, ESM/CommonJS exports
packages/tsconfig/  Shared strict TypeScript configuration
```

The browser calls only the NestJS API. Zalo requests and database access stay on the server/worker. Authenticated SSE refreshes stored conversation and personal-channel state; existing local API polling remains a fallback. Frontend, API, and personal worker run independently; Turborepo starts them together with `pnpm dev`. Docker Compose runs PostgreSQL only; Redis is not required.

OA storage uses `ZaloConnection`, shared `Conversation` and `Message`, plus `AdminSession` for durable authentication/OAuth state and `WebhookEvent` for durable receipt and failure recovery. Conversations are unique per OA/customer; messages are unique per OA/external message ID. The schema supports multiple OAs, while authorization keeps one active OA in this MVP. Prior OA conversations remain readable after disconnecting or switching accounts. Personal accounts add `ChannelAccount`, `PersonalCommand`, and `PersonalWorkerState`, with nullable channel references and unique constraints in the shared inbox tables. Migrations preserve existing OA and personal records. Facebook adds Page-scoped conversations, resumable sync, read/delivery timestamps and OAuth selection fields; external account uniqueness is scoped by owner and provider.

## Prerequisites

- Node.js 22.12+ and pnpm 12.15 (`corepack enable`, then `corepack prepare pnpm@12.15.0 --activate`, if Corepack is installed).
- Docker with Compose, or an existing PostgreSQL database.
- For OA: a Zalo Developer application, an eligible OA, and access as an OA administrator.
- For Personal: your own Zalo mobile account and a QR confirmation; no OA credentials.

## Install and run locally

Run from the repository root:

```bash
pnpm install
pnpm env:init
docker compose up -d postgres
pnpm db:generate
pnpm db:deploy
pnpm dev
```

`env:init` creates `apps/api/.env` with random administrator/session/encryption secrets and creates `apps/web/.env`. Existing environment files are preserved. It does not create Zalo credentials. Find the generated `ADMIN_PASSWORD` in `apps/api/.env` and use it on the sign-in page. Do not put this password into a Vite variable.

- Frontend: <http://localhost:5173>
- Backend: <http://localhost:3000/api>
- PostgreSQL: `localhost:5432`, database `zalo_inbox`, user/password `postgres` for local development.

Without OA credentials, sign-in, database access, the empty inbox, and Personal QR login remain available. The OA connection page explains missing OA configuration. Neither channel substitutes fake responses or customer messages.

Independent development processes:

```bash
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

Other commands:

```bash
pnpm build                  # shared package, frontend bundle, Prisma client, NestJS
pnpm lint                   # ESLint and TypeScript checks
pnpm test                   # credential-free unit and component tests
pnpm format:check
pnpm --filter @zalo/api start       # built API; working directory is apps/api
pnpm --filter @zalo/api worker:start # separate built personal worker
pnpm --filter @zalo/web preview     # built frontend preview
```

For production, run API and one personal worker as separate processes. Serve `apps/web/dist` with SPA fallback and proxy `/api` to the independently running API. Use a common HTTPS origin for frontend/API/callback so session cookies work. Vite preview is a local inspection server.

## PostgreSQL and migrations

The initial migration is committed under `apps/api/prisma/migrations/20261105000000_init`. `pnpm db:deploy` applies committed migrations without modifying them. To change the schema during development:

```bash
pnpm db:migrate --name describe_change
pnpm db:generate
```

The Compose volume retains records across restarts. `docker compose down` stops the service without deleting that volume. Point `DATABASE_URL` at your own PostgreSQL server if Docker is unavailable.

## Environment configuration

Backend variables are read from `apps/api/.env` or the API process environment. See [.env.example](apps/api/.env.example). Root `.env.example` is a reference; the root `.env` is not loaded by the applications.

| Variable               | Purpose                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `NODE_ENV`             | `development`, `test`, or `production`                                  |
| `PORT`                 | Backend port, default `3000`                                            |
| `DATABASE_URL`         | PostgreSQL connection URL                                               |
| `FRONTEND_URL`         | Browser origin and OAuth return destination                             |
| `ZALO_APP_ID`          | Zalo Developer application ID; keep it as a string                      |
| `ZALO_APP_SECRET`      | Application secret sent as the token endpoint's `secret_key` header     |
| `ZALO_REDIRECT_URI`    | Exact registered backend OAuth callback URL                             |
| `ZALO_OA_SECRET_KEY`   | OA secret named `OAsecretKey` in Zalo's webhook signature specification |
| `TOKEN_ENCRYPTION_KEY` | 32 random bytes encoded as 64 hex characters for AES-256-GCM            |
| `ADMIN_PASSWORD`       | Server-configured administrator password, minimum 12 characters         |
| `SESSION_SECRET`       | At least 32 random characters for session cookie signatures             |

Keep the encryption key stable and back it up with your configuration; changing it makes existing encrypted tokens unreadable. Session cookies expire after eight hours and are HttpOnly, SameSite=Lax, and Secure in production. Logout deletes the database session. Login is limited to five attempts per minute per IP in one API process. Mutations require the configured frontend Origin. When deploying behind a proxy, configure its rate limits rather than trusting arbitrary forwarded IP headers.

Frontend variables are separate; see [apps/web/.env.example](apps/web/.env.example):

- `VITE_API_BASE_URL=/api` is public configuration only.
- `API_PROXY_TARGET=http://localhost:3000` controls the Vite development proxy.
- `DEV_ALLOWED_HOSTS` is a comma-separated list of explicitly allowed development tunnel hostnames.

Tokens, app secrets, the encryption key, and administrator credentials never belong in `VITE_*`. Environment files are ignored by Git.

The personal channel additionally uses `ZALO_PERSONAL_ENABLED` (default `true`), `ZALO_PERSONAL_SEND_MAX_ATTEMPTS` (default `3`), and `ZALO_PERSONAL_SEND_INTERVAL_MS` (default `1500`). It reuses the existing encryption key; see [personal configuration](docs/zalo-personal.md#configuration).

## Create and configure the Zalo application (OA only)

1. Sign in at [Zalo for Developers](https://developers.zalo.me/) and create/select your application. Obtain its App ID and application secret from its settings. Enable/register Official Account API access for the app as required by the portal.
2. Set `ZALO_APP_ID` and `ZALO_APP_SECRET` on the backend; these enable the Connect button. The OA can be authorized before webhook signing is configured. Set `ZALO_OA_SECRET_KEY` to the signing credential described as `OAsecretKey` for your webhook configuration; do not assume it is interchangeable with an OAuth refresh token or the application secret. Confirm this value with the OA/application webhook settings or Zalo support if the portal does not expose it.
3. Register the exact callback URL you will use as `ZALO_REDIRECT_URI`, ending in `/api/zalo/callback`.
4. In the application's OA permission configuration request **Quyền quản lý thông tin OA** for the profile, **Quyền nhận sự kiện quản lý tin nhắn** for message webhooks, and **Quyền quản lý tin nhắn người dùng** if you need the bounded history method. Select only the relevant read/event permissions; this application does not send messages.
5. Complete any application review, OA verification, or service-package eligibility required for those features. Portal visibility alone does not mean the app or OA has been approved. The OA administrator must also grant the configured permissions during authorization.

The implementation uses Zalo OAuth v4 with a fresh PKCE verifier and random state for every attempt. These are generated by the backend; do not replace the URL returned by `/api/zalo/connect` with a saved static permission link. Permission selection is configured in Zalo's portal, not an invented OAuth `scope` value. See the official [authorization guide](https://stc-developers.zdn.vn/docs/v2/official-account/bat-dau/xac-thuc-va-uy-quyen-cho-ung-dung-new) and [OA platform documentation](https://docs.zaloplatforms.com/docs/OA).

## Expose a local HTTPS webhook

Use a publicly reachable HTTPS tunnel or your own HTTPS reverse proxy. A convenient development setup is **one tunnel to Vite port 5173**, since Vite forwards `/api` to NestJS. For example, if an installed tunnel tool gives you `https://your-tunnel.example`, configure:

```env
# apps/api/.env
FRONTEND_URL=https://your-tunnel.example
ZALO_REDIRECT_URI=https://your-tunnel.example/api/zalo/callback
```

```env
# apps/web/.env
VITE_API_BASE_URL=/api
API_PROXY_TARGET=http://localhost:3000
DEV_ALLOWED_HOSTS=your-tunnel.example
```

Restart both processes after changing configuration. Register that exact callback in Zalo and open the frontend through the same tunnel origin **before signing in**. This keeps the login cookie available on the OAuth callback. Do not start on `localhost` and return to a different tunnel hostname. A tunnel must forward the request body and `X-ZEvent-Signature` unchanged and must not require an interactive login for Zalo's POST requests. Avoid exposing development servers beyond the tunnel access needed for testing.

For a deployed HTTPS installation, set `NODE_ENV=production`; the API enforces HTTPS frontend and callback URLs.

## Register the webhook and connect the OA

1. In the Zalo application/OA webhook configuration, set the URL to `https://your-tunnel.example/api/webhooks/zalo`.
2. Enable `user_send_text` and `oa_send_text`. Optionally enable documented image/file events such as `user_send_image`, `oa_send_image`, `user_send_file`, and `oa_send_file`.
3. Restart the API after saving the backend credentials.
4. Sign in to the frontend and open **Kết nối ứng dụng → Zalo → Official Account**.
5. Click **Connect Zalo Official Account**. Sign in on Zalo, choose your OA, and grant the permissions. You must be an authorized administrator of the selected OA.
6. The browser returns to the connection page. Check the connected status, OA name, avatar, and ID. No access token needs to be copied into the application.
7. Send a real text message from a Zalo user to that OA. Open **Inbox** and select its conversation; allow a few seconds for delivery and polling.
8. Reply using Zalo OA Manager to verify the outgoing webhook. This web application intentionally has no compose/send controls.

Disconnect clears locally stored tokens and stops accepting new messages for that connection. Existing conversations remain. It does not call an undocumented Zalo revocation endpoint; remove the app's authorization in Zalo's own management interface if that is also needed.

## Verified integration details

The implementation was checked against official Zalo documentation on November 5, 2026. Some `developers.zalo.me` pages are client-rendered; the official `stc-developers.zdn.vn` documentation pages and Zalo's SDK expose the protocol details.

| Operation               | Implemented contract                                                                                   | Official reference                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| OA authorization        | `https://oauth.zaloapp.com/v4/oa/permission`, `app_id`, `redirect_uri`, `code_challenge`, `state`      | [Zalo SDK OAuth implementation](https://github.com/zaloplatform/zalo-php-sdk/blob/master/src/Authentication/OAuth2Client.php)                       |
| Code exchange / refresh | Form POST to `https://oauth.zaloapp.com/v4/oa/access_token`; application secret in `secret_key` header | [OAuth v4](https://stc-developers.zdn.vn/docs/v2/official-account/bat-dau/xac-thuc-va-uy-quyen-cho-ung-dung-new)                                    |
| OA profile              | GET `https://openapi.zalo.me/v2.0/oa/getoa`; `access_token` header                                     | [OA information](https://stc-developers.zdn.vn/docs/v2/official-account/quan-ly/quan-ly-thong-tin-oa/lay-thong-tin-zalo-official-account)           |
| Incoming events         | String IDs, `message.msg_id`, millisecond `timestamp`, documented attachments                          | [User message webhook](https://stc-developers.zdn.vn/docs/v2/official-account/webhook/tin-nhan/su-kien-nguoi-dung-gui-tin-nhan)                     |
| Outgoing events         | OA is `sender.id`; customer is `recipient.id`                                                          | [OA message webhook](https://stc-developers.zdn.vn/docs/v2/official-account/webhook/tin-nhan/su-kien-official-account-gui-tin-nhan-cho-nguoi-dung)  |
| Known-user history      | GET `https://openapi.zalo.me/v2.0/oa/conversation`; `data={user_id,offset,count}`; maximum 10          | [Conversation history](https://stc-developers.zdn.vn/docs/v2/official-account/tin-nhan/quan-ly-tin-nhan/lay-thong-tin-tin-nhan-trong-mot-hoi-thoai) |
| Business errors         | Handles error codes even on HTTP 200; one refresh/retry for `-216` or `-220`                           | [OA error codes](https://stc-developers.zdn.vn/docs/v2/official-account/phu-luc/ma-loi)                                                             |

Tokens use the returned `expires_in` value. Refresh rotates and encrypts **both** tokens in one database transaction. PostgreSQL row locks serialize refreshes, including across API processes. If a token exchange times out, its outcome may be ambiguous because a refresh token is single-use; the account requires reconnection instead of automatically replaying that token. Rate-limit responses are surfaced without a retry loop.

Webhook verification computes SHA-256 over `appId + raw JSON body + timestamp + OAsecretKey`, with a timing-safe comparison against `X-ZEvent-Signature` (bare hex or `mac=` prefix). It is **not** HMAC and does not reserialize the body. Invalid signatures are rejected before persistence. Validated timestamps must be plausible milliseconds and no more than five minutes in the future. Older signed events remain acceptable for delivery retries; database uniqueness prevents duplicate messages. Out-of-order events cannot move a conversation's latest preview backwards.

## History and recovery boundaries

Webhooks are the primary source. `ZaloHistoryService.syncConversationPage(conversationId, offset, count)` is a reusable **backend-only** method for one known, stored conversation. It issues one request, accepts at most 10 messages, validates participants, and uses the same database deduplication as webhooks. It is not exposed as an inbox action. Callers must pace further requests according to their approved quota; the client surfaces Zalo rate-limit errors. There is no global discovery/import or promise of unrestricted historical access. Imported messages carry `source=HISTORY`; the UI labels them as imported history. Webhook messages carry `source=WEBHOOK`.

Authenticated webhook receipts are stored before processing. Conversation/message changes and processed status commit atomically; failures stay in `WebhookEvent` and return an error to the sender. Exact duplicate receipts and duplicate message IDs are safe to replay. Non-message events are explicitly marked `IGNORED`; unfamiliar message types retain their payload metadata and display a fallback. Image/file attachment URLs are shown only for HTTP(S).

The connection page shows failed receipt counts and a bounded retry action. Receipts still marked `RECEIVED` after one minute are also included, so a crash between receipt commit and processing remains visible. Administrators can also inspect the latest 50 failed receipt summaries with `GET /api/zalo/webhook-events/failed` and retry one with `POST /api/zalo/webhook-events/:id/retry`. These endpoints require the administrator session; retry additionally requires the frontend Origin. Fix connection/payload/storage problems first. Full authenticated payloads remain in PostgreSQL for investigation. If the process crashes between receipt and processing, Zalo redelivery or an administrator retry processes the stored receipt; there is no background queue.

## REST API

Success: `{ "data": ... }`. Error: `{ "error": { "code": "...", "message": "..." } }`.

| Method | Path                              | Access                                            |
| ------ | --------------------------------- | ------------------------------------------------- |
| POST   | `/api/auth/login`                 | Password + frontend Origin, rate limited          |
| GET    | `/api/auth/session`               | Administrator                                     |
| POST   | `/api/auth/logout`                | Administrator + frontend Origin                   |
| GET    | `/api/zalo/connect`               | Administrator; returns authorization URL          |
| GET    | `/api/zalo/callback`              | Session-bound state + PKCE; redirects to frontend |
| GET    | `/api/zalo/status`                | Administrator; public connection fields only      |
| GET    | `/api/zalo/profile`               | Administrator; refreshes OA information           |
| DELETE | `/api/zalo/connection`            | Administrator + frontend Origin                   |
| GET    | `/api/conversations`              | Administrator                                     |
| GET    | `/api/conversations/:id/messages` | Administrator                                     |
| POST   | `/api/webhooks/zalo`              | Zalo signature                                    |

Inbox pagination supports `?limit=30&cursor=nextCursor` with an opaque cursor (limit 1–100), returning `items`, `page`, `limit`, `hasMore`, and `nextCursor`. The legacy `?page=1&limit=30` remains compatible; account and channel filters apply before pagination. Conversations are newest first; message pages are newest first and the UI displays them chronologically. Search filters the conversations currently loaded, and the UI labels that boundary.

## Tests without provider credentials

```bash
pnpm test
```

Protocol/unit/component tests cover PKCE, state expiry/reuse, callback processing, encryption tampering, refresh/retry errors, raw-body signatures, direction/attachment normalization, unsafe numeric IDs, shared contracts, administrator sign-in, and conversation selection. Fixtures in `apps/api/test/fixtures` follow the documented event shapes and use synthetic message IDs and content. All external API responses in tests are explicitly mocked. Tests never insert fake messages into the development inbox.

To run the PostgreSQL integration suite:

```bash
docker compose exec -T postgres createdb -U postgres zalo_inbox_test
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/zalo_inbox_test pnpm test:integration
```

Create that database once; skip `createdb` if it already exists. The suite applies migrations and deletes rows **only in the explicitly supplied test database**. Its name must end in `_test`. It exercises the real NestJS HTTP application, middleware, and PostgreSQL: sessions and origin protection, concurrent duplicate deliveries, conversation creation, ordering/pagination, durable failures and replay, transaction rollback, concurrent refresh locks, simultaneous OAuth callbacks, secret-free response DTOs, and history deduplication. No real Zalo credentials are needed.

## Troubleshooting

| Symptom                                              | What to check                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API does not start                                   | Configuration validation, `DATABASE_URL`, PostgreSQL health, and applied migrations. Start the API from `apps/api` or use the root scripts.                                                                                                                                                                                                                                                                                     |
| Cannot sign in / origin rejected                     | Use the exact `FRONTEND_URL` origin, check the password in `apps/api/.env`, and retry after a minute if rate limited.                                                                                                                                                                                                                                                                                                           |
| OAuth state/session expired                          | Start authorization again from the UI in the same browser and origin. OAuth attempts expire after ten minutes and can be consumed once.                                                                                                                                                                                                                                                                                         |
| Zalo `-14003` — Invalid redirect uri                 | Match the Official Account Callback Url registered in Zalo Developers to `ZALO_REDIRECT_URI`, including scheme, port, path, and trailing slash. Save the portal setting, then start a fresh connection from the frontend.                                                                                                                                                                                                       |
| Zalo `-14068` — User don't own any Official Accounts | The Zalo account signed in on the authorization page has no OA available to authorize. Open [OA Manager](https://oa.zalo.me/manage/oa) with that same account, confirm its OA administrator role, or create/request access to an OA. A Developer application and an OA are separate resources; see [Zalo's authorization overview](https://oa.zalo.me/home/documents/guides/Khoi-tao-ung-dung-va-cap-quyen_117071366476220195). |
| OA profile permission error                          | Grant OA information access, complete required review, and reauthorize.                                                                                                                                                                                                                                                                                                                                                         |
| `REAUTH_REQUIRED`                                    | Reconnect in the UI. Refresh was refused, authorization revoked, or an exchange timed out ambiguously.                                                                                                                                                                                                                                                                                                                          |
| Zalo `-223`, `-221`, `-224`, `-212`                  | Check the specific API permission, OA verification, service package, or API registration. See [official error meanings](https://stc-developers.zdn.vn/docs/v2/official-account/phu-luc/ma-loi).                                                                                                                                                                                                                                 |
| Webhook `401`                                        | Check application ID, OA signing secret, exact body forwarding, and signature header. Never disable verification to get messages through.                                                                                                                                                                                                                                                                                       |
| Webhook `422`                                        | Inspect the saved receipt and timestamp; message IDs must be strings and text events must contain `message.text`.                                                                                                                                                                                                                                                                                                               |
| No conversations                                     | Check webhook subscriptions, permission approval, public HTTPS reachability, connected OA ID, and failed receipt count. Old messages do not appear automatically.                                                                                                                                                                                                                                                               |
| Missing customer names                               | Basic webhook events contain IDs, not names. The inbox falls back to the exact user ID. Authorized history can enrich names/avatars.                                                                                                                                                                                                                                                                                            |
| Tunnel blocked by Vite                               | Add its hostname to `DEV_ALLOWED_HOSTS`, then restart the web app.                                                                                                                                                                                                                                                                                                                                                              |
| Prisma cache permission error in a sandbox           | Use a writable `XDG_CACHE_HOME` for Prisma commands; this is an environment restriction, not a database migration error.                                                                                                                                                                                                                                                                                                        |

Live OAuth authorization, webhook delivery, and permission approval require your own Zalo application/OA and were not exercised against a real account. Local tests verify protocol handling and persistence, not approval or account eligibility. Mocked browser checks cover desktop/mobile Facebook setup and the unified inbox alongside existing Zalo layouts. These and React tests/builds do not establish live provider delivery. Facebook Page configuration, supported capabilities, new endpoints and manual Meta verification are documented in [Facebook setup](docs/facebook-page-setup.md).
# easy-chat
