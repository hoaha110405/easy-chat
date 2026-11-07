# Báo cáo tích hợp WhatsApp Business Cloud API

Ngày kiểm chứng: **2026-11-07**. Phần triển khai và kiểm thử tự động đã hoàn tất. **Chưa xác minh gửi/nhận qua tài khoản Meta thật**, vì môi trường chưa có thông tin ứng dụng/token WhatsApp.

## 1. Kiến trúc hiện có

Giữ nguyên monorepo pnpm/Turbo: NestJS API, React/Vite frontend, shared Zod schemas và PostgreSQL/Prisma. WhatsApp dùng ChannelAccount, Conversation, Message, WebhookEvent, PersonalCommand outbox, một PersonalWorker chung với advisory lease và SSE theo owner. Không thêm Redis, queue server hoặc inbox riêng.

## 2. Các file tạo và sửa

| Nhóm                    | File/đường dẫn chính                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend mới             | `apps/api/src/modules/whatsapp/whatsapp.{types,client,service,controller,webhook,worker,module,templates,media}.ts`                                                                                                                   |
| Schema/migration        | `apps/api/prisma/schema.prisma`, `prisma/migrations/20261107030000_whatsapp_cloud/migration.sql`                                                                                                                                      |
| Wiring/outbox/policy    | `app.module.ts`, `config/{env,config.service}.ts`, `zalo-personal/personal.{service,worker,module}.ts`, `personal-worker.module.ts`, `facebook-page/{channel-sync.controller,facebook-page.module}.ts`, `messaging/channel-policy.ts` |
| Inbox DTO/private media | `modules/inbox/inbox.service.ts`, shared `schemas/{api,facebook,whatsapp}.ts`, `packages/shared/src/index.ts`                                                                                                                         |
| Frontend mới            | `pages/whatsapp-connection.tsx`, `lib/whatsapp-signup.ts`, `features/inbox/whatsapp-templates.tsx`                                                                                                                                    |
| Frontend dùng chung     | `app.tsx`, `pages/{apps,inbox}.tsx`, `lib/{api,channels,utils}.ts`, `components/provider-mark.tsx`, `features/inbox/{account-filter,composer,conversation-details,message-attachment}.tsx`, `hooks/use-realtime.ts`                   |
| Kiểm thử                | `apps/api/test/whatsapp{,.integration}.spec.ts`; web `pages/whatsapp-connection.spec.tsx`, `lib/whatsapp-signup.spec.tsx`, `features/inbox/whatsapp-media.spec.tsx`; cập nhật apps test và script integration                         |
| Cấu hình/tài liệu       | Hai `.env.example`, `turbo.json`, README, `docs/whatsapp-{api-research,setup,validation}.md`                                                                                                                                          |

Các phần Zalo, Facebook, TikTok, Telegram và unread có sẵn trong working tree được giữ lại. Không tạo commit hay triển khai production.

## 3. API Meta chính thức

Graph mặc định v27.0, cấu hình độc lập Facebook Page. Dùng debug_token, WABA/phone identity và membership, phone registration với PIN do operator cung cấp, app/WABA subscriptions, messages, templates, media upload/download và official JavaScript SDK Embedded Signup v4. Không dùng WhatsApp Web, personal session, QR login hoặc gateway không chính thức.

Nguồn và hợp đồng: [bản đối chiếu API](whatsapp-api-research.md). Các trang media/document/audio được đọc trực tiếp từ domain Meta qua HTTPS; có kiểm thử HTTP multipart bằng server localhost, không gửi tới Meta.

## 4. Migration

Migration cộng thêm `WHATSAPP` vào MessageSource; `DELIVERED`, `READ` vào DeliveryStatus; thêm ChannelAccount.providerMetadata JSONB mặc định `{}`. Không drop/reset bảng hoặc dữ liệu.

Đã kiểm tra migration trên database dev và database test: 9 migrations, schema up to date. Gửi tài liệu/âm thanh dùng metadata của Message hiện có, không cần migration thứ hai. Snapshot dev trước khi bật lại dịch vụ: 12 conversations, 33 messages, 0 WhatsApp accounts; các test chỉ dọn database `_test` có guard.

## 5. Endpoints

Tất cả có prefix `/api`. Trừ webhook công khai, các route yêu cầu admin session; mutation kiểm tra Origin, ownership và input.

