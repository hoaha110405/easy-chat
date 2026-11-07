# TikTok trong easyChat

Đã triển khai hai kênh riêng: **TikTok Business** (`/tiktok/business`) và **TikTok Shop** (`/tiktok/shop`). Cả hai dùng hộp thư, xác thực quản trị viên, database, outbox, worker và realtime hiện có. Chưa có ứng dụng TikTok được duyệt hay credentials trong môi trường này, nên **chưa thực hiện OAuth, nhận hoặc gửi tin với TikTok thật**. Kiểm thử bên ngoài dùng mock rõ ràng, không tạo tài khoản hoặc tin nhắn giả trong inbox phát triển.

## 1. Phạm vi và giới hạn

| Kênh            | Đã triển khai                                                                                                                                                       | Giới hạn của bản này                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TikTok Business | OAuth tài khoản Business, kiểm tra app/token/scope/advanced access, nhiều tài khoản, refresh, webhook nhận/echo/read, đồng bộ, trả lời văn bản                      | Hội thoại API trong 90 ngày; tối đa **20 tin gần nhất/hội thoại**, không có phân trang lịch sử tin. easyChat áp dụng mức bảo thủ: chỉ trả lời trong 48 giờ và tối đa 10 tin sau lần khách nhắn gần nhất. |
| TikTok Shop     | Seller OAuth, lấy/chọn shop được cấp quyền, nhiều shop, refresh, hội thoại/tin có phân trang, webhook new message/new conversation/deauthorization, trả lời văn bản | Cần Customer Service được duyệt. Chỉ hội thoại có `can_send_message=true` được kiểm tra trong 10 phút gần nhất và có tin người mua trong 7 ngày. Quyết định từ TikTok khi gửi vẫn có hiệu lực cuối cùng. |

Business có các ngoại lệ chính thức cho hội thoại đang tương tác, ngoài 48 giờ hoặc theo quan hệ follow; bản này **không bật các ngoại lệ đó**. Giới hạn 10 tin là lựa chọn bảo thủ của easyChat, không phải mô tả toàn bộ chính sách TikTok. Số đếm bao gồm tin đang chờ/đang gửi/đã gửi/chưa rõ kết quả và tin đi đã nhập được; API chỉ trả một phần lịch sử nên không thể biết mọi tin đã gửi bằng ứng dụng khác. TikTok vẫn kiểm tra quota thật.

Shop hiển thị `unread_count` đúng giá trị TikTok trả, không tự suy ra đã đọc. Giá trị cập nhật qua lần đồng bộ; không có API đánh dấu đã đọc trong bản này. Business hiển thị đã xem khi có webhook read hợp lệ; không giả lập delivered/read cho Shop. Không hỗ trợ TikTok cá nhân, tạo hội thoại chủ động, gửi hàng loạt, gửi media, xử lý đơn hàng hoặc yêu cầu hoàn tiền. Media đến có URL HTTPS phù hợp được hiển thị qua thành phần hiện có; media chỉ có ID, video cần URL riêng hoặc thẻ sản phẩm/đơn hàng chưa được tải bổ sung và hiện loại tin thay thế.

## 2. Kiến trúc và file thay đổi

Repo thực tế dùng **PostgreSQL outbox `PersonalCommand`**, không có Redis/BullMQ. Không bổ sung hạ tầng queue thứ hai. Tên service/worker cũ được giữ để tương thích.

| Nhóm                   | File chính và vai trò                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hai adapter chính thức | `apps/api/src/modules/tiktok-business/tiktok-business.client.ts`, `tiktok-shop/tiktok-shop.client.ts`: HTTP contract, phiên bản, cấp/refresh token, mapper, phân trang, subscribe, gửi văn bản riêng cho mỗi sản phẩm.                            |
| Runtime chung          | `apps/api/src/modules/tiktok/`: registry, HTTP có timeout và lỗi được làm sạch, OAuth/session, refresh có row lock, webhook raw body, processor chạy trên worker chung, controller/module.                                                        |
| Database               | `apps/api/prisma/schema.prisma`, migration `20261106000000_tiktok_channels`.                                                                                                                                                                      |
| Dùng lại inbox/outbox  | `inbox/message-store.ts`, `inbox/inbox.service.ts`, `messaging/channel-policy.ts`, `zalo-personal/personal.service.ts`, `personal.worker.ts`, `personal-worker.module.ts`, `facebook-page/channel-sync.controller.ts` và module, `app.module.ts`. |
| Hợp đồng dùng chung    | `packages/shared/src/schemas/tiktok.ts`, `api.ts`, `facebook.ts`, `index.ts`.                                                                                                                                                                     |
| Giao diện              | `apps/web/src/pages/tiktok-connection.tsx`, routes, trang ứng dụng, metadata/logo kênh, bộ lọc/composer/trạng thái gửi/bộ đếm unread/chi tiết người liên hệ và SSE.                                                                               |
| Cấu hình và kiểm thử   | Hai `.env.example`, `turbo.json`, API `test:integration`, `test/tiktok.spec.ts`, `test/tiktok.integration.spec.ts`, web `tiktok-connection.spec.tsx`.                                                                                             |

