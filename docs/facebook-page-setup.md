# Facebook trong easyChat

Facebook Page dùng OAuth, Messenger Platform và Graph API chính thức. Messenger cá nhân có trang riêng nhưng hiện **UNSUPPORTED**, kể cả khi bật cờ cấu hình: chưa có thư viện được kiểm chứng đáp ứng phiên đăng nhập, E2EE, nhận/gửi và khôi phục an toàn. Xem [đánh giá thư viện](facebook-personal-evaluation.md) và [nguồn xác minh API Meta](facebook-page-api-research.md).

## Kiến trúc và khả năng

Giữ nguyên NestJS, React, Prisma/PostgreSQL và hộp thư hiện có. Không thêm ORM, Redis, BullMQ hay máy chủ realtime. Facebook dùng chung `ChannelAccount`, `Conversation`, `Message`, hàng đợi giao dịch `PersonalCommand`, biên nhận `WebhookEvent`, SSE có xác thực và **một worker chung** với Zalo. Tên bảng/worker cũ được giữ để tương thích.

| Kênh              | Kết nối                         | Nhận/lịch sử                                                                                                       | Gửi                                                     |
| ----------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Zalo Personal     | QR hiện có                      | Giữ nguyên listener, media và ảnh đại diện hiện có                                                                 | Văn bản, tài liệu, âm thanh một người nhận              |
| Zalo OA           | OAuth hiện có                   | Giữ nguyên webhook và lịch sử đã hỗ trợ                                                                            | Tài liệu theo quyền/cửa sổ; chưa gửi văn bản/âm thanh   |
| Facebook Page     | OAuth, chọn Page được cấp quyền | Webhook; đồng bộ hội thoại Messenger một người nhận và phần lịch sử Meta cho phép; ảnh đại diện khi quyền cho phép | Văn bản, tài liệu, âm thanh trong cửa sổ trả lời 24 giờ |
| Messenger cá nhân | Chưa hỗ trợ                     | Chưa hỗ trợ, gồm E2EE                                                                                              | Chưa hỗ trợ                                             |

ID tài khoản ngoài là chuỗi; khóa duy nhất gồm owner, loại kênh và ID. Hội thoại Page dùng `PAGE_PSID`: `externalUserId` là PSID, `externalConversationId` là mã hội thoại Graph riêng. ID Zalo/global Facebook/personal thread không dùng lẫn nhau. Nội dung ảnh, video, file hoặc sticker nhận được được lưu dạng attachment và hiển thị bằng thành phần hiện có khi có URL an toàn; gửi tài liệu/âm thanh đã dùng composer và outbox chung; xem [giới hạn media](media-attachments.md).

## Cấu hình backend

Thêm vào `apps/api/.env` (không đưa vào `VITE_*`, Git hoặc trình duyệt):

```dotenv
FACEBOOK_APP_ID=
FACEBOOK_APP_SECRET=
FACEBOOK_GRAPH_API_VERSION=v26.0
FACEBOOK_VERIFY_TOKEN=
FACEBOOK_OAUTH_REDIRECT_URI=https://YOUR-EASYCHAT-HOST/api/channels/facebook-page/oauth/callback
FACEBOOK_PERSONAL_ENABLED=false
```

`FACEBOOK_VERIFY_TOKEN` là chuỗi ngẫu nhiên do quản trị viên tự tạo, đăng ký giống hệt ở Meta; không phải App Secret hoặc Page token. Tiếp tục dùng `TOKEN_ENCRYPTION_KEY` có sẵn để mã hóa AES-256-GCM; giữ khóa ổn định qua lần khởi động, không tạo khóa thứ hai. ID/Secret lấy từ Meta App. Page token được lấy qua OAuth theo từng tài khoản, không có Page token toàn cục.

Dùng HTTPS công khai cho callback/webhook. Cách kiểm tra phát triển thuận tiện là tunnel tới Vite cổng 5173, để `/api` được proxy tới API cổng 3000. Đặt `FRONTEND_URL=https://YOUR-EASYCHAT-HOST` trong backend, `DEV_ALLOWED_HOSTS=YOUR-EASYCHAT-HOST` trong `apps/web/.env`, giữ `VITE_API_BASE_URL=/api`, rồi khởi động lại các tiến trình. Truy cập và đăng nhập qua chính URL HTTPS đó. Production cũng cần cùng origin HTTPS và reverse proxy `/api`, đồng thời chuyển nguyên byte body/header chữ ký cho webhook. URL `localhost` mặc định chỉ giúp chạy app cục bộ, không thay thế địa chỉ công khai cho webhook.

