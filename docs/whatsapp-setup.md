# Thiết lập WhatsApp Business trong easyChat

WhatsApp được thêm vào inbox hiện có, dùng cùng bộ lọc tài khoản, số chưa đọc, SSE và worker. Bạn có thể kết nối nhiều WABA/số điện thoại đã được cấp quyền; token mã hóa riêng từng số. Chưa có credentials Meta trong môi trường hiện tại nên chưa thử gửi/nhận thật.

## 1. Chạy dự án

Tại thư mục repository `easy-chat`:

```bash
pnpm install
docker compose up -d postgres
pnpm --filter @zalo/shared build
pnpm --filter @zalo/api db:generate
pnpm --filter @zalo/api db:deploy
pnpm dev
```

Web: `http://localhost:5173`, API: cổng 3000. `pnpm dev` đã chạy thì dùng nhóm đó, tránh chạy thêm nhóm thứ hai gây trùng cổng/worker. Dự án thực tế dùng **PostgreSQL transactional outbox**, không có Redis/BullMQ nên không cần khởi động Redis riêng. Một worker chung có PostgreSQL advisory lease, phục vụ tất cả kênh. Giữ COMPOSE_PROJECT_NAME/volume PostgreSQL hiện tại; không reset database.

## 2. Cấu hình Meta App và HTTPS

Tạo/dùng Meta App có sản phẩm WhatsApp Business Platform. Nếu dùng chung Meta App với Facebook Page thì có thể cấu hình cùng App ID/Secret cho hai tích hợp; credential và scopes từng channel vẫn tách riêng. Token Facebook Page bị từ chối cho kết nối WhatsApp.

Trong `apps/api/.env`, thêm thông tin thật:

```dotenv
WHATSAPP_ENABLED=true
WHATSAPP_GRAPH_API_VERSION=v27.0
WHATSAPP_META_APP_ID=
WHATSAPP_META_APP_SECRET=
WHATSAPP_WEBHOOK_VERIFY_TOKEN=
WHATSAPP_WEBHOOK_CALLBACK_URL=https://api.example.com/api/webhooks/whatsapp

WHATSAPP_EMBEDDED_SIGNUP_ENABLED=false
WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID=
```

Có thể tạo verify token bằng `openssl rand -hex 32`, lưu vào env và cấu hình cùng giá trị ở Meta Console. Không đưa App Secret/access token vào Vite env hoặc Git. Dùng lại DATABASE_URL, TOKEN_ENCRYPTION_KEY, SESSION_SECRET hiện có; giữ khóa mã hóa ổn định khi restart.

Callback phải HTTPS công khai, đúng đường dẫn `/api/webhooks/whatsapp`, không query/fragment. Có thể dùng reverse proxy/tunnel cho môi trường phát triển; expose API webhook, không expose database. Khởi động lại API/worker sau khi đổi env.

Trong Meta App Dashboard → WhatsApp / Webhooks:

1. Chọn object **whatsapp_business_account**.
2. Đặt callback URL và verify token như trên; hoàn tất challenge.
3. Bật field **messages** (bao gồm incoming và delivery status).
4. Bật **account_update** nếu dùng Embedded Signup.
5. Nên bật **message_template_status_update** để cập nhật phản hồi trạng thái mẫu nhanh hơn.

easyChat kiểm tra subscription app đang active và URL đúng trước khi CONNECTED; backend còn POST/GET `/{WABA_ID}/subscribed_apps` để đăng ký/xác minh app trên WABA. Chỉ có env hoặc challenge thành công chưa đủ để coi một số đã kết nối.

## 3. Kết nối trực tiếp / số thử nghiệm

Lấy từ WhatsApp → API Setup/Testing trong Meta App Dashboard:

- WABA ID (WhatsApp Business Account ID).
- Phone Number ID của số Cloud API.
- Access token của user/system user được cấp quyền với đúng Meta App và WABA/số đó.
- Với số chưa đăng ký: xác minh sở hữu số theo flow Meta, chuẩn bị PIN 6 chữ số đã chọn cho two-step verification/registration.