Webhook được xác minh trước khi parse, chuẩn hóa và lưu `WebhookEvent` trước HTTP 200. Một worker có advisory lock đọc receipt và job; không có worker TikTok độc lập. Retry tối đa ba lần cho lỗi được xác định an toàn, có backoff; receipt quá số lần thử giữ trạng thái `FAILED` để điều tra. Job lỗi giữ cursor và mã lỗi, có thể đồng bộ lại từ phần còn lại. Mỗi chuỗi đồng bộ tối đa 100 trang; không báo hoàn tất khi còn cursor/lỗi/job/hội thoại chưa hoàn tất. Tự kiểm tra đồng bộ tài khoản khoảng 5 phút khi worker chạy.

Trước POST gửi, intent chuyển `PENDING → SENDING` trong transaction; ACK có message ID mới thành `SENT`. Timeout/mất ACK/success response thiếu ID trở thành `UNKNOWN`, không tự gửi lại. Restart worker cũng giữ nguyên quy tắc này. Echo đến sớm được hợp nhất khi ACK xác nhận cùng ID. Trạng thái không rõ kết quả phải kiểm tra trên TikTok; không có cách đối chiếu chắc chắn chỉ bằng nội dung trùng nhau. Gửi được giãn tối thiểu 2 giây theo loại kênh + tài khoản ngoài, cả khi tài khoản đó gắn với owner khác.

## 3. Migration an toàn

Migration chỉ thêm dữ liệu cấu trúc:

- `MessageSource.TIKTOK`, `PersonalConnectionStatus.PERMISSION_REQUIRED`.
- `ChannelAccount.capabilities`, `tokenExpiresAt`, `refreshExpiresAt`.
- `Conversation.externalContactId`, `unreadCount` nullable, `providerState` JSON.
- `ChannelAuthorization` giữ state đã hash, provider/owner/session, hạn 10 phút, selection đã mã hóa; FK cascade theo phiên quản trị viên.

Giữ nguyên uniqueness theo owner/provider/account, account/thread, account/message ID và idempotency key, cùng index thời gian/trạng thái đã có. `externalUserId` của TikTok giữ mã thread để tương thích khóa inbox; `externalConversationId` là conversation ID chính thức; `externalContactId` giữ buyer/personal participant riêng. UI không nhầm mã hội thoại với mã người liên hệ.

Migration đã áp dụng trên database phát triển và database test riêng. Không dùng `prisma reset`, không xóa hay tạo lại bảng cũ. Khi triển khai máy khác:

```sh
pnpm install
pnpm db:generate
pnpm db:deploy
```

## 4. Biến môi trường backend

Điền ở **`apps/api/.env`**, không đưa vào `VITE_*`, frontend hoặc Git. Các dòng trống đã được thêm sẵn; không cần credentials để chạy các kênh Zalo/Facebook hiện có.

```dotenv
TIKTOK_BUSINESS_ENABLED=true
TIKTOK_BUSINESS_APP_ID=
TIKTOK_BUSINESS_APP_SECRET=
TIKTOK_BUSINESS_AUTHORIZATION_URL=
TIKTOK_BUSINESS_REDIRECT_URI=https://YOUR-EASYCHAT-HOST/api/channels/tiktok-business/oauth/callback

TIKTOK_SHOP_ENABLED=false
TIKTOK_SHOP_APP_KEY=
TIKTOK_SHOP_APP_SECRET=
TIKTOK_SHOP_AUTHORIZATION_URL=
TIKTOK_SHOP_REDIRECT_URI=https://YOUR-EASYCHAT-HOST/api/channels/tiktok-shop/oauth/callback
```

Bật `TIKTOK_SHOP_ENABLED=true` khi muốn cấu hình Shop. `ENABLED` chỉ là cờ tính năng, không phải xác nhận được duyệt. `AUTHORIZATION_URL` là URL đầy đủ sao chép từ dashboard chính thức (Business: TikTok account holder; Shop: Seller authorization), không tự ghép Marketing OAuth hay Login Kit khác sản phẩm. Backend thêm state theo phiên và Business `disable_auto_auth=1`.

