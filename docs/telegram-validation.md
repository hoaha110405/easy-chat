# Báo cáo tích hợp Telegram vào easyChat

Ngày kiểm chứng: 2026-11-07. Hai channel `TELEGRAM_BOT` và `TELEGRAM_PERSONAL` đã được triển khai trong repository hiện có. Chưa đăng nhập hoặc gửi tin Telegram thật: môi trường chưa có API ID/API Hash/Bot Token. Kiểm thử hành vi Telegram dùng response chính thức giả lập tại ranh giới HTTP/TDLib; kiểm chứng native dùng thư viện TDLib thật ở chế độ offline.

## Kiến trúc được dùng lại

NestJS API và một PersonalWorker hiện có; ChannelAccount, Conversation, Message; CryptoService AES-256-GCM; PostgreSQL PersonalCommand outbox, WebhookEvent receipts; admin session/Origin guard; SSE qua PostgreSQL NOTIFY sau commit. Dự án hiện tại không dùng Redis/BullMQ nên tích hợp tiếp tục dùng outbox PostgreSQL, giữ lease advisory lock chống nhiều worker.

Bot gọi HTTPS trực tiếp tới `api.telegram.org`. Telegram cá nhân dùng một bridge C++ riêng cho mỗi account gọi **JSON/C của TDLib chính thức**; không thêm Telegram SDK bên thứ ba hay tự viết MTProto. API chuyển bước auth qua Unix socket 0600, có chữ ký HMAC, nonce và hạn thời gian; không khởi tạo client native theo HTTP request. Worker giữ phiên dài hạn, xử lý update tuần tự và khôi phục từ thư mục bền vững/khóa cũ.

OTP/2FA chỉ tồn tại trong yêu cầu đang xử lý và bộ nhớ TDLib, không ghi vào outbox, receipt, DB ứng dụng, log hay React Query mutation cache. Admin session khởi tạo ràng buộc phiên xác thực dang dở tối đa 10 phút. Dữ liệu TDLib tách theo account, database mã hóa bằng khóa riêng, khóa mã hóa lại bằng CryptoService. Native crash được cô lập khỏi NestJS API; graceful shutdown chờ giao dịch update hoàn tất.

## Files tạo mới

| Nhóm          | Files                                                                                                                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telegram Bot  | `apps/api/src/modules/telegram-bot/telegram-bot.client.ts`                                                                                                                                                                                            |
| TDLib cá nhân | `apps/api/src/modules/telegram-personal/tdjson.client.ts`, `tdlib.manager.ts`, `tdlib.mapper.ts`                                                                                                                                                      |
| Runtime/API   | `apps/api/src/modules/telegram/telegram.types.ts`, `telegram.config.ts`, `telegram.rpc.ts`, `telegram-receipts.service.ts`, `telegram.service.ts`, `telegram.worker.ts`, `telegram-runtime.module.ts`, `telegram.module.ts`, `telegram.controller.ts` |
| Native        | `native/telegram/bridge.cpp`, `CMakeLists.txt`, `build-tdlib.sh`, `Dockerfile`, `smoke.py`, `.dockerignore`                                                                                                                                           |
| Shared/UI     | `packages/shared/src/schemas/telegram.ts`, `apps/web/src/pages/telegram-connection.tsx`                                                                                                                                                               |
| Tests         | `apps/api/test/telegram.spec.ts`, `telegram.integration.spec.ts`, `apps/web/src/pages/telegram-connection.spec.tsx`                                                                                                                                   |
| Migrations    | `20261107010000_telegram_channels`, `20261107020000_telegram_receipts_index`                                                                                                                                                                          |
| Docs          | `docs/telegram-setup.md`, `telegram-api-research.md`, `telegram-validation.md`                                                                                                                                                                        |

Files hiện có được mở rộng: API AppModule/config; PersonalModule/PersonalWorkerModule/PersonalService/PersonalWorker; ChannelSyncController/FacebookPageModule; InboxService/MessageStore/channel-policy; Prisma schema và package scripts; shared API/channel schemas/index; web routes/provider catalog/ProviderMark/SSE/inbox/details; env examples/turbo/gitignore/prettierignore/Vite file-access deny list và README. Các thay đổi TikTok và unread có trước trong working tree được giữ lại.

## API chính thức và native build

- Bot: getMe, setWebhook, getWebhookInfo, deleteWebhook, sendMessage. Webhook nhận message, edited_message, my_chat_member và kiểm tra header secret trước durable ACK. Không chạy getUpdates đồng thời.
- TDLib: td_create_client_id/td_send/td_receive/td_execute; setTdlibParameters; trạng thái và hàm auth chính thức; getMe, loadChats/getChats/getChat, getBasicGroup/getSupergroup, getChatHistory/getMessage, sendMessage, logOut/close và update auth/chat/message/read/edit/delete/send-state.
- Native source khóa tại `4c6377aa7386c39217878a9a56d581922ad37ca4`; archive checksum trong [tài liệu research](telegram-api-research.md). Build thật trả version **1.8.69**, không có Git metadata trong archive (`commit_hash=GITDIR-NOTFOUND`). Runtime chỉ nhận version đã kiểm chứng, không giả định tương thích với bản cũ.
- Bridge C++17 biên dịch với cảnh báo thành lỗi; dynamic-load đúng libtdjson. Log TDLib và core dump bị tắt. Linux host build và JSON/C offline smoke đã chạy; Docker artifact build mới chuẩn bị, chưa thực thi.

