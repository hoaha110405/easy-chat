# Facebook Page API verification

Checked 5 November 2026. This adapter uses Meta's official HTTP APIs; it does not install a Facebook SDK or use a shared static Page token.

## Version

The implementation pins `FACEBOOK_GRAPH_API_VERSION=v26.0`. Meta's own maintained [Node Business SDK API class](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/api.js) declares `VERSION = v26.0`; its [Java SDK configuration](https://github.com/facebook/facebook-java-business-sdk/blob/main/src/main/java/com/facebook/ads/sdk/APIConfig.java) independently declares the same default. These verify that v26.0 is a current supported version. The [Graph versions table](https://developers.facebook.com/docs/graph-api/changelog/versions/) and [v26 changelog](https://developers.facebook.com/docs/graph-api/changelog/version26.0/) could not be retrieved by the research tool, so no release/sunset dates are asserted. Review those pages when upgrading; the env setting is deliberately explicit.

## Authorization and access

The backend exchanges the actual Facebook Login code at `/{version}/oauth/access_token`, optionally exchanges the resulting user token for a long-lived user token, checks `/me/permissions`, and lists `/me/accounts`. The latter yields Page IDs, Page access tokens and task grants; Page tokens stay in the backend. Meta's official [Get Access Tokens of Pages You Manage](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-1ff01566-3509-48bd-a0f4-8571a91ccfdf) demonstrates this common Page-token edge and its `tasks` result. OAuth/state/storage are the service layer's responsibility; [Meta's server-side Login flow](https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/) remains the setup reference.

Request `pages_show_list`, `pages_messaging`, `pages_manage_metadata`, and `pages_read_engagement`; verify the actual grants, token application identity, selected Page target, and Page messaging task before connecting. Never infer granted permissions from the OAuth URL. The token inspection DTO exposes actual scopes, granular Page targets, expiry, app ID and validity for those checks.

Meta's [Conversations API collection](https://www.postman.com/meta/messenger-platform-api/folder/22794852-255610cd-47f5-4f4d-b3fa-71aec360be9a) lists the metadata/engagement/messaging grants, Page task requirements, and Advanced Access for conversations involving people without a role on the app or business. App Review and any Business Verification required by the app's dashboard must be completed for that production access. Development mode and role-limited tests do not establish public availability.

## HTTP contracts

Every URL is built from `https://graph.facebook.com/{configured-version}/` and a validated ID. Page/PSID strings are preserved exactly. User-token calls use that user token; Page calls use that Page's token.

| Operation               | Endpoint / requested fields                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| Managed Pages           | `GET /me/accounts?fields=id,name,access_token,tasks,picture{url}`                                           |
| Page identity           | `GET /{page-id}?fields=id,name,picture{url}`                                                                |
| Subscribe               | `POST /{page-id}/subscribed_apps` with `subscribed_fields`                                                  |
| Disconnect subscription | `DELETE /{page-id}/subscribed_apps`                                                                         |
| Threads                 | `GET /{page-id}/conversations?platform=messenger&fields=id,updated_time,participants,message_count,snippet` |
| History                 | `GET /{conversation-id}/messages?fields=id,created_time,from,to,message,attachments`                        |
| PSID profile            | `GET /{psid}?fields=id,first_name,last_name,profile_pic`                                                    |
| Text reply              | `POST /{page-id}/messages`, `recipient.id=PSID`, `messaging_type=RESPONSE`, `message.text`                  |

The maintained [Page SDK model](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/page.js) verifies the conversations/subscribed-apps edges and webhook field spellings. Subscribe to `messages`, `messaging_postbacks`, `message_echoes`, `message_deliveries`, and `message_reads`. The [official Messenger sample](https://github.com/fbsamples/original-coast-clothing/blob/main/services/graph-api.js) also demonstrates subscribing individual Pages. App-level webhook callback configuration is a separate Meta dashboard step.

The [UnifiedThread SDK model](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/unified-thread.js) verifies `updated_time`, `participants`, `message_count`, `snippet`, and its `/messages` edge. History and profiles may be unavailable due to permissions/privacy; the integration must surface partial sync, never promise every historical conversation or avatar.

Cursor inputs are opaque `after` values with an explicit bounded `limit` of 1–100. The adapter returns a next cursor only when Meta indicates a next page and the cursor advances. A missing/repeated cursor despite a next page is an explicit error, preserving an incomplete checkpoint instead of claiming synchronization finished. It never follows or exposes `paging.next`, which may contain credentials. No undocumented `since` filter is sent; services perform bounded cursor scans and deduplicate by account/message ID.

## Messaging policy

Meta's current [Messenger Send API collection](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api?entity=request-22794852-31d80e54-aa3d-4c64-9e01-14925626797e) requires `pages_messaging`, a suitable Page access token, and recipient contact within the previous 24 hours, unless a separately approved mechanism permits otherwise. This implementation supports ordinary `RESPONSE` replies only. It supplies no message tags, paid/marketing permissions, opt-in substitutes, or human-agent exceptions. The service must reject sending outside the verified window both before queuing and immediately before execution. Page echoes, delivery/read notifications and Page replies do not reopen the window. See [Meta's policy overview](https://developers.facebook.com/docs/messenger-platform/policy/policy-overview/) when expanding capabilities; that direct page was rate limited during this audit.

## Adapter safety and verification limits

Authorization uses Bearer headers plus HMAC-SHA256 `appsecret_proof`, following [Meta's session implementation](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/session.py). Secrets needed by OAuth/token inspection remain server-only. The client does not log requests, raw responses, provider messages, or original transport exceptions. Normalized errors retain safe numeric codes only.

Requests have a 10-second timeout plus abort deadline, bounded response/body sizes, disabled redirects, and no automatic retries. Explicit structured Graph rejections are definite failures; transport loss, unstructured HTTP failure, wrong-recipient acknowledgements, and malformed send acknowledgements are ambiguous and cannot be retried automatically. Read requests can be retried by a bounded worker policy. HTTPS attachment/profile URLs are normalized and not fetched by this adapter; unsafe schemes, credentials, local/IP hosts and token-bearing URLs are removed.

Mocked HTTP contract tests cover OAuth exchanges, scopes, Page selection data, appsecret proof, subscriptions, cursors, history/media normalization, identity checks, exact PSID sending, rejection classification and lost acknowledgements. Live OAuth, Page access, webhook delivery and Meta App Review still require a real configured Meta app/Page; mocked tests do not claim that external approval or live end-to-end verification occurred.