Tiếp tục dùng `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `SESSION_SECRET`, `ADMIN_PASSWORD` đang có. Token access/refresh và shop cipher mã hóa AES-256-GCM theo tài khoản; giữ khóa mã hóa ổn định. Browser chỉ nhận metadata/capabilities/thời hạn, không nhận token/cipher/secret. Không có biến token TikTok toàn cục.

Các token có cách tính thời hạn khác nhau: Business trả số giây còn lại; Shop trả UNIX expiry tuyệt đối. Refresh giữ cả access/refresh mới trong một transaction và khóa hàng tài khoản. Nếu kết quả refresh không chắc chắn, yêu cầu cấp quyền lại thay vì replay refresh token đã có thể bị xoay.

## 5. HTTPS và chạy dự án

Khởi động PostgreSQL và **một** bộ tiến trình bằng `pnpm dev` ở thư mục repo. Lệnh này chạy API, web và worker; đừng mở thêm `pnpm dev:worker` khi worker đã chạy. Cổng mặc định API 3000, web 5173. Repo hiện tại không cần Redis.

Để TikTok trả callback và webhook, dùng domain HTTPS công khai tới web/reverse proxy `/api` vào backend. Có thể dùng tunnel tới 5173 khi phát triển. Đặt `FRONTEND_URL=https://YOUR-EASYCHAT-HOST` ở backend, `DEV_ALLOWED_HOSTS=YOUR-EASYCHAT-HOST` ở `apps/web/.env`, giữ `VITE_API_BASE_URL=/api`. Callback đăng ký trên dashboard phải trùng tuyệt đối biến môi trường. Backend suy ra webhook cùng origin callback, bỏ query/hash và thay path theo bảng bên dưới; không hỗ trợ cổng HTTPS tùy chỉnh. Reverse proxy phải giữ nguyên byte body/header chữ ký.

Sau khi đổi `.env`, khởi động lại bộ API/worker/web rồi đăng nhập qua domain HTTPS đó. Nếu máy đang dùng volume PostgreSQL trước khi đổi tên repo, giữ `COMPOSE_PROJECT_NAME` hiện có theo README; không thay database hoặc xóa volume để chữa lỗi khởi động.

## 6. Thiết lập TikTok Business và quyền

