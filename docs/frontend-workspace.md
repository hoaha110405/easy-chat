# easyChat frontend workspace

The frontend is a provider-neutral workspace. `/inbox` contains the unified conversation view; `/apps` is the application catalog and account manager. Existing setup URLs `/personal` and `/connection` remain valid, including OA OAuth redirects.

## Adding an application

`apps/web/src/lib/channels.ts` is the UI registry for provider names, categories, availability, colors, channel labels, and settings routes. The catalog, account identity labels, sidebar links, and conversation details read from this registry. `ProviderMark` supplies a common icon container. Unknown channel types use a neutral fallback instead of being labeled as Zalo.

Implemented channels are Zalo Personal, Zalo OA, Facebook Page, TikTok Business, TikTok Shop, Telegram Bot, Telegram Personal and WhatsApp Business. Each channel requires its own credentials and provider permissions before live use. Messenger Personal remains unsupported; Instagram and Email remain planned. See the [configuration guide](cau-hinh.md) for setup and the [media capability matrix](media-attachments.md) for attachment limits.

Before enabling another provider, implement its backend authentication/adapter, owner-scoped account and conversation access, public shared schemas, and matching API account keys. Then add its channel definition and settings route, and mark its provider entry available. The registry describes presentation; it does not replace the backend integration.

## Inbox behavior

- Account filtering still uses the server's `account` query parameter before pagination. The URL preserves the selected account on reload and when returning from a conversation. Changing account closes the old chat and composer.
- The account selector identifies each account by avatar, provider, type and external ID. Conversation rows show the receiving account without repeating long identifiers. The reply area repeats the sending identity; the details panel exposes complete account and contact identifiers, clipboard copy, channel status and thumbnails from loaded messages.
- Search includes the contact name/ID, account name/ID and latest message preview within loaded conversations. Pagination remains available. Conversation counts represent saved conversations, not unread counts.
- Enter submits a message; Shift+Enter inserts a line break; composing input is not submitted. Existing idempotency and uncertain-delivery checks are retained. Images, stickers and self-sent events keep the existing renderer and persistence behavior.
- The inbox defaults to a 64px navigation rail on desktop, with a toggle to restore the full sidebar. A single compact toolbar keeps account selection and the expand action visible. Settings pages retain the full navigation.
- **Phóng to hội thoại** uses the complete workspace by hiding the outer header and navigation. It retains the active conversation and composer draft; `focus=1` in the URL survives reload and account filtering. **Thu nhỏ hội thoại** restores the normal layout.
- Conversation and message panes scroll independently. Scrolling near the end of the list requests the next saved-conversation page; scrolling to the top of the chat requests an earlier message page and preserves the reading position. Explicit load buttons remain available. This loads stored local history and does not add a remote-history import.
- Below the medium-screen breakpoint, the list and active chat occupy separate views. Tablet and desktop layouts display both panes. The mobile header is compact and the bottom navigation hides during a chat. Resize and image-load handling keep the viewport anchored when the reader was at the latest message.

## Loading and validation

Connection setup and the application catalog are lazy-loaded behind the persistent workspace shell. Account lists share the same React Query cache and a short stale time, avoiding repeated immediate fetches during navigation. Existing SSE invalidation and polling remain in place.

The interface uses Vietnamese labels and date formatting, explicit connection states, keyboard focus styles, accessible filter controls, and a skip link. Future-application controls remain disabled and are distinct from a disconnected but supported account.

Run `pnpm --filter @zalo/web test`, `pnpm --filter @zalo/web lint`, and `pnpm --filter @zalo/web build`. Tests cover account switching, retained delivery safeguards, Enter/Shift+Enter/IME behavior, the contact-details panel, application filtering and disabled planned providers, authentication and the existing Zalo setup flows. Inspect desktop, tablet and phone layouts in a browser before shipping visual changes.