Quyền MVP yêu cầu: **whatsapp_business_management** và **whatsapp_business_messaging**. Chỉ thêm business_management nếu triển khai thao tác business portfolio khác thực sự cần nó. Để dùng số thật/doanh nghiệp khác, hoàn tất các bước verification, mode Live, App Review/Advanced Access/Tech Provider do Meta yêu cầu cho app và use case của bạn. Có access token không đồng nghĩa mọi doanh nghiệp/người nhận đều đủ điều kiện.

Mở **Ứng dụng → WhatsApp → Business Cloud API** hoặc `/whatsapp`. Trong phần kết nối trực tiếp nhập WABA ID, Phone Number ID, token và PIN nếu cần. Token/PIN xóa khỏi form sau submit. Token được mã hóa theo account; PIN chỉ dùng trong request đăng ký và không lưu trong ứng dụng—hãy giữ PIN an toàn ở phía bạn.

Backend debug token, xác minh app/scopes/expiry, WABA phone membership, Cloud API registration, app webhook và WABA subscription. Chỉ sau khi các bước cần thiết thành công mới trả CONNECTED. Lỗi đăng ký/quyền/subscription được hiển thị rõ; account dang dở có thể giữ ERROR để bạn kết nối lại cùng số sau khi sửa cấu hình.

Meta test number chỉ gửi tới những test recipient được thêm/xác minh trong dashboard. Gói thử nghiệm và giới hạn do Meta kiểm soát. Token thử nghiệm thường ngắn hạn; production nên dùng token hệ thống/BIS đúng mục đích. Backend không bịa API refresh token: hết hạn/thu hồi yêu cầu cấp quyền lại.

## 4. Embedded Signup v4 (khi app đủ điều kiện)

Theo [hướng dẫn chính thức](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation/):

1. Hoàn tất điều kiện Tech Provider/Solution Partner, business/access verification và review quyền liên quan.
2. Tạo cấu hình **Facebook Login for Business → WhatsApp Embedded Signup**, chọn sản phẩm Cloud API và các assets/permissions thực sự dùng. Ghi Configuration ID.
3. Bật Client/Web OAuth Login, Enforce HTTPS, Embedded Browser OAuth Login, Strict Mode và JavaScript SDK. Thêm các domain frontend vào Allowed Domains và Valid OAuth Redirect URIs theo Meta.
4. Dùng `FRONTEND_URL` HTTPS thực tế và cấu hình CORS/cookie/reverse proxy phù hợp. Localhost HTTP vẫn dùng được direct connection, nhưng Embedded Signup bị vô hiệu hóa.
5. Đặt `WHATSAPP_EMBEDDED_SIGNUP_ENABLED=true`, `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID=…`, đảm bảo field account_update được đăng ký rồi restart.

Trang WhatsApp có bước chuẩn bị SDK rồi **Tiếp tục với Meta** bằng click trực tiếp để tránh popup bị trình duyệt chặn. Official JavaScript SDK chỉ tải tại trang này khi chuẩn bị kết nối; không chạy browser automation. Code được gửi ngay đến backend để đổi token, không chờ bạn nhập PIN hay lưu code trong localStorage/mutation cache. Sau đó chọn WABA/số được token cấp quyền, nhập PIN nếu cần đăng ký, hoàn tất kết nối. IDs từ postMessage chỉ là gợi ý; backend kiểm tra lại quyền truy cập bằng Meta API.

State easyChat single-use, gắn admin session/owner, TTL 5 phút. Token selection mã hóa, TTL 10 phút và xóa khi chọn số; worker dọn authorization hết hạn. Đăng xuất xóa selection theo admin session hiện có. Hủy/deny/expiry/Meta error không tạo kết nối thành công giả. Phiên chọn số đã dùng mà bước đăng ký thất bại có thể cần bắt đầu signup lại hoặc dùng direct connection với token hợp lệ.

## 5. Nhận, trả lời và dùng mẫu