## Migration dữ liệu

`20261107010000_telegram_channels`: bổ sung enum MessageSource.TELEGRAM; Message.editedAt/deletedAt nullable; ChannelAccount.rateLimitedUntil nullable. ChannelAccount.channelType vốn là string, không tạo lại model/ORM.

`20261107020000_telegram_receipts_index`: index WebhookEvent(channelAccountId,eventName), hỗ trợ tìm receipt/tombstone xóa theo account. Cả hai đã migrate deploy, không reset database và không xóa dữ liệu hiện có. ID Telegram lưu strings; compound key `chatId:messageId` dùng unique constraint theo account đã có. Không ép ID qua JavaScript number thiếu độ chính xác.

## Endpoint

Các đường dẫn có tiền tố `/api`:

| Method/path                                      | Công dụng/bảo vệ                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| GET `/channels/telegram-bot`                     | Trạng thái/cấu hình/bot của chủ phiên                                              |
| POST `/channels/telegram-bot/connect`            | Nhập token, xác minh bot, mã hóa, đăng ký/kiểm tra webhook                         |
| POST `/channels/telegram-bot/:id/verify-webhook` | Đối chiếu bot identity và URL webhook                                              |
| POST `/channels/telegram-bot/:id/webhook`        | Receipt durable; dùng Telegram secret header, không dùng admin cookie              |
| GET `/channels/telegram-personal`                | Trạng thái account và TDLib auth state đã làm sạch                                 |
| POST `/channels/telegram-personal/connect`       | Tạo phiên, hoặc reconnect với accountId thuộc chủ phiên                            |
| POST `/channels/telegram-personal/:id/auth`      | phone/code/password/email/email_code/qr, đúng auth state và admin session khởi tạo |
| POST `/channels/:id/sync`                        | Queue sync account; Bot chỉ kiểm tra webhook, không giả lịch sử                    |
| POST `/conversations/:id/sync`                   | Queue tiếp lịch sử Telegram cá nhân từ checkpoint                                  |
| DELETE `/channels/:id`                           | Logout/deleteWebhook, dọn credential/session, giữ lịch sử easyChat                 |

Dùng lại endpoint đọc account/conversation/message, gửi/retry text, đánh dấu đọc cục bộ và SSE. Tất cả thao tác quản trị giữ AdminGuard, owner và Origin validation. Webhook giữ secret riêng. Auth values đi qua IPC, không lưu vào PersonalCommand.

## Env và cách chạy

Biến mới: TELEGRAM_PERSONAL_ENABLED, TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_BOT_ENABLED, TELEGRAM_BOT_WEBHOOK_BASE_URL, TELEGRAM_TDLIB_BRIDGE_PATH, TELEGRAM_TDJSON_LIBRARY, TELEGRAM_DATA_DIR, TELEGRAM_RPC_SOCKET. Token Bot lưu mã hóa từng account, không dùng global token env hay Vite secret.

Hướng dẫn từng bước, native prerequisites, Linux/Docker/runtime volume, cổng webhook và commands: [telegram-setup.md](telegram-setup.md). Quy trình chính:

```bash
bash native/telegram/build-tdlib.sh
python3 native/telegram/smoke.py
pnpm --filter @zalo/shared build
pnpm --filter @zalo/api db:generate
pnpm --filter @zalo/api db:deploy
pnpm dev
```

Bổ sung config backend rồi chọn **Ứng dụng → Telegram → Cá nhân/Bot**. Trong inbox có cùng bộ lọc tài khoản/kênh; Thông tin hội thoại → Đồng bộ lịch sử Telegram tiếp tục history cá nhân khi cần.

## Kiểm thử thực thi

| Nhóm                                                        | Kết quả                                                                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                                                 | API/shared/web lint + typecheck pass                                                                                                  |
| `pnpm test`                                                 | API 154, web 44, shared 2: **200 pass**                                                                                               |
| `TEST_DATABASE_URL=…/zalo_inbox_test pnpm test:integration` | DB 15, Zalo 27, Facebook 23, TikTok 24, unread 11, Telegram 24: **124 pass**                                                          |
| Tổng                                                        | **324 tests pass**, trong đó Telegram mới 29 unit + 24 integration + 9 UI                                                             |
| Build                                                       | shared CJS/ESM; API và worker tsc outDir riêng trong `/tmp/easychat-telegram-validation`; web TypeScript + Vite production build pass |
| Schema/format                                               | Prisma validate, migrate deploy, Prettier check, git diff whitespace check pass                                                       |
| Native thật                                                 | Build official libtdjson + bridge, version 1.8.69, authorizationStateWaitTdlibParameters, close exit 0                                |

