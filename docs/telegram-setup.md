# Telegram trong easyChat

Hai kết nối dùng chung hộp thư, bộ lọc tài khoản, số chưa đọc, PostgreSQL outbox, worker và SSE của easyChat:

- **Telegram Bot**: Bot API chính thức qua HTTPS; mỗi bot có token mã hóa riêng.
- **Telegram cá nhân**: TDLib chính thức, một tiến trình native riêng cho mỗi tài khoản. Tối đa 5 bản ghi tài khoản cá nhân cho mỗi chủ workspace, có thể kết nối lại bản ghi cũ.

Mã nguồn và kiểm thử đã tích hợp. Đăng nhập/gửi tin Telegram thật cần thông tin ứng dụng hoặc Bot Token của bạn. Xem [kết quả kiểm chứng](telegram-validation.md).

## Chạy dự án hiện tại

Tại thư mục gốc repository `easy-chat`:

```bash
pnpm install
docker compose up -d postgres
pnpm --filter @zalo/shared build
pnpm --filter @zalo/api db:generate
pnpm --filter @zalo/api db:deploy
pnpm dev
```

Một lệnh `pnpm dev` chạy web, API và **một** worker dùng chung. Nếu nhóm tiến trình này đang chạy thì sử dụng nhóm đó; chạy thêm lần nữa sẽ trùng cổng 3000 hoặc lease worker. Web ở `http://localhost:5173`, API ở cổng 3000. Giữ `COMPOSE_PROJECT_NAME` hiện tại nếu đang dùng volume PostgreSQL cũ; không đổi tên volume/reset database.

## Telegram Bot