1. Từ WhatsApp của test recipient được Meta cho phép, nhắn tới số doanh nghiệp.
2. Tin qua webhook HMAC hợp lệ được lưu receipt trước HTTP 200; worker persist conversation/message, local unread và SSE.
3. Mở Inbox, chọn **Tất cả** hoặc đúng tài khoản WhatsApp Business. Mỗi số có lịch sử/contact riêng; cùng khách hàng ở số khác không bị ghép nhầm.
4. Khi cửa sổ 24 giờ từ tin khách hàng gần nhất còn mở, composer cho trả lời văn bản. Kiểm tra được thực hiện lại trước khi worker POST; tin đi hoặc delivery status không mở cửa sổ.
5. Ngoài cửa sổ, composer freeform bị khóa. Chọn **Chọn mẫu WhatsApp**, chọn template APPROVED, điền biến và xác nhận người nhận đã đồng ý nhận loại thông báo phù hợp. Không có campaign/bulk send tự động.

MVP hỗ trợ template Utility/Marketing văn bản, HEADER dạng TEXT, BODY và FOOTER, biến positional/named. Mẫu chưa duyệt/tạm dừng hoặc có media/buttons/authentication chưa được hỗ trợ gửi và được gắn nhãn. Backend tải định nghĩa thật theo WABA và kiểm tra lại approval/variables trước POST. Consent checkbox là xác nhận của operator được lưu theo intent; doanh nghiệp cần có căn cứ đồng ý thực tế và tuân thủ quy định Meta/khu vực. Các mã Meta hạn chế người nhận/marketing được giữ nguyên nhóm lỗi, không tự đổi loại tin để vượt chính sách.

“Meta đã nhận yêu cầu” chỉ phản ánh ACK có wamid; sent/delivered/read đến từ webhook. Đã đọc của người nhận, đã đọc trong easyChat và thao tác agent báo đọc tin nhận trên WhatsApp là ba trạng thái riêng. Trong **Thông tin hội thoại → Báo đã đọc trên WhatsApp**, bạn có thể yêu cầu mark-read cho tin nhận gần nhất đang tải. Background sync/mở chat không tự gọi thao tác này.

## 6. Media, context và lịch sử

Ảnh/document/audio/video/sticker đầu vào lưu metadata/media ID trong Message hiện có. Preview/download đi qua endpoint cookie/owner-authenticated, lấy URL ngắn hạn từ Meta ở backend và kiểm tra MIME, size, SHA256. Provider URL/token không trả ra browser. Cache-Control private/no-store và Content-Disposition phù hợp; không đặt file riêng tư trong public/Vite static.

Repository chưa có object/file store; MVP dùng proxy tải theo yêu cầu, không tạo hệ thống lưu trữ thứ hai hay hứa giữ file gốc vĩnh viễn. Giới hạn ứng dụng: ảnh JPEG/PNG 5 MB, WebP sticker 500 KB, audio/video 16 MB, document tối đa 20 MB (thấp hơn một số giới hạn provider). Khi token/media hết hiệu lực, nội dung text/metadata vẫn giữ, preview có thể không tải được. ID media gửi lên có thời hạn 30 ngày; ID từ webhook nhận có thời hạn 7 ngày theo tài liệu Meta hiện tại. easyChat không lưu bản sao file lâu dài. Cần object storage riêng nếu doanh nghiệp cần lưu trữ file vượt thời hạn này.

Trong cuộc chat WhatsApp còn cửa sổ trả lời, chọn **Tài liệu** hoặc **Âm thanh**, chọn một file rồi bấm **Gửi**:

- Tài liệu: PDF, TXT UTF-8, DOC/DOCX, XLS/XLSX, PPT/PPTX; tối đa 20 MB; chú thích tối đa 1024 ký tự.
- Âm thanh: AAC, AMR, MP3, M4A, OGG Opus mono; tối đa 16 MB. Âm thanh không kèm chú thích; gửi văn bản thành tin riêng. Chưa có ghi âm micro trực tiếp.
- Backend kiểm tra extension, MIME, dấu hiệu định dạng trong bytes và dung lượng. Kiểm tra này không thay thế quét malware/chuyển mã codec đầy đủ; Meta vẫn có thể từ chối file mã hóa không hợp lệ.
- Backend upload multipart qua `POST /PHONE_ID/media`, lưu media ID vào Message rồi queue SEND trong outbox hiện có. Chỉ worker POST tin `document`/`audio`; không gửi trực tiếp từ request upload. Cửa sổ và quyền được kiểm tra lại lúc worker gửi.
- Request lặp với cùng idempotency key và cùng file/chú thích trả lại một intent; nội dung khác trả conflict. Khi mất phản hồi, **Kiểm tra yêu cầu** dùng lại đúng file/key. Upload thất bại không tạo SEND. Một upload đã thành công nhưng transaction không commit có thể để lại asset không dùng tại Meta đến khi hết hạn; không tự gửi tin.
- Tài liệu nhận/gửi có nút tải; âm thanh có trình phát và liên kết file gốc. Một số codec không phát được trong trình duyệt vẫn có thể tải file. Nút đính kèm đã được mở rộng cho các kênh khác theo [bảng khả năng media đa kênh](media-attachments.md); mỗi adapter có loại/cỡ tệp và quyền riêng.

API gửi text chung hỗ trợ `replyToMessageId` trong cùng conversation; backend lấy external wamid để gửi context. Tin nhận lưu context chính thức. UI composer hiện gửi text thông thường; thao tác chọn trích dẫn tin cụ thể qua UI chưa được triển khai.

Cloud API tiêu chuẩn nhận dữ liệu từ thời điểm tích hợp và đọc lịch sử đã lưu ở PostgreSQL, phân trang bằng API inbox chung. Nút **Kiểm tra kết nối** xác minh token/phone/webhook, không giả tải lịch sử WhatsApp cũ. Endpoint sync conversation trả lỗi rõ rằng Cloud API không có general history API.

## 7. Coexistence và ngắt kết nối

Coexistence Business App cần onboarding, eligibility và authorization history riêng. Hiện chưa bật; số `is_on_biz_app=true` và phiên signup Business App bị từ chối để không đăng ký lại/deregistration sai hoặc nhận lịch sử chưa được cho phép. Không subscribe history/smb_app_state_sync/smb_message_echoes. Xem [research](whatsapp-api-research.md).

Ngắt một số xóa credential cục bộ, hủy pending work, giữ lịch sử. WABA subscription chỉ gỡ khi không còn số active khác của easyChat cùng WABA. Backend không deregister số, xóa WABA, hoặc thu hồi toàn bộ Meta grant/token dùng chung; các thao tác đó có thể ảnh hưởng Business App, số khác hoặc hệ thống khác. Muốn thu hồi toàn bộ quyền tại Meta, thực hiện trong Business Integrations/Business Settings sau khi kiểm tra các tích hợp đang dùng.

Nếu Meta không xác nhận unsubscribe, UI báo cleanup chưa xác nhận; local token vẫn bị xóa và webhook của số đã ngắt không được xử lý vào inbox. Token đã copy/backup ngoài easyChat phải được thu hồi tại Meta khi cần. Không tuyên bố local disconnect làm token toàn cầu mất hiệu lực.

## 8. Vận hành và kiểm chứng thật

Worker dùng chung lease; ACK webhook chỉ sau receipt durable. Lỗi retry an toàn có backoff giới hạn 3 lần; HTTP timeout/5xx/malformed ACK khi gửi → UNKNOWN, không tự POST lại. Spam restrictions không tự retry. Meta có thể gửi webhook nhiều lần/sai thứ tự; DB dedupe + monotonic status bảo vệ dữ liệu. Mỗi lần POST có callback riêng theo message ID + UUID; thử lại tin FAILED xóa wamid cũ, bỏ qua status muộn của lần cũ. UNKNOWN không được tự gửi lại. Status chưa map được giữ FAILED với attempts/error để điều tra, không tạo tin gửi giả. Webhook receipts cần chính sách retention/monitoring phù hợp; không log token, raw payload hoặc nội dung tin nhắn.

Sau khi có credentials, kiểm chứng bằng số test thật: challenge, subscription, inbound, SSE/unread, reply trong cửa sổ, delivered/read webhook, approved template, đóng cửa sổ, restart rồi disconnect. Không xem mock tests là live provider verification. [Báo cáo triển khai/kiểm thử](whatsapp-validation.md) ghi rõ phần đã chạy và giới hạn còn lại.
