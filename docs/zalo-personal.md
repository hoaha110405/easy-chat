# Zalo Personal alongside Zalo OA

The existing Zalo OA integration remains available at `/connection`; personal accounts are added at `/personal`. Personal login uses **zca-js 2.2.0** and a QR scan. It does not use `ZALO_APP_ID`, `ZALO_APP_SECRET`, OA tokens, or an OAuth callback. Both channels share the existing inbox, PostgreSQL, administrator authentication, and AES-256-GCM encryption utility.

This is an **unofficial personal-account integration**. The [upstream project](https://github.com/RFS-ADRENO/zca-js) warns of possible account restriction or banning and supports only one active web listener per account. Opening Zalo Web elsewhere can interrupt this worker. Do not use this feature for unsolicited or automated bulk messaging.

## Architecture and ownership

- The existing NestJS HTTP API handles authentication, ownership, QR/status responses, conversation reads, and durable send requests. It never instantiates `zca-js`.
- A separate NestJS application context (`apps/api/src/worker.ts`) owns all ZCA instances through `ZaloSessionManager` and the `PersonalAdapter` port. `ZcaPersonalAdapter` is the sole dependency boundary for the library.
- `PersonalCommand` is a PostgreSQL transactional outbox. API writes to the message and command in one transaction. A single worker dispatches committed commands using `FOR UPDATE SKIP LOCKED`.
- PostgreSQL `LISTEN/NOTIFY` connects worker/API processes. Notifications contain identifiers and event types, never cookies or QR data. PostgreSQL releases them only after commit. The API forwards owner-filtered events through cookie-authenticated SSE at `/api/events`.
- EventSource reconnects and triggers a refetch of database state. Existing polling remains a fallback. Notifications are hints; PostgreSQL is the authoritative message store.
- Redis/BullMQ were not present in this repository. No second queue service, broker, or new workspace package is introduced. `pg` supplies the dedicated lock/notification connections, while Prisma remains the only ORM.

The app currently has **one administrator principal**, identified on the server as `administrator`. All valid administrator sessions belong to that same workspace; session IDs are not owners. Personal channels store `ownerId`, and channel/conversation/message/SSE access uses the authenticated principal, never a client-supplied owner. Separate administrator sessions are not separate tenants. A future multi-user system must map each authenticated user to a stable principal before granting independent workspaces.

## Database migration

Apply the additive migrations `20261105010000_zalo_personal` and `20261105020000_account_avatar`:

```bash
pnpm db:generate
pnpm db:deploy
```

There is no reset, table drop, or replacement of existing OA records. The migration:

- Adds `ChannelAccount` for personal connection state, external identity, encrypted session/QR, and a generation counter.
- Adds `PersonalCommand` for durable login/send references and `PersonalWorkerState` for worker liveness.
- Extends existing `Conversation` and `Message` with personal-channel references, external sender, idempotency key, and delivery state.
- Makes OA references nullable and enforces exactly one channel reference per conversation/message using database CHECK constraints.
- Adds per-channel external-message and outbound idempotency unique constraints.
- Reuses `WebhookEvent` for safe personal inbound receipts. OA recovery endpoints filter out personal receipts; the worker handles its own bounded recovery.

A personal channel remains bound to its first successfully connected external Zalo account. A later QR scan from a different account is rejected instead of mixing its conversations with the previous identity. Create another personal channel for a different account.

The avatar migration adds one nullable `ChannelAccount.avatarUrl` column. The adapter reads the account name and avatar during QR login and session restoration; a failed optional profile lookup never invalidates a login. Existing sessions receive this metadata on the next worker restoration. When no image is available, the UI displays initials.

Contact avatars use the existing `Conversation.customerAvatar` field. Once a personal session is connected, the worker backfills saved one-to-one conversations whose avatar is missing, using that session's `getUserInfo` API in batches of at most 50 contacts. New messages trigger another scan after their durable receipt and message have been stored. Profile requests run independently of ingestion and sending, are limited to one batch per second per account, and back off for one minute on failure. Completed scans retry missing profiles after five minutes. Only the contact ID, display name, and HTTP(S) avatar URL cross the adapter boundary; other profile fields are discarded.

Profile updates lock and check the current account generation before writing, remain scoped to that channel's saved conversations, and publish `conversation.updated` after commit. The list and chat header refresh through SSE, with the existing conversation polling as a fallback. Failed or unavailable profile lookups retain the initial-letter avatar and do not change connection or delivery state. Existing photos are retained.

## Choosing an inbox account

The inbox account selector shows **Tất cả tài khoản** plus each personal/OA account with its avatar, external Zalo ID, status indicator, and conversation count. Choosing an account filters on the server before pagination. The choice is stored in the URL (`/inbox?account=personal:<id>` or `oa:<id>`), survives reload, and is preserved when opening a chat or using the mobile back button. Switching the filter closes the previous chat and composer.

Every conversation row identifies its receiving account by avatar, name, external ID, and channel type. The desktop chat header and reply area repeat that identity; the compact mobile header shows **Nhận qua**. Outgoing messages use the account name. The selector includes accounts with no saved conversations and disconnected accounts whose history is retained.

## Configuration

The API and worker run from `apps/api` and load the same `.env`:

```env
ZALO_PERSONAL_ENABLED=true
ZALO_PERSONAL_SEND_MAX_ATTEMPTS=3
ZALO_PERSONAL_SEND_INTERVAL_MS=1500
```

The defaults above apply when the variables are absent. The interval has a minimum of 1000 ms; the retry cap is 1–5. An account can have at most 20 pending/sending messages queued; excess requests return `ZALO_RATE_LIMITED`. This MVP allows five personal channel records per administrator; disconnected channels are reusable.

Reuse the existing `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `ADMIN_PASSWORD`, `SESSION_SECRET`, and `FRONTEND_URL`. The shared AES-GCM key encrypts both personal sessions and temporary QR images, each with a fresh random IV. `pnpm env:init` generates this key securely for new installations. Keep it stable; changing it requires reauthentication of existing sessions. No separate personal encryption key is necessary.

No Zalo credentials are bundled in frontend environment variables. Restorable cookies, IMEI, and user agent are encrypted in PostgreSQL and never returned by the API or included in outbox jobs or realtime notifications. The authenticated status endpoint returns a PNG data URI only while its QR is valid; responses are not cached. The UI drops expired QR images. Treat database backups and QR login images as sensitive account data.

## Start the application

```bash
pnpm install
pnpm env:init
docker compose up -d postgres
pnpm db:generate
pnpm db:deploy
pnpm dev
```

`pnpm dev` starts **web, API, and personal worker**, using a separate output directory for the worker's development compiler. PostgreSQL is the only Docker service.

When switching between `pnpm dev` and independently started processes, stop the previous API and worker first. Each API port and database worker lock must have a single owner. `EADDRINUSE` on port 3000 together with a worker startup refusal usually means another complete application instance is still running.

Alternatively, run these in separate terminals:

```bash
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

Built processes:

```bash
pnpm build
pnpm --filter @zalo/api start
# A separate terminal/process:
pnpm --filter @zalo/api worker:start
```

Deploy one personal worker per database. A dedicated PostgreSQL session holds an advisory lock. A second worker refuses to start. A lost lock connection closes the old worker's listeners and stops dispatch; restart that process. The API checks a 20-second worker heartbeat before accepting a send or QR login. Polling the outbox is not polling Zalo messages; new personal messages arrive through the library's listener.

## Connect and use the inbox

1. Open <http://localhost:5173> and sign in using `ADMIN_PASSWORD` from the private backend environment.
2. Choose **Zalo Personal**, then **Connect Zalo Personal**.
3. Scan the QR with the Zalo mobile app and confirm the login on the phone.
4. Wait for **Connected**, then open **Inbox**. The same inbox also displays existing OA conversations.
5. Send a text from another Zalo account to the connected account. Select that conversation in the inbox.
6. Write a reply and press **Send**. The bubble progresses through Queued, Sending, and Sent, or displays an explicit failure/unknown outcome.

QR login handles generated, scanned/waiting confirmation, expired, declined, cancelled, failed, and connected states. Concurrent/repeated requests for the same account reuse one active attempt. Cancel/disconnect increments a database generation so late callbacks cannot restore an old attempt.

Personal conversations support replies. There is no phone-number-based contact discovery or global conversation import. A new conversation first appears when the connected listener receives a message for that thread. OA conversations retain their OAuth/webhook behavior and now support document sending within the configured policy; OA text/audio sending is not enabled. Personal document/audio sending is also available. See [media capabilities](media-attachments.md).

## REST API

All paths are under `/api`. Every endpoint below requires an administrator session. POST/DELETE additionally require the configured frontend Origin. Use browser `credentials: 'include'`; no browser API key is needed.

| Method | Path                                           | Result                                                       |
| ------ | ---------------------------------------------- | ------------------------------------------------------------ |
| GET    | `/channels/zalo-personal`                      | Feature flag, worker liveness, public account status list    |
| POST   | `/channels/zalo-personal`                      | Create account, body `{ "name": "My Zalo" }`                 |
| POST   | `/channels/:id/login/qr`                       | Enqueue/reuse a QR login attempt; HTTP 202                   |
| POST   | `/channels/:id/login/cancel`                   | Cancel the current QR attempt                                |
| GET    | `/channels/:id/status`                         | Public state and expiring QR image when available            |
| DELETE | `/channels/:id`                                | Disconnect, erase credentials/QR, retain saved conversations |
| GET    | `/conversations`                               | Existing paginated API, now includes OA and personal threads |
| GET    | `/conversations/accounts`                      | Owner-scoped account identities and conversation counts      |
| GET    | `/conversations/:id`                           | Authorized conversation details and `canSend`                |
| GET    | `/conversations/:id/messages`                  | Existing pagination, including delivery state                |
| POST   | `/conversations/:id/messages`                  | Enqueue one-to-one personal text; HTTP 202                   |
| POST   | `/conversations/:id/messages/:messageId/retry` | Explicit retry of a proven FAILED delivery only              |
| GET    | `/events`                                      | Authenticated, owner-filtered SSE                            |

`GET /conversations` accepts an optional `account=personal:<channelAccountId>` or `account=oa:<connectionId>` alongside `page` and `limit`. Omit it for all accounts. The account selector never overrides ownership checks. Conversation DTOs include `accountName`, `accountAvatar`, and `accountExternalId`; account lists never select encrypted credentials or QR data.

Send request:

```json
{
  "content": "A message the administrator chose to send",
  "idempotencyKey": "69ca93eb-0f61-4812-937e-e4c2ecea0956"
}
```

Text is trimmed and limited to 2000 characters. Generate a UUID once for a logical send. Repeating the same key/content/conversation returns the existing internal message; reusing a key for different content returns HTTP 409. The response uses the existing `{ "data": ... }` envelope and returns the internal message ID immediately with `deliveryStatus=PENDING`.

If the browser loses the HTTP response, **Check request** resubmits that same idempotency key. It never allocates a new key for an uncertain request. The database's delivery `UNKNOWN` state has no automatic retry action.

Realtime event types include `channel.qr_ready`, `channel.qr_scanned`, `channel.qr_expired`, `channel.qr_declined`, `channel.connected`, `channel.disconnected`, `channel.reauth_required`, `channel.error`, `conversation.updated`, `message.created`, `message.updated`, and `message.status_changed`. Each carries only applicable `channelAccountId`, `conversationId`, and `messageId`. SSE revalidates session expiry/revocation every 15 seconds, and the browser closes its stream on sign-out.

## Delivery guarantees and recovery

Outbound state:

```text
PENDING -> SENDING -> SENT
            |
            +-> UNKNOWN (possible external side effect; never automatically resend)
PENDING -> FAILED (known pre-send failure or cancellation)
```

PostgreSQL and Zalo cannot commit atomically, so **exactly-once external delivery is not guaranteed**. The worker writes SENDING before calling Zalo. On restart, interrupted SENDING messages become UNKNOWN; a command claimed before that marker is safe to resume. An exception after calling Zalo is conservatively ambiguous, including an HTTP timeout or failure saving the acknowledgement. The UI asks the administrator to check Zalo on the phone rather than automatically replaying the message.

Only failures proven to occur before sending can retry automatically. Attempts are bounded with exponential backoff, and external sends have a 15-second deadline. The worker spaces sends per account. Explicit retry is available only for FAILED messages after reconnection; UNKNOWN/SENDING cannot be retried through that endpoint. A self-sent echo is deduplicated by external message ID; if the echo arrives before the worker saves its acknowledgement, both are reconciled to the original queued message. An UNKNOWN proposal and a later self echo can remain separate when there is no trustworthy identifier linking them; no content/time heuristic silently claims successful delivery.

Session credentials restore on worker startup when valid. Invalid credentials require a new QR scan. Transient listener closure schedules a delayed reconnection; conflicting web sessions require reauthentication. Disconnect stops the local listener, cancels QR/pending work, clears credentials, and retains history. Already in-flight external sends can have an unknown outcome.

Inbound messages are validated and reduced to necessary fields before a durable receipt is inserted. Conversation/message writes and receipt completion commit together. Unique constraints deduplicate messages. Failures retain a safe error code and can be retried by the worker up to three times. If persistence fails, the active listener is stopped and the channel shows an error rather than continuing silently. A database outage before receipt insertion or an offline/disconnected listener can cause gaps: the unofficial API supplies no verified durable replay guarantee here.

## Supported scope and upstream APIs

The adapter was checked against the installed `zca-js` 2.2.0 declarations, README, and implementation on November 5, 2026. It calls `new Zalo({ selfListen: true, logging: false, checkUpdate: false })`, `loginQR`, `login`, `listener.on('message')`, `listener.start({ retryOnClose: false })`, `listener.stop()`, `getOwnId`, `getContext`, `getCookie`, and `sendMessage({ msg }, threadId, ThreadType.User)`.

The QR callback contains image/state events; restorable credentials come from `GotLoginInfo`. These remain private to the worker. The library's QR expiry is 100 seconds. No undocumented OA endpoint is used for personal accounts.

Supported: new one-to-one text, image, sticker and `chat.gif` messages, self-sent messages when emitted, personal text replies, encrypted session restore, and existing OA browsing. Media is reduced to its type, HTTP(S) URL/preview, caption and optional sticker ID before the durable receipt is stored. Unknown message types retain a placeholder; groups are ignored. Media sending, full history import, contact discovery, automatic replies, and mass sending are not implemented. Upstream web behavior can change without notice.

Photos render inline and link to the original file. On image failure, the UI tries the supplied preview, then shows an explicit unavailable-image message and original link. Stickers render as transparent images outside the usual message bubble. When a sticker event supplies only an ID, the worker stores the message first and resolves its image through `getStickersDetail` independently; a bounded session cache keeps the resulting URLs. The UI refreshes through `message.updated`. Remote media may expire or become unavailable; URLs are retained rather than copying or rehosting files.

Older personal receipts stored by the text-only implementation discarded attachment fields. On session establishment, a bounded repair reads one recent user-message page through `listener.requestOldMessages(ThreadType.User)`/`old_messages` only when up to 50 saved unsupported messages need repair. At most 200 returned events are considered. Only an existing message with matching channel, external ID, thread and direction is updated; unrelated history is never imported. Repaired receipts retain the normalized attachments and the current conversation preview is updated without replacing newer text. Generation checks prevent a response after disconnect from altering the saved history. Recovery is limited to media still available in that recent page; older discarded attachments may need to be resent. No full-history guarantee is made.

## Automated and manual verification

```bash
pnpm test
pnpm lint
pnpm build
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/zalo_inbox_test pnpm test:integration
```

Use a dedicated database whose name ends in `_test`; the integration suite applies migrations and deletes its test rows. It mocks the adapter for business tests and mocks ZCA methods for adapter-boundary tests. It requires no real Zalo credentials or QR scan. Tests cover QR transitions, owner checks, encryption, inbound/self-echo deduplication, transactional dispatch, duplicate outbound requests, ambiguous send failures, restoration, cancellation, competing workers, SSE filtering, and the OA regression suite.

Manual end-to-end checklist (requires your own account and explicit phone confirmation):

1. Start PostgreSQL, apply migrations, and start API/worker/web.
2. Log in to the web app and connect Zalo Personal by scanning and confirming its QR.
3. Send a text from a second account; verify one stored incoming bubble and live inbox update.
4. Reply from the web composer; verify status and receipt on the other phone.
5. Repeat the same request/idempotency key; verify no additional external send.
6. Send from another device for the connected account; verify its self-sent bubble when emitted.
7. Restart only the worker; verify restoration without scanning a fresh QR when credentials remain valid.
8. Disconnect; verify no active listener, no encrypted credentials, and retained conversation history.
9. Confirm the existing OA connection page and OA inbox still work independently.

Live scanning and real personal-message delivery cannot be established by mocked tests. They require manual verification; do not interpret a generated QR alone as proof of successful account connection or delivery.

Local runtime verification also generated a real PNG QR through the running worker and successfully cancelled that attempt. No QR was scanned and no live personal message was sent or received during that verification.