1. Tạo bot qua [BotFather](https://core.telegram.org/bots/features#botfather), lấy Bot Token.
2. Cung cấp HTTPS công khai trỏ tới API, ví dụ reverse proxy hoặc tunnel của bạn. Cho phép POST đến `/api/channels/telegram-bot/:accountId/webhook`; tunnel phải hoạt động khi nhận tin.
3. Trong `apps/api/.env`, cấu hình:

```dotenv
TELEGRAM_BOT_ENABLED=true
TELEGRAM_BOT_WEBHOOK_BASE_URL=https://chat.example.com
```

4. Khởi động lại nhóm dev/worker nếu thay env. Trong web chọn **Ứng dụng → Telegram → Bot**, nhập token và kết nối.
5. Backend xác minh `getMe`, đăng ký `setWebhook`, rồi kiểm tra `getWebhookInfo`. Trang kết nối có nút kiểm tra webhook, tên/username bot, hộp thư và ngắt kết nối.
6. Gửi một tin tới bot từ Telegram để xuất hiện cuộc chat. Sau đó trả lời từ easyChat.

Token được lưu AES-256-GCM trong `ChannelAccount.encryptedCredentials`, không đưa vào biến Vite. Secret header webhook ngẫu nhiên riêng cho từng bot. Backend xác minh `X-Telegram-Bot-Api-Secret-Token` trước khi lưu receipt/ACK. Hệ thống dùng webhook, không chạy `getUpdates` đồng thời. `setWebhook` chuyển nơi nhận update của bot về easyChat; ngắt kết nối gọi `deleteWebhook`, giữ lịch sử trong easyChat và xóa credential cục bộ. Nếu Telegram không xác nhận xóa webhook, giao diện báo lỗi cleanup; webhook cũ bị từ chối sau khi ngắt.

Webhook cần HTTPS; port được Bot API hỗ trợ là 443, 80, 88, 8443. URL base không chứa username, password, query hay fragment. Chỉ mở endpoint nhận update ra Internet; bảo vệ các endpoint quản trị bằng phiên đăng nhập hiện có.

Bot nhận dữ liệu trong phạm vi tương tác, quyền nhóm và privacy mode của Telegram. Bot API không cung cấp hộp thư cá nhân hoặc tải lịch sử cũ tùy ý. Nhóm forum/topic chỉ đọc trong MVP. Xem [Bot API](https://core.telegram.org/bots/api) và [Bot FAQ](https://core.telegram.org/bots/faq).

## Telegram cá nhân: build native Linux

Chỉ dùng [TDLib chính thức](https://github.com/tdlib/td) qua JSON/C, không cài Telegram SDK bên thứ ba. Bản nguồn đã khóa:

```text
revision: 4c6377aa7386c39217878a9a56d581922ad37ca4
archive SHA256: 472015605fffa826bfba6ccf7d888905b436ecce94c8a6826203792edfbe5731
runtime version kiểm chứng: 1.8.69
```

Yêu cầu: Linux, C++17 compiler, CMake, make, gperf, OpenSSL development, zlib development, curl, tar, sha256sum. Python 3 chỉ dùng cho smoke test. Ví dụ Debian/Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y build-essential cmake gperf libssl-dev zlib1g-dev curl ca-certificates python3
bash native/telegram/build-tdlib.sh
python3 native/telegram/smoke.py
```

Build mặc định một luồng và `-O1` để giảm RAM; có thể đặt `TDLIB_BUILD_JOBS` phù hợp máy. Native build có thể tốn vài phút và nhiều GB đĩa. Script tải archive từ repository chính thức, kiểm tra SHA256, build `libtdjson`, giữ license rồi build bridge C++ tối thiểu. Artifact ở `.local/tdlib`, bridge ở `native/telegram/build/tdjson-bridge`; source/cache không đưa vào Git. Có thể đặt `GPERF_EXECUTABLE` và `TDLIB_INSTALL_PREFIX`.

Smoke test chỉ kiểm tra load thư viện, JSON/C ABI, version, trạng thái `authorizationStateWaitTdlibParameters` và đóng tiến trình. Nó không đăng nhập tài khoản hay chứng minh gửi tin thật.

## Cấu hình và đăng nhập cá nhân

Lấy API ID và API Hash của **ứng dụng easyChat của bạn** tại [my.telegram.org](https://my.telegram.org), theo [hướng dẫn Telegram](https://core.telegram.org/api/obtaining_api_id). Bổ sung ở backend:

```dotenv
TELEGRAM_PERSONAL_ENABLED=true
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_TDLIB_BRIDGE_PATH=../../native/telegram/build/tdjson-bridge
TELEGRAM_TDJSON_LIBRARY=../../.local/tdlib/lib/libtdjson.so
TELEGRAM_DATA_DIR=../../.local/telegram
TELEGRAM_RPC_SOCKET=../../.local/telegram/worker.sock
```

Đường dẫn tương đối tính từ working directory của tiến trình API/worker (`apps/api` khi dùng pnpm workspace). Production nên dùng đường dẫn tuyệt đối. Tên biến bổ sung nằm trong `.env.example` và `apps/api/.env.example`. Dùng lại `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `SESSION_SECRET` hiện có; giữ các khóa ổn định khi restart. Thay API ID cho phiên đã liên kết yêu cầu kết nối lại.

1. Khởi động API và worker chung. Mở **Ứng dụng → Telegram → Cá nhân**.
2. Đặt tên, bấm kết nối; nhập số có mã quốc gia (`+84…`).
3. TDLib chỉ định cách nhận mã, có thể qua ứng dụng Telegram đang đăng nhập hoặc phương thức Telegram cho phép. Nhập mã; nhập mật khẩu 2FA nếu được yêu cầu.
4. Khi TDLib yêu cầu email hoặc mã email, giao diện hiển thị đúng bước đó. Có lựa chọn xác nhận bằng thiết bị Telegram đang đăng nhập và mở liên kết `tg://login` do TDLib cung cấp. Premium/đăng ký tài khoản mới cần hoàn tất trong ứng dụng chính thức rồi thử lại.
5. Chỉ hiển thị **Đã kết nối** sau `authorizationStateReady` và `getMe` xác minh danh tính. Hội thoại/lịch sử được xếp lịch đồng bộ qua worker. Mở hộp thư và chọn tài khoản hoặc Tất cả.

OTP, 2FA, số điện thoại/email xác thực không được ghi vào PostgreSQL receipt/outbox, log ứng dụng, localStorage hay React Query mutation cache. API chuyển bước xác thực qua Unix socket nội bộ được ký HMAC, có nonce chống phát lại và thời hạn 30 giây. Phiên đăng nhập dang dở gắn với admin session đã khởi tạo, hết hạn tối đa 10 phút hoặc khi admin session hết hạn/đăng xuất. Socket 0600 và thư mục dữ liệu 0700 chỉ dành cho user chạy easyChat.

Mỗi account có thư mục `{TELEGRAM_DATA_DIR}/{channelAccountId}`, database TDLib mã hóa bằng khóa 32 byte ngẫu nhiên. Khóa này được mã hóa lại bằng CryptoService hiện có trong PostgreSQL. API Hash chỉ tồn tại ở env backend/worker. Native subprocess nhận cấu hình qua stdin, không qua argv/env; logging TDLib bị tắt, core dump bị tắt. Native files/session không được web server/Vite phục vụ.

Sau restart, worker dùng cùng thư mục và khóa database để khôi phục phiên, không tạo client mới cho mỗi HTTP request. Nếu Telegram thu hồi phiên, tài khoản chuyển sang yêu cầu xác thực lại. Ngắt kết nối yêu cầu `logOut`, đóng client, xóa thư mục phiên và credential; lịch sử đã lưu trong easyChat vẫn giữ. Nếu worker offline, backend báo cleanup chưa xác nhận; worker sẽ xóa dữ liệu tài khoản đã ngắt khi khởi động lại. Khi không thể xác nhận logout trên Telegram, người dùng có thể thu hồi phiên trong Telegram → Settings → Devices.

## Docker và triển khai

`native/telegram/Dockerfile` là multi-stage **artifact build**, có thể lấy thư viện/bridge để chép vào image ứng dụng hiện tại:

```bash
docker build --file native/telegram/Dockerfile --target artifacts --output type=local,dest=/tmp/easychat-telegram-native .
```

Runtime nên cùng họ glibc Debian bookworm và có `libssl3`, `zlib1g`, `libstdc++6`. Không chép binary build trên Arch vào Alpine/musl. Bản Dockerfile đã chuẩn bị; chưa chạy Docker build trong lần kiểm chứng này. Build trong đúng runtime/architecture sẽ tránh lệch ABI.

API và worker chạy cùng UID trên cùng host hoặc dùng chung volume Unix socket. Gắn volume bền vững cho `TELEGRAM_DATA_DIR`, socket đặt trên filesystem hỗ trợ Unix socket; không mount thư mục session vào web container. Ví dụ env production:

```dotenv
TELEGRAM_TDLIB_BRIDGE_PATH=/opt/easychat-native/bin/tdjson-bridge
TELEGRAM_TDJSON_LIBRARY=/opt/tdlib/lib/libtdjson.so
TELEGRAM_DATA_DIR=/var/lib/easychat/telegram
TELEGRAM_RPC_SOCKET=/var/lib/easychat/telegram/worker.sock
```

Chạy đúng **một worker chung** dùng PostgreSQL advisory lease hiện có; API có thể độc lập nhưng không khởi tạo TDLib. Bridge chạy process riêng nên native crash không làm API chết. Backup PostgreSQL, khóa mã hóa và volume TDLib một cách nhất quán; giữ khóa ngoài Git và giới hạn quyền truy cập backup.

## Phạm vi MVP và trạng thái tin

| Nội dung                             | Hành vi                                                                                                                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud private/basic group/supergroup | Đồng bộ chat, lịch sử phân trang, tin mới/từ thiết bị khác, sửa/xóa vĩnh viễn theo update                                                                                     |
| Secret Chat, broadcast channel       | Ngoài phạm vi; `use_secret_chats=false`                                                                                                                                       |
| Text reply                           | Đi qua outbox hiện có; kiểm tra chủ sở hữu, quyền chat và idempotency                                                                                                         |
| Media/avatar Telegram                | Nhận/tải tài liệu và audio/voice qua proxy riêng tư; gửi tài liệu/âm thanh qua worker. Ảnh đại diện Telegram chưa được tải bổ sung; xem [media đa kênh](media-attachments.md) |
| Forum/topic                          | Chưa hỗ trợ gửi; hiển thị đọc khi có dữ liệu                                                                                                                                  |
| Read/unread                          | Provider unread/watermark riêng với số chưa đọc trong easyChat; không gọi `viewMessages`/`openChat` khi sync hay xem chat                                                     |
| Read receipt                         | Chỉ suy ra `readAt` cho tin đi trong chat riêng khi watermark TDLib xác nhận; không tạo read receipt cá nhân cho nhóm                                                         |
| TDLib message pending                | Giữ `SENDING` đến update thành công; temp ID lưu để đối chiếu ACK muộn                                                                                                        |
| Kết quả gửi mơ hồ                    | `UNKNOWN`, không tự POST lại; kiểm tra Telegram trước khi quyết định thao tác khác                                                                                            |
| 429/FLOOD_WAIT                       | Lưu thời điểm được thử lại, tối đa 3 lần tự thử với lỗi chắc chắn có thể thử lại; không bulk send                                                                             |
| History lớn                          | 25 tin/trang, tối đa 100 trang mỗi lượt chạy và có checkpoint; chọn Thông tin hội thoại → Đồng bộ lịch sử Telegram để tiếp tục từ checkpoint                                  |

TDLib có thể tự tiếp tục xử lý tin đã nhận vào hàng đợi nội bộ sau reconnect. easyChat không gọi lại `sendMessage` cho intent `UNKNOWN`; update thành công muộn có thể xác nhận lại intent đó. Trạng thái `SENT` nghĩa là Telegram đã xác nhận tin, không đồng nghĩa người nhận đã xem.

Giữ receipt xóa vĩnh viễn để chống lịch sử đang tải làm xuất hiện lại tin đã xóa. Nếu triển khai chính sách dọn `WebhookEvent`, cần lưu tombstone thay thế trước khi xóa receipt Telegram loại `delete`.

Tuân thủ [Telegram API Terms](https://core.telegram.org/api/terms): chỉ truy cập tài khoản đã cấp quyền, dùng API ID của ứng dụng, giữ giới hạn flood/spam; dữ liệu Telegram không được dùng để huấn luyện AI trái điều khoản.
