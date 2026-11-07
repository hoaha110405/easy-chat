# Cấu hình easyChat: env, callback và webhook

Hướng dẫn này dùng sau phần [clone và chạy lần đầu](../README.md#bat-dau-sau-khi-clone) trong README. Chỉ điền nhóm biến của kênh bạn sử dụng; không cần có credentials của tất cả nền tảng để chạy ứng dụng.

Các đoạn cấu hình bên dưới là mẫu. Sửa dòng tương ứng đã có trong `apps/api/.env` hoặc `apps/web/.env`, giữ nguyên khóa/mật khẩu mà `pnpm env:init` đã sinh. Thay mọi giá trị `THAY_...` và domain `chat.example.com` bằng giá trị thật trước khi kết nối; chúng không phải credentials dùng được.

## 1. Hiểu đúng các loại cấu hình

| Giá trị                     | Lấy ở đâu?                                   | Điền vào đâu?                                                                                                                 |
| --------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| App ID/App Key/API ID       | Trang ứng dụng của nhà cung cấp              | Env backend của đúng kênh.                                                                                                    |
| App Secret/API Hash         | Trang ứng dụng của nhà cung cấp              | Env backend; không đưa vào frontend.                                                                                          |
| Verify Token của Meta       | Chuỗi do bạn tự tạo                          | Cùng một giá trị trong env backend và ô Verify Token trên Meta Dashboard.                                                     |
| OAuth redirect/callback URL | Endpoint đã được easyChat triển khai         | Biến `*_REDIRECT_URI` và ô redirect URL tương ứng ở Developer Console.                                                        |
| Webhook URL                 | Endpoint nhận sự kiện của easyChat           | Phần webhook của nhà cung cấp; WhatsApp/Telegram còn có biến env riêng bên dưới.                                              |
| Access Token/Bot Token      | Quy trình cấp quyền hoặc dashboard/BotFather | Facebook/TikTok/Zalo OA lấy qua OAuth. Token WhatsApp/Bot Token nhập ở trang kết nối tương ứng, không thêm biến token tự đặt. |

Verify Token không phải App Secret, access token hay khóa mã hóa. Có thể tạo một chuỗi ngẫu nhiên cho mỗi verify token bằng:

```bash
openssl rand -hex 32
```

Giữ chuỗi đó trong cấu hình riêng. Không commit file `.env`, token hay dữ liệu phiên; các file env đã được Git bỏ qua. `TOKEN_ENCRYPTION_KEY` phải được giữ ổn định qua lần khởi động để đọc được dữ liệu đã mã hóa.

## 2. Chuẩn bị HTTPS dùng chung

Ví dụ bạn có domain/tunnel **`https://chat.example.com`** trỏ tới Vite cổng **5173**; Vite đã chuyển `/api` tới backend cổng 3000. Bạn cũng có thể dùng reverse proxy riêng với cùng cách định tuyến.

Trong `apps/api/.env`:

```dotenv
FRONTEND_URL=https://chat.example.com
```

Trong `apps/web/.env`:

```dotenv
VITE_API_BASE_URL=/api
API_PROXY_TARGET=http://localhost:3000
DEV_ALLOWED_HOSTS=chat.example.com
```

Giữ `NODE_ENV=development` cho môi trường dev qua tunnel; khi triển khai thật mới dùng `production`. `DEV_ALLOWED_HOSTS` chỉ dùng cho Vite dev, gồm hostname không có giao thức/path. Reverse proxy production cần cấu hình host và `/api` của chính nó.

Sau đó cập nhật callback/webhook của **kênh đang dùng** theo các mục dưới, khởi động lại một bộ `pnpm dev`, mở **`https://chat.example.com` và đăng nhập tại đó**. Cookie của `localhost` không được dùng cho callback trên một hostname khác. Callback phải trùng tuyệt đối URL đã đăng ký, không tự thêm dấu `/` cuối hoặc đổi cổng.

Webhook cần truy cập được từ Internet, không qua màn hình đăng nhập tunnel. Proxy phải chuyển nguyên body/header chữ ký tới API. Khi tunnel đổi hostname, cập nhật env, Developer Console và webhook đã đăng ký; kết nối/cấp quyền lại hoặc xác minh lại webhook theo từng kênh. Riêng Telegram Bot, kết nối lại bot sau khi đổi URL để backend đăng ký URL mới.

Các route OAuth và webhook nằm dưới `/api`. Các route như `/personal`, `/connection`, `/facebook/page`, `/whatsapp` chỉ là trang giao diện, không phải callback nhận sự kiện.

<a id="zalo-ca-nhan"></a>

## 3. Zalo cá nhân

Không cần Zalo App ID, App Secret, callback OAuth hoặc webhook công khai cho kênh này.

```dotenv
ZALO_PERSONAL_ENABLED=true
ZALO_PERSONAL_SEND_MAX_ATTEMPTS=3
ZALO_PERSONAL_SEND_INTERVAL_MS=1500
```

Khởi động API và worker bằng `pnpm dev`. Mở **Kết nối ứng dụng → Zalo → Cá nhân** (`/personal`), thêm tài khoản và quét QR bằng ứng dụng Zalo trên điện thoại. Lặp lại để thêm tài khoản khác; chọn đúng tài khoản hoặc **Tất cả** trong Inbox.

Worker phải tiếp tục chạy để giữ listener, nhận tin và gửi lệnh. Adapter `zca-js` là tích hợp không chính thức, có rủi ro bị nhà cung cấp hạn chế tài khoản. Xem [vận hành Zalo cá nhân](zalo-personal.md).

<a id="zalo-oa"></a>

## 4. Zalo OA

Chuẩn bị Developer App và một OA mà tài khoản Zalo của bạn có quyền quản trị. Đây là hai tài nguyên khác nhau.

```dotenv
ZALO_APP_ID=THAY_APP_ID
ZALO_APP_SECRET=THAY_APP_SECRET
ZALO_REDIRECT_URI=https://chat.example.com/api/zalo/callback
ZALO_OA_SECRET_KEY=THAY_KHOA_KY_WEBHOOK_OA
```

Trong [Zalo for Developers](https://developers.zalo.me/):

1. Chọn ứng dụng. Lấy **App ID** và **App Secret** ở phần thông tin/cài đặt ứng dụng, điền hai biến đầu.
2. Mở **Official Account → Thiết lập chung** hoặc phần cấu hình cấp quyền OA. Ở ô **Official Account Callback Url**, điền nguyên URL:

   ```text
   https://chat.example.com/api/zalo/callback
   ```

3. Bấm **Cập nhật/Lưu**. Các ô **Code Challenge** và **State** trên trang tạo link không cần tự điền để dùng easyChat: backend sinh PKCE/state mới khi bạn bấm kết nối trong ứng dụng.
4. Đăng ký quyền đọc thông tin OA, nhận sự kiện tin nhắn và quyền lịch sử/gửi tư vấn đính kèm file nếu dùng các chức năng đó. Hoàn thành xét duyệt/điều kiện OA mà dashboard yêu cầu.
5. Trong phần **Webhook**, đăng ký:

   ```text
   https://chat.example.com/api/webhooks/zalo
   ```

6. Bật các sự kiện tin nhắn cần nhận như `user_send_text`, `oa_send_text`, image/file/voice nếu có trong gói quyền. Điền `ZALO_OA_SECRET_KEY` bằng khóa ký được dùng cho công thức `OAsecretKey` của webhook, theo cấu hình OA/app. Không tự thay bằng App Secret hoặc refresh token nếu chưa xác nhận đúng credential.
7. Khởi động lại dev; đăng nhập easyChat qua origin HTTPS, mở **Zalo → Official Account** (`/connection`) và bấm kết nối. Chọn OA và cấp quyền.

Nếu chỉ kiểm tra OAuth local và dashboard chấp nhận localhost, URL mặc định của repo là `http://localhost:3000/api/zalo/callback`; đăng ký đúng URL này và giữ `FRONTEND_URL=http://localhost:5173`. Webhook vẫn cần HTTPS công khai để nhận tin từ Zalo. Dùng chung origin HTTPS như mẫu trên sẽ thuận tiện hơn khi nghiệm thu đầy đủ.

Lỗi `-14003` thường do callback không khớp. Lỗi `-14068` cho biết tài khoản cấp quyền không có OA phù hợp. Không mở callback trực tiếp để đăng nhập; bắt đầu từ nút kết nối để có session/state đúng.

Nguồn: [xác thực và ủy quyền Zalo OA](https://developers.zalo.me/docs/official-account/bat-dau/xac-thuc-va-uy-quyen-cho-ung-dung-new). Khả năng gửi file hiện tại: [media đa kênh](media-attachments.md).

<a id="facebook-page"></a>

## 5. Facebook Page

```dotenv
FACEBOOK_APP_ID=THAY_META_APP_ID
FACEBOOK_APP_SECRET=THAY_META_APP_SECRET
FACEBOOK_GRAPH_API_VERSION=v26.0
FACEBOOK_VERIFY_TOKEN=THAY_CHUOI_NGAU_NHIEN
FACEBOOK_OAUTH_REDIRECT_URI=https://chat.example.com/api/channels/facebook-page/oauth/callback
FACEBOOK_PERSONAL_ENABLED=false
```

Trong [Meta App Dashboard](https://developers.facebook.com/apps/):

1. Tạo/chọn Meta App có các sản phẩm/quyền Facebook Login và Messenger phù hợp. Lấy App ID/Secret của app đó.
2. Trong cấu hình Login, thêm **Valid OAuth Redirect URI**:

   ```text
   https://chat.example.com/api/channels/facebook-page/oauth/callback
   ```

3. Khai báo domain HTTPS trong cấu hình domain/login khi dashboard yêu cầu.
4. Trong **Webhooks/Messenger**, chọn object **Page**, đặt **Callback URL**:

   ```text
   https://chat.example.com/api/channels/facebook-page/webhook
   ```

5. Ô **Verify Token** phải trùng `FACEBOOK_VERIFY_TOKEN`. Backend trả challenge xác minh; không dùng App Secret làm verify token.
6. Đăng ký `messages`, `message_echoes`, `message_deliveries`, `message_reads`, `messaging_postbacks`. Cấp các quyền mà adapter dùng: `pages_show_list`, `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`. App Review/Advanced Access và vai trò của người cấp quyền phụ thuộc use case và trạng thái ứng dụng.
7. Khởi động lại dev; mở **Messenger → Facebook Page** (`/facebook/page`), cấp quyền và chọn Page trong danh sách được Meta trả về. Page access token lấy qua OAuth; không cần tự thêm token Page vào env.

`FACEBOOK_PERSONAL_ENABLED=true` không tạo hỗ trợ Messenger cá nhân: adapter này vẫn chưa khả dụng. Xem [hướng dẫn Page](facebook-page-setup.md) và [Meta Messenger Webhooks](https://developers.facebook.com/docs/messenger-platform/webhooks/).

<a id="tiktok-business"></a>

## 6. TikTok Business

```dotenv
TIKTOK_BUSINESS_ENABLED=true
TIKTOK_BUSINESS_APP_ID=THAY_APP_ID
TIKTOK_BUSINESS_APP_SECRET=THAY_APP_SECRET
TIKTOK_BUSINESS_AUTHORIZATION_URL=THAY_FULL_TIKTOK_ACCOUNT_HOLDER_AUTHORIZATION_URL
TIKTOK_BUSINESS_REDIRECT_URI=https://chat.example.com/api/channels/tiktok-business/oauth/callback
```

1. Trong [TikTok API for Business](https://business-api.tiktok.com/portal/), tạo/chọn app và đăng ký quyền **Business Messaging API**. App và tài khoản cần đủ điều kiện TikTok, không chỉ chuyển tài khoản thường sang Business.
2. Điền **TikTok account holder redirect URL**:

   ```text
   https://chat.example.com/api/channels/tiktok-business/oauth/callback
   ```

3. Sao chép **TikTok account holder authorization URL** đầy đủ từ dashboard vào `TIKTOK_BUSINESS_AUTHORIZATION_URL`. Không dùng Advertiser Marketing OAuth hay một link Login Kit tự ghép cho sản phẩm khác. Nếu link chứa `redirect_uri`, giá trị phải khớp callback đã cấu hình.
4. Webhook của easyChat là:

   ```text
   https://chat.example.com/api/channels/tiktok-business/webhook
   ```

5. Backend suy ra webhook từ origin của `TIKTOK_BUSINESS_REDIRECT_URI` và đăng ký sự kiện `DIRECT_MESSAGE` khi kết nối. Đối chiếu cấu hình webhook trên dashboard. Adapter hiện yêu cầu HTTPS không có cổng tùy chỉnh.
6. Sau khi được cấp quyền, khởi động lại dev và mở **TikTok Business** (`/tiktok/business`) để cấp quyền tài khoản. Backend kiểm tra scope, profile/advanced access và API trước khi xác nhận kết nối.

Các scope adapter cần gồm `message.list.read`, `message.list.send`, `message.list.manage`, `user.account.type`, `user.info.basic`. `ENABLED=true` không bỏ qua xét duyệt. Xem [TikTok setup](tiktok-setup.md) và [quy trình Business Messaging chính thức](https://business-api.tiktok.com/portal/docs/business-messaging-api-get-started/v1.3).

<a id="tiktok-shop"></a>

## 7. TikTok Shop

```dotenv
TIKTOK_SHOP_ENABLED=true
TIKTOK_SHOP_APP_KEY=THAY_APP_KEY
TIKTOK_SHOP_APP_SECRET=THAY_APP_SECRET
TIKTOK_SHOP_AUTHORIZATION_URL=THAY_FULL_SELLER_AUTHORIZATION_URL
TIKTOK_SHOP_REDIRECT_URI=https://chat.example.com/api/channels/tiktok-shop/oauth/callback
```

1. Trong [TikTok Shop Partner Center](https://partner.tiktokshop.com/), tạo/chọn **seller app** và xin quyền **Customer Service**. Quyền Shop thông thường chưa đủ cho nhắn tin.
2. Đăng ký Seller redirect URL:

   ```text
   https://chat.example.com/api/channels/tiktok-shop/oauth/callback
   ```

3. Sao chép App Key/Secret và **Seller authorization URL** đúng app/thị trường vào env. Adapter nhận URL `/open/authorize` trên `services.tiktokshop.com` hoặc `services.us.tiktokshop.com`; không dùng link Creator/Partner khác loại.
4. Webhook:

   ```text
   https://chat.example.com/api/channels/tiktok-shop/webhook
   ```

5. Chuẩn bị quyền `seller.customer_service`, `seller.authorization.info` và quyền Events API tương ứng. Các topic được dùng là `NEW_MESSAGE`, `NEW_CONVERSATION`, `SELLER_DEAUTHORIZATION`; backend đăng ký/đọc lại bằng Events API. Webhook dùng cùng origin với callback và HTTPS không có cổng tùy chỉnh.
6. Khởi động lại dev, mở **TikTok Shop** (`/tiktok/shop`), seller cấp quyền và chọn shop trong danh sách được trả về. Thêm shop khác bằng một lượt cấp quyền mới; không tự nhập shop cipher/token vào env.

Nguồn: [tạo ứng dụng Shop](https://partner.us.tiktokshop.com/docv2/page/create-your-app), [Customer Service overview](https://partner.us.tiktokshop.com/docv2/page/659645f9a46cdd02bc8aeacf). Chi tiết và giới hạn: [TikTok setup](tiktok-setup.md).

<a id="telegram-bot"></a>

## 8. Telegram Bot

```dotenv
TELEGRAM_BOT_ENABLED=true
TELEGRAM_BOT_WEBHOOK_BASE_URL=https://chat.example.com
```

1. Tạo bot qua [BotFather](https://core.telegram.org/bots/features#botfather) và lấy Bot Token.
2. `TELEGRAM_BOT_WEBHOOK_BASE_URL` chỉ cần origin HTTPS như mẫu, không thêm `/api` hay tên bot. Backend tạo endpoint:

   ```text
   https://chat.example.com/api/channels/telegram-bot/<accountId>/webhook
   ```

3. Khởi động lại dev, mở **Telegram → Bot** (`/telegram/bot`) và nhập Bot Token trong form kết nối.
4. Backend gọi `getMe`, tự đăng ký `setWebhook` với secret riêng rồi kiểm tra `getWebhookInfo`. Không cần điền URL thủ công trong BotFather, không có biến `TELEGRAM_BOT_TOKEN` trong env của dự án.
5. Mở Telegram, bắt đầu tương tác với bot rồi nhắn tin. Inbox của bot chỉ có các tương tác mà Bot API cho phép, không có hộp thư cá nhân/lịch sử tùy ý.

Không chạy một chương trình `getUpdates` khác đồng thời với webhook. Việc kết nối sẽ đặt nơi nhận update của bot về easyChat. HTTPS webhook và `secret_token` theo [Telegram Bot API](https://core.telegram.org/bots/api#setwebhook).

<a id="telegram-ca-nhan"></a>

## 9. Telegram cá nhân

Telegram cá nhân dùng TDLib chính thức; không có OAuth redirect hoặc webhook công khai cho luồng đăng nhập này.

1. Đăng nhập [my.telegram.org](https://my.telegram.org), mở **API development tools**, tạo ứng dụng để lấy API ID và API Hash theo [hướng dẫn Telegram](https://core.telegram.org/api/obtaining_api_id).
2. Build native trên Linux. Ví dụ Debian/Ubuntu, tại thư mục gốc repository:

   ```bash
   sudo apt-get update
   sudo apt-get install -y build-essential cmake gperf libssl-dev zlib1g-dev curl ca-certificates python3
   bash native/telegram/build-tdlib.sh
   python3 native/telegram/smoke.py
   ```

3. Điền backend env:

   ```dotenv
   TELEGRAM_PERSONAL_ENABLED=true
   TELEGRAM_API_ID=123456
   TELEGRAM_API_HASH=THAY_API_HASH
   TELEGRAM_TDLIB_BRIDGE_PATH=../../native/telegram/build/tdjson-bridge
   TELEGRAM_TDJSON_LIBRARY=../../.local/tdlib/lib/libtdjson.so
   TELEGRAM_DATA_DIR=../../.local/telegram
   TELEGRAM_RPC_SOCKET=../../.local/telegram/worker.sock
   ```

4. Thay `123456` bằng API ID dạng số của bạn, không phải số điện thoại. Các đường dẫn tương đối tính từ `apps/api` khi dùng lệnh pnpm của repo; production nên dùng đường dẫn tuyệt đối và giữ thư mục dữ liệu bền vững.
5. Khởi động lại bộ dev, mở **Telegram → Cá nhân** (`/telegram/personal`), nhập số có mã quốc gia, mã xác nhận và 2FA nếu TDLib yêu cầu. Chỉ xác nhận kết nối khi xác thực hoàn tất.

Native artifact không được commit sẵn nên clone repo và `pnpm install` chưa đủ cho Telegram cá nhân. Build có thể tốn thời gian/dung lượng; script khóa revision và kiểm tra checksum. Smoke test native chỉ kiểm tra thư viện, không đăng nhập hoặc gửi tin. Hướng dẫn Linux/Docker và vận hành: [Telegram setup](telegram-setup.md).

<a id="whatsapp-business"></a>

## 10. WhatsApp Business

Kênh này dùng **WhatsApp Business Cloud API**, không đăng nhập WhatsApp cá nhân bằng QR.

```dotenv
WHATSAPP_ENABLED=true
WHATSAPP_GRAPH_API_VERSION=v27.0
WHATSAPP_META_APP_ID=THAY_META_APP_ID
WHATSAPP_META_APP_SECRET=THAY_META_APP_SECRET
WHATSAPP_WEBHOOK_VERIFY_TOKEN=THAY_CHUOI_NGAU_NHIEN
WHATSAPP_WEBHOOK_CALLBACK_URL=https://chat.example.com/api/webhooks/whatsapp
WHATSAPP_EMBEDDED_SIGNUP_ENABLED=false
WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID=
```

Phiên bản Graph trên là cấu hình đang pin trong repo, không phải hướng dẫn tự nâng lên phiên bản mới nhất.

Trong [Meta App Dashboard](https://developers.facebook.com/apps/):

1. Thêm/chọn sản phẩm WhatsApp Business Platform, lấy App ID/Secret của app đó.
2. Trong WhatsApp/Webhooks, chọn object **whatsapp_business_account**. Ô **Callback URL** điền:

   ```text
   https://chat.example.com/api/webhooks/whatsapp
   ```

3. Ô **Verify Token** điền đúng `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, bấm xác minh/lưu. Đây là callback **webhook**, không phải OAuth callback.
4. Subscribe field **messages** để nhận tin và trạng thái giao nhận. Nếu dùng Embedded Signup, bổ sung `account_update`; có thể đăng ký `message_template_status_update` cho cập nhật mẫu.
5. Trong **WhatsApp → API Setup/Testing**, lấy **WABA ID**, **Phone Number ID** và access token có quyền `whatsapp_business_management`, `whatsapp_business_messaging` với đúng app/số.
6. Khởi động lại dev, mở **WhatsApp → Business Cloud API** (`/whatsapp`). Nhập WABA ID, Phone Number ID và token ở form **kết nối trực tiếp**. Nhập PIN 6 chữ số nếu số cần đăng ký Cloud API. Những giá trị theo tài khoản này không phải biến env toàn cục.
7. Backend kiểm tra token, số, webhook và WABA subscription trước khi xác nhận kết nối. Với số thử nghiệm, thêm/xác minh test recipient trong Meta Dashboard rồi kiểm tra nhận/trả lời trong phạm vi được phép.

Luồng kết nối trực tiếp không có endpoint OAuth callback riêng để bạn điền. **Embedded Signup** là tùy chọn nâng cao: chỉ bật khi app đã có cấu hình/quyền phù hợp, điền `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID`, dùng frontend HTTPS và cấu hình domain/redirect URI cho Meta Login for Business theo [hướng dẫn WhatsApp](whatsapp-setup.md). Không tự tạo `/api/whatsapp/callback` vì repo không triển khai route đó.

Có thể dùng chung Meta App ID/Secret với Facebook Page nếu app có đủ sản phẩm/quyền, nhưng vẫn điền hai nhóm biến tương ứng. Verify Token, webhook endpoint và token của từng kênh được cấu hình riêng.

## 11. Kiểm tra sau khi cấu hình

1. Database đang chạy, migration đã áp dụng và chỉ có một worker chung.
2. Đã khởi động lại API/worker/frontend sau khi sửa env; đăng nhập bằng đúng `FRONTEND_URL`.
3. Trang kênh hết trạng thái **Chưa cấu hình**. Với kênh cần OAuth, bắt đầu bằng nút kết nối và hoàn tất lựa chọn tài khoản.
4. Tài khoản có tên/ID và trạng thái kết nối thật. Trang bật cờ tính năng hoặc webhook verify thành công chưa đủ để chứng minh đã nhận tin.
5. Dùng một tài khoản thử được nhà cung cấp cho phép để gửi tin mới vào kênh. Trong Inbox, chọn đúng kênh/tài khoản hoặc **Tất cả**, kiểm tra người nhận và số chưa đọc.
6. Gửi trả lời/tệp trong giới hạn kênh, kiểm tra kết quả ở cả easyChat và ứng dụng gốc. Nút Tài liệu/Âm thanh nằm phía trên ô nhập; [bảng giới hạn](media-attachments.md) nêu kênh nào chưa hỗ trợ.

Không có credentials vẫn có thể chạy kiểm thử mock; kết quả test không thay thế bước nghiệm thu OAuth, quyền, webhook công khai và nhận/gửi thật. Các trang dashboard có thể đổi tên menu; endpoint và tên biến trong hướng dẫn được đối chiếu với mã easyChat hiện tại.