1. Trên [TikTok for Business My Apps](https://ads.tiktok.com/marketing_api/apps/), tạo/chọn developer app, hoàn thiện thông tin/logo và đăng ký **Business Messaging API** theo quy trình xét duyệt của TikTok.
2. Bật quyền TikTok Accounts/Business Messaging phù hợp. Khai báo TikTok account holder redirect URL đúng `TIKTOK_BUSINESS_REDIRECT_URI`. Sao chép **TikTok account holder authorization URL** vào `TIKTOK_BUSINESS_AUTHORIZATION_URL`; lấy App ID/Secret vào backend.
3. Cần được cấp thực tế `message.list.read`, `message.list.send`, `message.list.manage`, `user.account.type`; easyChat cũng cần `user.info.basic` để lấy metadata tài khoản. Backend kiểm tra scope và token inspector app/account, profile `has_advanced_access`, rồi thử API hội thoại. Không dùng checkbox hay cờ cấu hình để suy ra quyền.
4. Tài khoản phải đáp ứng eligibility, yêu cầu tuổi, thị trường/region và trạng thái mà TikTok áp dụng cho Business Messaging. Việc có TikTok Business thông thường không tự tạo quyền API. Tính khả dụng phải xác nhận tại app/dashboard và kết quả API; repo không tự đặt danh sách quốc gia được duyệt.
5. Trong easyChat: **Ứng dụng → TikTok Business → Kết nối**, cấp quyền trên TikTok, chọn tài khoản đã trả về. Chỉ sau khi kiểm tra quyền và đăng ký `DIRECT_MESSAGE` thành công mới lưu `CONNECTED`. Tạo một lượt OAuth mới để thêm tài khoản khác.

Tham khảo [authorization](https://business-api.tiktok.com/portal/docs?id=1832184159540418), [access approval](https://business-api.tiktok.com/portal/docs?id=1832184145137922), [webhook subscription](https://business-api.tiktok.com/portal/docs?id=1832190670631937).

## 7. Thiết lập TikTok Shop và quyền

1. Tại [TikTok Shop Partner Center](https://partner.tiktokshop.com/), tạo ứng dụng dành cho **seller**, đăng ký Customer Service API theo loại app và thị trường được TikTok cho phép. Quyền này có xét duyệt riêng; quyền Shop thông thường không đồng nghĩa Customer Service được cấp.
2. Cấu hình Seller authorization redirect URL chính xác; lấy App Key/Secret và full Seller authorization URL. URL ROW thường dùng `services.tiktokshop.com/open/authorize`, US dùng `services.us.tiktokshop.com/open/authorize`; sao chép đúng URL app, không thay domain dựa trên suy đoán.
3. Xin/cấp `seller.customer_service` và `seller.authorization.info`, cùng quyền Events API/topic mà dashboard yêu cầu. Backend chỉ chấp nhận seller token `user_type=0`, shop được `/authorization/202309/shops` trả, có cipher, đủ scope và truy cập được Customer Service.
4. Chọn các event `NEW_MESSAGE`, `NEW_CONVERSATION`, `SELLER_DEAUTHORIZATION`, callback Shop HTTPS. Backend đăng ký từng topic bằng Events API và đọc lại để xác nhận. Không ghi đè/di chuyển app đang phục vụ hệ thống khác sang URL easyChat nếu chưa có kế hoạch chuyển webhook; cấu hình này thuộc app/shop TikTok.
5. Trong easyChat: **Ứng dụng → TikTok Shop → Kết nối**, seller cấp quyền, chọn shop từ danh sách chính thức. Selection dùng một lần; muốn thêm shop khác, bắt đầu lượt OAuth mới. Không nhập shop ID/cipher/token tùy ý vào trình duyệt.

Quyền/market/loại ứng dụng được duyệt phụ thuộc TikTok và có thể thay đổi. Xem [seller authorization](https://partner.tiktokshop.com/docv2/page/seller-authorization-guide), [Customer Service overview](https://partner.tiktokshop.com/docv2/page/customer-service-api-overview), [webhook configuration](https://partner.tiktokshop.com/docv2/page/configuration-guide).

## 8. REST API

Tiền tố `/api`; success `{data: ...}`, error `{error: {code,message}}`. Mọi mutation quản trị cần cookie và Origin frontend; callback cần cookie/state còn hiệu lực. Webhook dùng chữ ký TikTok, không cần cookie.

| Method | Path                                                                               | Ý nghĩa                                                                                                        |
| ------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| GET    | `/channels/tiktok-business`, `/channels/tiktok-shop`                               | Enabled/configured, tình trạng approval đã kiểm tra, accounts/capabilities, selection đã bỏ secrets, giới hạn. |
| POST   | `/channels/tiktok-business/connect`, `/channels/tiktok-shop/connect`               | Tạo state gắn session/owner/provider; trả official authorization URL.                                          |
| GET    | `/channels/tiktok-business/oauth/callback`, `/channels/tiktok-shop/oauth/callback` | State một lần, đổi code thật, lưu selection mã hóa, redirect về trang tương ứng.                               |
| POST   | `/channels/tiktok-business/select`, `/channels/tiktok-shop/select`                 | `{authorizationId,externalAccountId}` từ selection; xác minh quyền, subscribe, lưu account và job ban đầu.     |
| POST   | `/channels/tiktok-business/webhook`                                                | `TikTok-Signature`, HMAC timestamp + `.` + raw body, header timestamp lệch tối đa 5 phút.                      |
| POST   | `/channels/tiktok-shop/webhook`                                                    | `Authorization`, HMAC app key + raw body; nhận type 14/13/6. HTTP 200 rỗng sau durable acceptance.             |
| GET    | `/channels/:id/status`                                                             | Trạng thái tài khoản thuộc owner, thêm TikTok capabilities/expiry.                                             |
| POST   | `/channels/:id/sync`                                                               | Xếp job hội thoại, HTTP 202; không tạo job trùng đang chờ/chạy.                                                |
| POST   | `/conversations/:id/sync`                                                          | Xếp job tin cho hội thoại thuộc owner/tài khoản.                                                               |
| DELETE | `/channels/:id`                                                                    | Ngắt cục bộ, xóa credentials/capabilities, đổi generation, hủy job; giữ lịch sử.                               |
| GET    | `/conversations/accounts`                                                          | Mọi tài khoản inbox thuộc owner, giữ nhận diện provider/avatar.                                                |
| GET    | `/conversations?channelType=TIKTOK_SHOP&account=tiktok-shop:ID`                    | Bộ lọc trước pagination; tương tự `TIKTOK_BUSINESS`/`tiktok-business:ID`.                                      |
| GET    | `/conversations/:id/messages`                                                      | Lịch sử đã lưu, cursor, attachments và trạng thái được xác nhận.                                               |
| POST   | `/conversations/:id/messages`                                                      | `{content,idempotencyKey}` qua outbox đang có, HTTP 202.                                                       |
| POST   | `/conversations/:id/messages/:messageId/retry`                                     | Chỉ FAILED chắc chắn và vẫn còn quyền/cửa sổ/quota; UNKNOWN không retry.                                       |
| GET    | `/events`                                                                          | SSE quản trị có cookie, thông báo sau commit và refetch dữ liệu thuộc owner.                                   |

Không thêm `GET /channels` trùng chức năng: dùng registry trang ứng dụng và `/conversations/accounts` đang có. Tài khoản chưa cấu hình/được duyệt hiện `NOT_CONNECTED`/`UNVERIFIED`; tài khoản mất quyền hiện `PERMISSION_REQUIRED`, hết hạn/thu hồi hiện `REAUTH_REQUIRED`, worker offline thể hiện `RECONNECTING`.

## 9. Kiểm thử đã thực hiện

Chạy từ root, dùng **database test riêng có tên kết thúc `_test`**. Suite integration áp migration và dọn fixture trong database test; không trỏ vào database phát triển.

```sh
pnpm --filter @zalo/api lint
pnpm --filter @zalo/web lint
pnpm test
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/zalo_inbox_test pnpm test:integration
pnpm --filter @zalo/web build
```

Các kiểm thử TikTok gồm contract HTTP hai sản phẩm, signature trên exact bytes, tính expiry, scopes/identity/capability, state/session/owner, selection một lần, mã hóa/cipher không lộ, nhiều shop, cursors, dedup history/webhook, nhập lịch sử không đổi đồng hồ inbound, send/retry/rate/window/quota, mất ACK, restart, echo sớm, read receipt, revoke/disconnect và PG NOTIFY sau commit. Giao diện kiểm tra chưa cấu hình, chọn shop, redirect không tin cậy, thông báo quyền, unread và gửi qua composer chung. Xem [báo cáo nghiệm thu](tiktok-validation.md) để biết số test và lệnh build thực tế.

## 10. Nghiệm thu với TikTok thật khi đã có quyền

1. Cấu hình app được duyệt, HTTPS, callback, credentials và URL cấp quyền; restart đúng một bộ tiến trình.
2. Đăng nhập easyChat, mở Business; trạng thái ban đầu chưa kết nối. Kết nối tài khoản đủ điều kiện, xem đúng tên/avatar và capability đã kiểm tra. Kiểm tra app-level webhook trên dashboard.
3. Đồng bộ; kiểm tra đúng conversation ID/contact ID, tối đa phần lịch sử API cho phép, không báo tải toàn bộ lịch sử cũ.
4. Từ tài khoản khác nhắn vào Business; kiểm tra receipt, đúng account, avatar khi có dữ liệu, tin xuất hiện qua SSE một lần dù redelivery.
5. Trả lời trong cửa sổ cho phép; kiểm tra ID do TikTok trả, `SENT`, và **xác nhận trên ứng dụng TikTok thật**. Chỉ báo đã xem khi có read event.
6. Đợi/kiểm tra refresh ở môi trường thử; không xóa credentials để giả lập refresh thành công. Thu hồi quyền trong TikTok rồi kiểm tra `REAUTH_REQUIRED` hoặc `PERMISSION_REQUIRED` và ngừng gửi.
7. Restart worker; không có worker thứ hai, job sync tiếp tục và tin SENDING chưa xác nhận thành UNKNOWN. Kiểm tra tin trên TikTok trước khi tạo yêu cầu mới.
8. Kết nối tài khoản Business thứ hai; thử Tất cả, lọc kênh, lọc tài khoản, kiểm tra người nhận và tài khoản trả lời riêng.
9. Lặp lại với Shop đã được duyệt: chọn seller/shop chính thức, kiểm tra shop cipher chỉ ở backend, type 14/13, unread do provider trả, `can_send_message`, reply thực tế. Thêm shop thứ hai bằng OAuth mới.
10. Ngắt trong easyChat; credentials được xóa, job cũ không hoạt động, lịch sử vẫn đọc được. Để thu hồi quyền cấp cho app trên TikTok, thao tác thêm tại nền tảng TikTok; ngắt cục bộ không đồng nghĩa revoke ở nhà cung cấp.

Phần trên là checklist **chưa chạy live** do chưa có app/approval/credentials. Chi tiết endpoint, nguồn xác minh và phiên bản được ghi tại [TikTok API research](tiktok-api-research.md).
