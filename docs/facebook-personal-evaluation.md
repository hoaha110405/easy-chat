# Facebook Personal compatibility evaluation

Reviewed on **2026-11-05** for easyChat's NestJS/CommonJS API, separate Node.js
worker, PostgreSQL inbox/outbox and existing encrypted credential storage. The
workspace currently runs Node.js 26.12.1; its minimum supported version is 22.12.0.

**Decision:** ship the `FACEBOOK_PERSONAL` capability boundary as `UNSUPPORTED`.
No unofficial package was added to the workspace. No personal Facebook login,
cookie import, message listener, history synchronization or send is presented as
working. This follows the request's explicit unsupported fallback; Facebook Page
remains an independent official integration.

## Evidence and candidate comparison

Public npm metadata and the exact published package archives were inspected as
text. No downloaded library or install script was executed. A declared Node
engine is not proof that login, native components or messaging work on this
runtime. None of the candidates was tested using a real Facebook account.

| Candidate                                                 | Verified evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Decision for this implementation                                                                                                                                                                                                                            |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@dongdev/fca-unofficial` **4.0.3**, published 2026-04-11 | Published metadata declares Node >=14, TypeScript declarations, CJS/ESM and Apache-2.0. Its documented cookie/AppState authentication, MQTT listener, thread list/history and send methods are legacy browser-session APIs. No end-to-end encrypted receive/send guarantee was verified. Dependencies include native SQLite. Configuration also exposes optional external authentication, remote management and automatic updates; those require explicit review and must stay off in an easyChat adapter. | Not selected: documented classic messaging alone does not establish usable personal Messenger access or complete encrypted-chat coverage.                                                                                                                   |
| `facebook-chat-api` **1.8.0** / legacy FCA baseline       | The upstream repository was archived on 2022-07-09. Its maintainer explicitly describes instability for serious applications. Package metadata declares Node >=4, MIT and legacy dependencies including `request`; the README documents AppState reuse and classic listening/history/sending. No current E2EE implementation was verified.                                                                                                                                                                 | Not selected. A similarly named fork must be independently reviewed; inheritance of this API is insufficient evidence of compatibility.                                                                                                                     |
| `messagix-js` **0.1.0**, published 2026-01-19             | Registry metadata declares Node >=18, TypeScript/CJS/ESM and AGPL-3.0-or-later, with no repository link. Published source contradicts the advertised E2EE completeness: `E2EEClient.sendMessage()` throws **“E2EE message sending not yet implemented”**; device registration and handshake are unfinished. Ordinary MQTT thread/history/send methods exist, but do not establish encrypted-chat support. Default logging also refers to an undeclared `pino-pretty` transport.                            | Rejected for this task: verified missing E2EE implementation. Cookies and a PIN do not remedy missing protocol code.                                                                                                                                        |
| `meta-messenger.js` **1.1.3**, published 2026-02-17       | Declares Node >=22.12, TypeScript and AGPL-3.0-or-later. The repository documents cookie authentication and E2EE through a Go/FFI bridge, and was archived on 2026-08-20. The npm package has a postinstall script for native bridge preparation/download and uses `koffi`.                                                                                                                                                                                                                                | Not selected: a maintained, reviewed bridge build, session/device persistence design and actual runtime interoperability have not been established.                                                                                                         |
| `fb-messenger-e2ee` **0.1.8**, published 2026-09-24       | A newer E2EE-focused TypeScript library, AGPL-3.0-or-later, with CJS/ESM artifacts and Bun development scripts. Dependencies include native `@signalapp/libsignal-client` and an unpinned GitHub FCA dependency. Its docs require a persistent device store containing cryptographic identity/session state, separate from AppState. No Node engine is declared in published metadata.                                                                                                                     | Candidate for a later compatibility spike, not a verified easyChat adapter. Secure storage of mutable device state, dependency pinning/review, Node native compatibility, restart recovery, accessible history and real two-way delivery remain unverified. |

Primary references, including versioned published artifacts:

- FCA: [published 4.0.3 metadata](https://registry.npmjs.org/@dongdev%2ffca-unofficial/4.0.3), [published package](https://registry.npmjs.org/@dongdev/fca-unofficial/-/fca-unofficial-4.0.3.tgz), [source and API documentation](https://github.com/donyst/fca-unofficial).
- Legacy FCA: [upstream repository and archive notice](https://github.com/Schmavery/facebook-chat-api), [package metadata](https://raw.githubusercontent.com/Schmavery/facebook-chat-api/master/package.json).
- messagix-js: [published 0.1.0 metadata](https://registry.npmjs.org/messagix-js/0.1.0), [published package source](https://registry.npmjs.org/messagix-js/-/messagix-js-0.1.0.tgz). Inspect `package/dist/index.mjs`, `E2EEClient.sendMessage`, `sendHandshake` and `E2EERegistration.registerDevice`; these are implementation evidence rather than README claims.
- Meta Messenger bridge: [upstream documentation and archive notice](https://github.com/yumi-team/meta-messenger.js), [published 1.1.3 metadata](https://registry.npmjs.org/meta-messenger.js/1.1.3).
- New E2EE candidate: [source/documentation](https://github.com/HerokeyVN/FB-Messenger-E2EE), [published 0.1.8 metadata](https://registry.npmjs.org/fb-messenger-e2ee/0.1.8).

This is a compatibility decision for this implementation, not a claim that every
unofficial client is unusable or that a dependency is malicious. New releases
need a new evaluation; changing a feature flag does not complete that evaluation.

## Implemented API and application boundary

All routes use the existing administrator authentication and mutation-origin
guard. They return no account identifiers or credentials.

| Route, under `/api`                            | Behavior                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /channels/facebook-personal/status`       | Returns the experimental status below.                                                            |
| `GET /channels/facebook-personal/capabilities` | Alias of the same status.                                                                         |
| `POST /channels/facebook-personal/connect`     | HTTP 501, `FACEBOOK_PERSONAL_UNSUPPORTED`. Does not read a request body or create an account/job. |
| `POST /channels/facebook-personal`             | Same explicit unsupported result for conceptual account creation.                                 |