Chưa có Meta App thì Zalo vẫn dùng được; trang Facebook thông báo thiếu cấu hình, không tạo kết nối giả.

## Thiết lập Meta Developer Console

1. Tạo/chọn app trên [Meta for Developers](https://developers.facebook.com/apps/), cấu hình sản phẩm/use case Facebook Login và Messenger phù hợp với app. Các tên menu có thể khác theo loại app.
2. Trong cấu hình Facebook Login, đăng ký **Valid OAuth Redirect URI** khớp tuyệt đối với `FACEBOOK_OAUTH_REDIRECT_URI`, gồm scheme, host, path và dấu `/` cuối. Cho phép domain HTTPS của easyChat theo yêu cầu dashboard.
3. Yêu cầu và cấp đủ `pages_show_list`, `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`. Tài khoản Facebook đăng nhập cần được giao quyền nhắn tin trên Page. Backend kiểm tra scope thực tế, task, app/token, thời hạn và Page đã chọn; URL OAuth có quyền yêu cầu không đồng nghĩa đã được cấp.
4. Ở Webhooks/Messenger, đăng ký đối tượng **Page**, callback `https://YOUR-EASYCHAT-HOST/api/channels/facebook-page/webhook`, verify token giống `FACEBOOK_VERIFY_TOKEN`. Đăng ký `messages`, `message_echoes`, `message_deliveries`, `message_reads`, `messaging_postbacks`. GET xác minh không cần cookie quản trị viên; Meta nhận lại nguyên challenge.
5. Đăng nhập easyChat, vào **Ứng dụng → Messenger → Facebook Page**, bấm **Kết nối Facebook Page**, cấp quyền ở Facebook, quay về chọn đúng Page. Backend xác minh và đăng ký Page vào app trước khi lưu trạng thái kết nối. Muốn thêm Page khác, bắt đầu một lượt OAuth mới.
6. Với người dùng ngoài vai trò app/business, hoàn thành App Review, Advanced Access và Business Verification nếu Meta yêu cầu. App ở development mode chỉ phù hợp kiểm tra bằng tài khoản/vai trò được Meta cho phép. Kết nối thử thành công không chứng minh app được phép phục vụ công khai.

Hướng dẫn chính thức: [Messenger Platform](https://developers.facebook.com/docs/messenger-platform/), [Webhooks](https://developers.facebook.com/docs/graph-api/webhooks/), [bộ API Messenger do Meta công bố](https://www.postman.com/meta/messenger-platform-api/). Phiên bản và endpoint được đối chiếu tại [API research](facebook-page-api-research.md); không khẳng định mọi app đều được cấp quyền hoặc mọi hội thoại đều truy cập được.

## Chạy ứng dụng và worker

Từ thư mục gốc, sau khi cài dependency/cấu hình database:

```sh
docker compose up -d postgres
pnpm db:generate
pnpm db:deploy
pnpm dev
```

`pnpm dev` đã mở API, web, shared watcher và một worker. Nếu chạy riêng, dùng các terminal riêng:

```sh
pnpm dev:api
pnpm dev:web
pnpm dev:worker
```

Không chạy đồng thời hai bộ lệnh trên: API dùng cổng 3000 và chỉ một worker được giữ advisory lock PostgreSQL. Production chạy `pnpm build`, sau đó `pnpm --filter @zalo/api start` và `pnpm --filter @zalo/api worker:start` bằng hai process. Web phục vụ từ `apps/web/dist` với SPA fallback.

## Đồng bộ, realtime và gửi tin

Kết nối Page xếp lịch đồng bộ đầu tiên. Mỗi job tải tối đa 25 hội thoại hoặc 25 tin nhắn; cursor và checkpoint được lưu cùng dữ liệu. Thực hiện các trang tiếp theo bằng job riêng, tối đa 200 trang mỗi lượt/mỗi hội thoại; khi chạm giới hạn giữ cursor và báo `FACEBOOK_SYNC_LIMIT_REACHED` để tiếp tục. Hội thoại hoàn tất và không đổi được bỏ qua ở lượt đồng bộ sau; hội thoại đổi được đọc lại và gộp theo message ID. Không dùng tham số `since` chưa xác minh. Đồng bộ thủ công trên trang Page hoặc API có thể tiếp tục sau lỗi; `syncComplete` chỉ nói về phần dữ liệu API cho phép trong lượt đồng bộ, không đảm bảo toàn bộ lịch sử Messenger. Tin mới qua webhook không phải đợi backfill hoàn tất. Tên/ảnh khách hàng mới được tra cứu bằng job nền riêng; quyền riêng tư hoặc thiếu quyền profile có thể khiến ảnh không có. Tiếp tục đồng bộ Page cũng xếp lịch lại tối đa 100 checkpoint hội thoại cũ còn thiếu mỗi yêu cầu, kể cả khi cursor danh sách đã đi qua chúng; yêu cầu lặp không tạo job đang chạy trùng nhau.

Webhook được kiểm tra HMAC-SHA256 trên raw body, chuẩn hóa và commit biên nhận trước HTTP 200. Worker gộp tin theo account/message ID, sau commit mới phát sự kiện SSE theo owner. Lỗi xử lý được giữ trong biên nhận và thử lại tối đa ba lần; không bỏ qua chữ ký khi sửa lỗi. Sự kiện postback hiện được nhận hợp lệ nhưng không kích hoạt bot, gửi tin hoặc mở cửa sổ 24 giờ.

Gửi theo luồng giao diện → API → message/outbox trong PostgreSQL → worker → Graph Send API. UUID idempotency dùng lại cho cùng yêu cầu; cùng UUID với nội dung/hội thoại khác bị từ chối. Mỗi Page cách các lần gửi ít nhất 1,5 giây, ưu tiên gửi trước backfill. Giới hạn 20 tin đang chờ trên mỗi account. Cửa sổ 24 giờ dựa trên **tin khách hàng gửi thực tế**, kiểm tra cả trước khi xếp hàng và ngay trước POST tới Meta; echo, Page reply, read/delivery và bản replay trùng không mở lại cửa sổ. Không dùng message tag hay cơ chế ngoại lệ chưa được phê duyệt.

Rejection chắc chắn có thể FAILED hoặc retry hữu hạn với backoff khi provider cho phép. Timeout/mất xác nhận, lỗi lưu sau POST hoặc restart ở trạng thái SENDING trở thành **UNKNOWN** và không tự gửi lại. Kiểm tra Messenger trước khi tự tạo tin mới. SENT nghĩa là Meta xác nhận nhận yêu cầu; delivered/read chỉ hiển thị khi có sự kiện tương ứng. Không có cam kết exactly-once giữa database và Meta.

Ngắt kết nối xóa token cục bộ, tăng generation để vô hiệu hóa kết quả/job cũ, hủy công việc và giữ lịch sử đã lưu theo chính sách hiện có. Hệ thống không unsubscribe Page toàn cục vì subscription của app có thể đang phục vụ một kết nối khác; các delivery của Page đã ngắt được bỏ qua. Có thể gỡ quyền app trực tiếp tại Meta khi muốn thu hồi phía nền tảng.

## API

Tất cả đường dẫn dưới `/api`; JSON thành công `{data:...}`, lỗi `{error:{code,message}}`. Cookie HttpOnly hiện có là bắt buộc trừ callback kiểm tra session thủ công và webhook xác thực từ Meta; thao tác POST/DELETE cần Origin frontend hợp lệ.

| Method   | Path                                           | Kết quả                                                                                                                  |
| -------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| GET      | `/channels/facebook-page`                      | Cấu hình, worker, các account và danh sách Page đang chờ chọn; không token                                               |
| GET      | `/channels/facebook-page/connect`              | `authorizationUrl`, state ngẫu nhiên một lần gắn với session, hạn 10 phút                                                |
| GET      | `/channels/facebook-page/oauth/callback`       | Consume state, exchange/check token, lưu lựa chọn mã hóa; redirect `/facebook/page?oauth=select` hoặc `?error=SAFE_CODE` |
| POST     | `/channels/facebook-page/select`               | Body `{pageId}`; xác minh, subscribe, lưu Page, queue initial sync; lựa chọn dùng một lần trong 10 phút                  |
| GET/POST | `/channels/facebook-page/webhook`              | Verify challenge / durable intake có chữ ký                                                                              |
| GET      | `/channels/:id/status`                         | Trạng thái account thuộc owner                                                                                           |
| DELETE   | `/channels/:id`                                | Ngắt cục bộ, `{disconnected:true,...publicAccount}`                                                                      |
| POST     | `/channels/:id/sync`                           | Queue đồng bộ Page, `{queued:true}`                                                                                      |
| POST     | `/conversations/:id/sync`                      | Queue lịch sử hội thoại đã có Graph conversation ID                                                                      |
| GET      | `/conversations/accounts`                      | Bộ chọn account dùng chung                                                                                               |
| GET      | `/conversations`                               | Lọc `channelType=FACEBOOK_PAGE`, `account=facebook-page:INTERNAL_ID` hoặc mọi kênh                                       |
| GET      | `/conversations/:id/messages`                  | Tin nhắn đã lưu, gồm media/deliveredAt/readAt khi có                                                                     |
| POST     | `/conversations/:id/messages`                  | `{content,idempotencyKey}`; HTTP 202 với tin PENDING                                                                     |
| POST     | `/conversations/:id/messages/:messageId/retry` | Chỉ tin FAILED chắc chắn, còn quyền/cửa sổ hợp lệ                                                                        |
| GET      | `/channels/facebook-personal/status`           | UNSUPPORTED, mọi capability false                                                                                        |
| POST     | `/channels/facebook-personal/connect`          | HTTP 501; không lưu credentials hoặc tạo account                                                                         |

Inbox hỗ trợ `limit` 1–100, `cursor=nextCursor` trên trang sau, đồng thời tương thích `page`. Cursor dựa trên thời gian và ID, bộ lọc/kiểm tra owner luôn áp dụng trước phân trang. Web dùng cursor khi có. `sendBlockedReason` là mã lỗi, `messagingWindowExpiresAt` cho biết hạn trả lời. SSE giữ nguyên `/events` có xác thực.

## Kiểm thử tự động và nghiệm thu thật

```sh
pnpm lint
pnpm test
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/zalo_inbox_test XDG_CACHE_HOME=/tmp/zalo-cache pnpm test:integration
pnpm build
```

Tạo database `zalo_inbox_test` một lần nếu chưa có. Bộ integration chỉ chạy khi URL chỉ rõ database kết thúc `_test`; áp migration và xóa fixture trong database đó, không dùng database phát triển. Provider trong kiểm thử đều được mock; fixture không được đưa vào inbox thật.

Nghiệm thu Page thủ công bằng app/Page của bạn:

1. Đăng nhập easyChat qua HTTPS, cấp OAuth, chọn Page; xác nhận đúng tên/ảnh và account selector. Kiểm tra response/network không chứa token; refresh vẫn giữ kết nối.
2. Đồng bộ phần lịch sử được cấp phép; tải thêm các trang trong inbox. Nếu Meta không cho đọc lịch sử, giao diện phải báo lỗi/khả năng giới hạn.
3. Từ tài khoản khách hàng được Meta cho phép, gửi một tin mới và một ảnh cho Page. Kiểm tra webhook được ký, receipt được lưu, một cuộc chat đúng Page xuất hiện qua SSE, ảnh hiển thị khi URL tồn tại. Replay webhook giống nhau không tạo thêm tin.
4. Trả lời văn bản qua easyChat trong 24 giờ. Xác nhận trên Messenger đúng Page/người nhận; trạng thái chuyển PENDING → SENDING → SENT. Kiểm tra delivery/read khi Meta phát các sự kiện đó.
5. Thử một hội thoại đã quá 24 giờ: composer bị khóa và API từ chối. Sau tin mới của khách, tải lại trạng thái và gửi được. Không tự gửi tin cho tài khoản không yêu cầu.
6. Ngắt Page, restart một worker, kiểm tra token đã xóa, job cũ không gửi tiếp và lịch sử vẫn đọc được. Cấp lại quyền để kết nối lại. Thu hồi quyền app ở Meta rồi đồng bộ: phải chuyển REAUTH_REQUIRED và hướng dẫn cấp lại.
7. Chuyển giữa Page/Zalo và các tài khoản, kiểm tra tên, ảnh, danh sách và composer luôn thuộc cuộc chat/account đang chọn.

Nghiệm thu Personal: mở `/facebook/personal`, xác nhận UNSUPPORTED và không có ô nhập mật khẩu/cookie/PIN hay QR giả. Bật flag trong môi trường test vẫn phải mọi capability false; gọi connect có xác thực/Origin trả 501, không tạo account/job. Không có nghiệm thu nhận/gửi/E2EE thật cho Personal trong bản này.

**Chưa kiểm thử trực tiếp bằng Meta credentials thật.** App Review, quyền Page, khả năng đọc lịch sử/ảnh, webhook công khai và giao nhận thật cần bước nghiệm thu ở trên.

## Lỗi thường gặp

| Mã/triệu chứng                                  | Xử lý                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| `FACEBOOK_NOT_CONFIGURED`                       | Điền App ID/Secret ở backend, khởi động lại API/worker                   |
| `INVALID_OAUTH_STATE`, `OAUTH_SESSION_EXPIRED`  | Đăng nhập và bắt đầu OAuth lại ở cùng origin; state chỉ dùng một lần     |
| `FACEBOOK_NO_PAGES`                             | Đúng tài khoản, có task nhắn tin Page, cấp Page đó cho app               |
| `FACEBOOK_PERMISSION_DENIED`                    | Cấp đủ scope và Page target; kiểm tra App Review/Advanced Access/vai trò |
| `FACEBOOK_REAUTH_REQUIRED`                      | Cấp OAuth lại; không lặp gửi bằng token bị thu hồi                       |
| `FACEBOOK_SELECTION_EXPIRED`                    | Lựa chọn hết hạn/đã dùng hoặc phiên đăng xuất; bắt đầu kết nối lại       |
| `INVALID_FACEBOOK_WEBHOOK_SIGNATURE`            | Đúng App Secret, header `X-Hub-Signature-256`, raw body được giữ nguyên  |
| `FACEBOOK_SYNC_LIMIT_REACHED`                   | Tiếp tục đồng bộ; cursor đã lưu, không hứa lịch sử đầy đủ                |
| `FACEBOOK_PAGE_MESSAGING_WINDOW_CLOSED`         | Chờ tin mới của khách; không giả tag/ngoại lệ                            |
| `FACEBOOK_SEND_UNKNOWN`, `MESSAGE_SEND_UNKNOWN` | Kiểm tra Messenger, không tự động resend                                 |
| `CHANNEL_WORKER_UNAVAILABLE`                    | Khởi động một worker, kiểm tra PostgreSQL và heartbeat                   |
| `EADDRINUSE :3000` / worker lock                | Đang mở trùng API/worker; giữ một bộ tiến trình của dự án                |

## Migration và vùng thay đổi

Migration Prisma `20261105030000_facebook_channels` thêm trạng thái/nguồn Facebook, fields OAuth/selection, checkpoint đồng bộ, inbound window, delivery/read, payload job và index; thay uniqueness account ngoài bằng owner + channel + external ID. Không reset hoặc xóa record hiện có. Module mới nằm trong `apps/api/src/modules/facebook-page` và `facebook-personal`; lớp policy/store, controller inbox và worker hiện có được mở rộng dùng chung. UI, Zod DTO, env examples và các bộ test được cập nhật trong cùng workspace.

## Kết quả kiểm tra bản triển khai

Ngày 2026-11-05: lint/TypeScript và kiểm tra Prettier đạt; 89 test API đơn vị, 2 test shared, 25 test web và 65 test tích hợp PostgreSQL đạt (23 Facebook, 42 hồi quy Zalo/OA). Shared build, Vite production build và NestJS production build đạt. Nest build được xuất riêng vào `/tmp/easychat-facebook-build/api` trong phiên làm việc để không xóa thư mục `dist` mà dev watcher đang sử dụng.

Smoke test trên API phát triển xác nhận Page status HTTP 200 với `configured=false`, worker online, Personal status HTTP 200/UNSUPPORTED, inbox HTTP 200; phiên quản trị kiểm tra đã đăng xuất. Không gửi tin thật hoặc thực hiện OAuth/call Graph với tài khoản Meta thật. Những kết quả tự động không thay thế nghiệm thu Meta nêu trên.