Build API/worker thực thi với tsconfig kế thừa cấu hình thật và outDir tạm, tránh xóa dist mà dev watcher đang sử dụng. Không dùng browser automation; UI kiểm thử bằng React Testing Library/JSDOM. Integration chỉ dùng database riêng có tên kết thúc `_test`. Các lỗi được chủ động giả lập trong test (401/403/429/5xx, native crash, database lỗi) không phải lỗi production được bỏ qua.

## Hành vi đã xác minh bằng mock + PostgreSQL thật

- Bot: getMe/token/username, fixed official HTTP host, webhook header/durable receipt/dedupe, ID lớn và message_id trùng giữa các chat, edit, outbound idempotency, safe ACK, 401 reauth, 403 chat permission, 429 defer, timeout/5xx UNKNOWN, webhook disconnect, owner/origin/session và SSE IDs-only sau persistence.
- Cá nhân: phone → code → 2FA → Ready/getMe; email/email-code; gắn admin session/expiry; mã xác thực không có trong credential/outbox/receipt; storage 0700, key 32 byte; cùng khóa khi khôi phục nhiều account, một client mỗi account/generation.
- Cloud chat/history: load main/archive kết thúc theo 404, history cursor phân trang và dedupe, chat riêng/nhóm/supergroup, kiểm tra own admin rights, realtime incoming và outgoing từ thiết bị khác, sửa/xóa vĩnh viễn, chống resurrect từ history, không xem cache eviction như xóa thật.
- Read: unread provider và local riêng; watermark private chỉ xác nhận tin đi tương ứng; không dựng group per-message readAt; không gọi viewMessages/openChat trong sync.
- Send/restart: giữ SENDING khi TDLib message pending, chờ actual send-success update, compound ACK, SENDING → UNKNOWN khi restart, nhận ACK muộn đối chiếu temp ID, không gửi lại UNKNOWN, cô lập crash, logout xác nhận và cleanup chưa xác nhận có phản hồi khác nhau.
- UI: cấu hình thiếu hiển thị thật và vô hiệu hóa connect, đúng form phone/code/2FA/email/email-code/device confirmation, chỉ link tg://login hợp lệ, clear input và không cache OTP/2FA, Bot connect/verify/disconnect, inbox hiện sender/edit/delete/unread và nút tiếp tục history.

## Giới hạn còn lại

Chưa live-authorize Telegram cá nhân, live-connect bot, nhận webhook Internet hoặc gửi tin thật; cần thông tin ứng dụng của người dùng và HTTPS public. Native offline smoke không thay thế live smoke.

MVP gửi text; chưa tải media/avatar Telegram hoặc gửi attachment. Bot API không có arbitrary personal inbox/history. Secret Chats, broadcast channels và forum/topic sending ngoài phạm vi. ReadAt cho nhóm không được suy diễn. TDLib schema khóa không có WaitPasskey; optional WebAuthn passkey không triển khai tại origin easyChat; Premium/registration hoàn tất ở ứng dụng Telegram chính thức. Docker build chưa chạy và phải build artifact cùng ABI/architecture với runtime.

History chia 25 tin/trang, tối đa 100 trang mỗi lượt và checkpoint tiếp tục theo hội thoại; toàn bộ lịch sử còn phụ thuộc quyền truy cập thực tế của Telegram. Giữ tombstone delete receipt khi áp dụng retention. TDLib có thể tự tiếp tục internal pending send sau reconnect; easyChat không POST lại intent UNKNOWN. Khi không xác nhận được remote logout, UI yêu cầu kiểm tra Telegram Settings → Devices.

Nguồn chính thức và các hợp đồng được đối chiếu: [telegram-api-research.md](telegram-api-research.md).

## Kiểm tra dev sau khi khởi động lại

Một nhóm `pnpm dev` đang chạy tại `http://localhost:5173`, API cổng 3000; PostgreSQL xác nhận đúng một advisory worker lease. HTTP status của cả Telegram Bot và Telegram cá nhân trả `enabled=true`, `configured=false`, `nativeAvailable=true`, `workerOnline=true`, 0 tài khoản Telegram, đúng với môi trường chưa thêm credentials. Unix socket có mode 0600. Request HTTP trực tiếp tới artifact `.local` bị Vite từ chối 403.

Snapshot trước/sau restart giữ 11 hội thoại, 30 tin nhắn và hai tài khoản Zalo cá nhân với trạng thái DISCONNECTED/CONNECTED như trước. Không đưa dữ liệu Telegram giả vào database dev và không đánh dấu các tin đang có thành đã đọc để kiểm thử.