```json
{
  "data": {
    "enabled": false,
    "status": "UNSUPPORTED",
    "experimental": true,
    "reasonCode": "FACEBOOK_PERSONAL_UNSUPPORTED",
    "message": "Chưa có thư viện Messenger cá nhân được kiểm chứng cho phiên bản hiện tại. Kết nối, đồng bộ, nhận và gửi tin nhắn đang không được hỗ trợ; bao gồm hội thoại mã hóa đầu cuối (E2EE).",
    "capabilities": {
      "connect": false,
      "listConversations": false,
      "history": false,
      "receive": false,
      "sendText": false,
      "e2ee": false
    },
    "library": null
  }
}
```

`FACEBOOK_PERSONAL_ENABLED=false` is the default. Setting it to `true` changes the
configuration indicator only: no reviewed driver exists, so `status` remains
`UNSUPPORTED` and every operational capability stays false. The frontend must
use capabilities, not the flag, to enable actions.

The adapter contracts separate session provisioning, conversation sync,
listening and sending. All external IDs remain strings. The supplied unsupported
adapter never starts a client, stores a session, registers a callback, emits
messages or returns an invented message ID/empty synchronized history. Connection
and restoration fail explicitly; cleanup is idempotent. No worker restoration,
reconnect timer or personal queue is enabled. E2EE capability assertions use the
specific `FACEBOOK_PERSONAL_E2EE_UNSUPPORTED` code. Errors never interpolate a
session, thread ID, cursor or message body and are not automatically retryable.

There is deliberately no password, cookie, AppState, PIN, QR or personal OAuth
onboarding form. An unsupported connection cannot create a fake connected
account. No second inbox, persistence layer or ORM was introduced.

## Validation and manual acceptance

Run the focused provider-boundary tests from the workspace root:

```sh
pnpm --filter @zalo/api exec vitest run test/facebook-personal.spec.ts
```

Tests verify flag-independent unsupported capabilities, failed connect/restore
and restart behavior, listener cleanup/no callbacks, rejected history/sends,
non-retryable redacted errors and HTTP error construction. They do not simulate
incoming-message normalization or delivery: those operations are unavailable.

For a manual check, start the existing API/web/worker using the repository's
normal development command, sign in, and open Messenger Personal in the
connection catalog. Verify an experimental unsupported notice and no credential
input. Inspect the authenticated status request: all capabilities must be false.
If testing the connect API directly with the existing administrator session and
valid Origin, expect HTTP 501; confirm no account or job was created. Unauthenticated
requests must fail authentication. Repeat with the feature flag enabled: the
unavailable integration must still never report `CONNECTED` or allow sending.

There is **no claimed live personal Messenger end-to-end test**. Before enabling a
future driver, verify locally controlled authentication without passwords,
authenticated identity ownership, encrypted mutable device/session persistence,
controlled reauthentication and listener ownership, real incoming/self messages,
correct thread routing, restart recovery and ambiguous-send handling. Verify
accessible E2EE/history coverage explicitly; neither an empty page nor a socket
connection proves a full synchronization.