| Method   | Route                                               | Mục đích                                                       |
| -------- | --------------------------------------------------- | -------------------------------------------------------------- |
| GET      | `/channels/whatsapp`                                | Trạng thái cấu hình, worker, account, phiên chọn số            |
| POST     | `/channels/whatsapp/connect`                        | Direct/test onboarding bằng token, WABA, phone ID, PIN nếu cần |
| POST     | `/channels/whatsapp/embedded/begin`                 | Tạo phiên single-use gắn owner/session                         |
| POST     | `/channels/whatsapp/embedded/complete`              | Đổi code ngay và giữ token selection mã hóa                    |
| GET      | `/channels/whatsapp/embedded/:id/phones?wabaId=...` | Liệt kê số token được quyền truy cập                           |
| POST     | `/channels/whatsapp/embedded/select`                | Chọn và xác minh số Cloud API                                  |
| GET      | `/channels/:id/templates`                           | Mẫu thật thuộc WABA, có phân trang                             |
| POST     | `/conversations/:id/send-template`                  | Mẫu APPROVED + biến + xác nhận consent                         |
| POST     | `/conversations/:id/whatsapp/media`                 | Multipart một tài liệu/âm thanh + idempotency key              |
| POST     | `/conversations/:id/whatsapp/read`                  | Queue thao tác báo đọc provider riêng                          |
| GET      | `/channels/whatsapp/messages/:id/media`             | Proxy media qua cookie/owner guard                             |
| GET/POST | `/webhooks/whatsapp`                                | Challenge / raw-body HMAC và receipt durable                   |

Dùng lại API messages/retry/disconnect/sync chung. Conversation sync trả rõ history không có; account sync chỉ kiểm tra kết nối.

## 6. Webhook subscriptions

Object `whatsapp_business_account`, field `messages` cho inbound và status; Embedded Signup cần thêm `account_update`; nên thêm `message_template_status_update`. Backend kiểm tra app callback active/đúng URL, rồi POST/GET WABA subscribed_apps trước CONNECTED.

Challenge dùng verify token; POST kiểm tra HMAC-SHA256 raw bytes bằng App Secret trước parse. Receipt persist trước ACK; worker xử lý có dedupe, retry giới hạn, WABA/phone/owner routing. Status không hạ READ/DELIVERED vì event muộn. Callback mỗi lần gửi có UUID riêng, ngăn status cũ ghi đè lần retry mới.

## 7. Biến môi trường

`WHATSAPP_ENABLED`, `WHATSAPP_GRAPH_API_VERSION`, `WHATSAPP_META_APP_ID`, `WHATSAPP_META_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_WEBHOOK_CALLBACK_URL`, `WHATSAPP_EMBEDDED_SIGNUP_ENABLED`, `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID`.

Dùng lại DATABASE_URL, TOKEN_ENCRYPTION_KEY, SESSION_SECRET, FRONTEND_URL. Access token nhập ở form admin và mã hóa riêng từng account; không đưa token/secret vào frontend env. Embedded Signup bị khóa nếu thiếu cấu hình/HTTPS.

## 8. Thiết lập Meta Console

Thêm sản phẩm WhatsApp, lấy WABA/Phone Number ID và token được cấp đúng assets. Cấu hình HTTPS callback `/api/webhooks/whatsapp`, verify token và fields ở mục 6. Xác minh/đăng ký số; dùng PIN 6 chữ số của doanh nghiệp nếu cần. Test number chỉ gửi tới test recipient Meta cho phép.

Embedded Signup: hoàn tất điều kiện Tech Provider/Solution Partner, tạo cấu hình Facebook Login for Business/WhatsApp v4, HTTPS/allowed domains/redirect settings, Config ID và App Review phù hợp. Flag enabled không đại diện đã được Meta phê duyệt. [Hướng dẫn từng bước](whatsapp-setup.md).

## 9. Quyền cần có

`whatsapp_business_management` và `whatsapp_business_messaging`; token phải đúng app, còn hạn, truy cập được WABA/số. Không dùng Facebook Page token. `business_management` chỉ khi thao tác business portfolio bổ sung thực sự cần; MVP không yêu cầu quyền này vô điều kiện. Advanced Access, business/access verification và review phụ thuộc cách phân phối app/doanh nghiệp theo Meta.

## 10. Chạy API, worker và frontend

```bash
docker compose up -d postgres
pnpm --filter @zalo/shared build
pnpm --filter @zalo/api db:generate
pnpm --filter @zalo/api db:deploy
pnpm dev
```

Chỉ chạy một nhóm `pnpm dev`: frontend 5173, API 3000, một worker. Nhóm này đã gồm worker; không chạy thêm `dev:worker` cùng lúc. Không cần Redis trong kiến trúc hiện có. Giữ Compose project name/volume hiện tại.

## 11. Kiểm thử thực sự đã chạy

| Lệnh                                                          | Kết quả                                           |
| ------------------------------------------------------------- | ------------------------------------------------- |
| `pnpm lint`                                                   | PASS: ESLint + TypeScript API/web/shared          |
| `pnpm test`                                                   | PASS: 194 backend + 60 web + 2 shared = 256       |
| `TEST_DATABASE_URL=.../zalo_inbox_test pnpm test:integration` | PASS: 165 tests, 7 suites                         |
| `pnpm build`                                                  | PASS: shared, NestJS API và React/Vite production |
| `pnpm --filter @zalo/api exec prisma migrate status`          | PASS: 9 migrations, up to date                    |

Tổng **421 tests PASS**. Riêng WhatsApp: 40 backend unit/contract, 41 PostgreSQL/HTTP integration, 16 UI/SDK = 97. Regression bao gồm Zalo, Facebook, Telegram, TikTok, unread, auth và unified inbox.

Kiểm thử mới xác nhận multipart thực mang đúng file bytes/MIME/boundary; gửi tài liệu/audio qua outbox; nhận cả hai qua webhook; bảo vệ proxy; giới hạn/định dạng/MIME; caption và cửa sổ 24h; concurrent idempotency; upload lỗi không tạo SEND; mất phản hồi dùng lại key; FAILED retry tách khỏi callback cũ. External Meta được mock; không browser automation.

## 12. Năng lực provider đã xác minh live

**Chưa có** xác minh tài khoản/live message Meta. Việc tải tài liệu chính thức, kiểm thử HTTP localhost, PostgreSQL và React/JSDOM không chứng minh đã gửi tin tới WhatsApp thật. Trang chưa có cấu hình phải thể hiện trạng thái chưa cấu hình, không tạo account hoặc success giả.

## 13. Phần chờ credentials/approval

Challenge trên HTTPS công khai; debug token với assets thật; registration/subscriptions; direct number; Embedded Signup v4 và eligibility; inbound thực; reply text/tài liệu/audio; template thật; sent/delivered/read; expired/revoked token; restart với webhook thật; unsubscribe trên WABA thực. Cần thực hiện checklist live trong [setup](whatsapp-setup.md) sau khi có Meta App/token/quyền.

## 14. History và Coexistence

Đọc lịch sử đã lưu từ thời điểm tích hợp. Không giả general history API. Coexistence Business App/history/smb echoes chưa bật; số Business App và phiên onboarding Coexistence bị từ chối rõ. Không hỗ trợ WhatsApp cá nhân, nhóm hoặc BSUID-only recipient. Template media/buttons/authentication, chọn quoted reply trong UI và ghi âm micro chưa được triển khai; API text có context cùng conversation.

## 15. Giới hạn và vận hành còn lại

- File dùng proxy riêng tư và media ID; không có object storage lâu dài. Theo tài liệu Meta hiện tại, upload ID hết hạn 30 ngày, inbound ID 7 ngày, URL download 5 phút. Khi hết hạn/thu hồi token, lịch sử text/metadata vẫn giữ nhưng file có thể không tải được.
- Tài liệu tối đa 20 MB, audio 16 MB. Kiểm tra byte signatures/MIME/extension chỉ là kiểm tra định dạng ban đầu, chưa quét malware hoặc xác minh codec đầy đủ. Không tự chuyển mã file không tương thích.
- Upload dùng RAM có giới hạn và account lock trong transaction tối đa 45 giây; tải lớn có thể trì hoãn thao tác cùng account. Asset upload đã thành công nhưng transaction thất bại có thể tồn tại không dùng ở Meta đến khi hết hạn; không có SEND nếu chưa commit.
- UNKNOWN không tự gửi lại; operator cần kiểm tra ứng dụng gốc. Rate limit/retry an toàn có backoff giới hạn. Receipt thất bại giữ attempts/error để điều tra; chưa có UI replay/dead-letter riêng. Cần retention, monitoring và backup/khóa mã hóa phù hợp khi vận hành.
- Đồng ý template được operator xác nhận và audit, không tự chứng minh khách đã đồng ý. Meta vẫn áp dụng hạn chế người nhận/khu vực/chất lượng.
- Disconnect xóa credential cục bộ, hủy pending, giữ lịch sử; chỉ unsubscribe WABA khi không còn số active khác. Không deregister số hoặc toàn quyền revoke token dùng chung. Cleanup không được Meta xác nhận phải được xử lý thủ công trong Business Settings nếu cần.

Build production và worker TypeScript riêng đều PASS. HTTP smoke sau khi bật lại một nhóm `pnpm dev`: login 200; WhatsApp status 200; workerOnline=true; inbox accounts 200; frontend `/whatsapp` 200 và title easyChat. Trạng thái configured=false, embeddedAvailable=false, 0 WhatsApp accounts là đúng với môi trường chưa có credentials; 2 tài khoản kênh hiện có vẫn được liệt kê. PostgreSQL dùng lại volume `demo-new-projects-postgres-1`. Không phát sinh EADDRINUSE hoặc worker lease trùng khi khởi động.

Cập nhật sau báo cáo WhatsApp ban đầu: tài liệu/âm thanh đã được mở rộng sang các adapter khác. Tổng hồi quy hiện tại và giới hạn từng kênh xem [media đa kênh](media-attachments.md); số test 421 ở trên ghi nhận mốc WhatsApp trước khi mở rộng.
