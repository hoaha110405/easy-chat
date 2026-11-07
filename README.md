# easyChat

**easyChat là ứng dụng quản lý tin nhắn từ nhiều nền tảng trong cùng một hộp thư.** Bạn có thể kết nối nhiều tài khoản, xem tài khoản nào đang nhận tin và trả lời bằng đúng tài khoản đó.

Ứng dụng phù hợp với nhu cầu tập trung các cuộc trò chuyện của cá nhân hoặc cửa hàng. Bản hiện tại dùng một tài khoản quản trị cho workspace; chưa có phân quyền nhiều nhân viên hoặc chatbot tự động.

## Tính năng hiện có

- Hộp thư chung, lọc theo ứng dụng, một tài khoản hoặc **Tất cả tài khoản**.
- Hiển thị tên, ảnh đại diện người liên hệ và tài khoản đang nhận/trả lời tin.
- Đánh dấu tin chưa đọc, đếm theo hội thoại và tài khoản; cập nhật tin qua realtime.
- Xem ảnh, sticker, tài liệu và âm thanh khi nền tảng cung cấp dữ liệu tương ứng.
- Gửi tài liệu/âm thanh bằng nút **Tài liệu** và **Âm thanh** phía trên ô soạn tin, tùy khả năng từng kênh.
- Lưu hội thoại trong PostgreSQL; mã hóa token, phiên kết nối và tệp do ứng dụng lưu riêng tư.

| Kênh                                | Cách kết nối                          | Khả năng và giới hạn chính                                                                                                 |
| ----------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Zalo cá nhân                        | Quét QR trên điện thoại               | Hội thoại một-một; gửi văn bản, tài liệu và âm thanh. Dùng adapter `zca-js` không chính thức, có rủi ro hạn chế tài khoản. |
| Zalo OA                             | Zalo OAuth + webhook                  | Nhận/xem tin; gửi tài liệu theo quyền và cửa sổ trả lời. Chưa bật gửi văn bản/âm thanh từ easyChat.                        |
| Facebook Page                       | Meta OAuth + webhook                  | Nhận/trả lời văn bản, tài liệu, âm thanh theo quyền và cửa sổ nhắn tin.                                                    |
| TikTok Business                     | OAuth ứng dụng được duyệt             | Nhận/đồng bộ và trả lời văn bản. Chưa bật gửi tài liệu/âm thanh.                                                           |
| TikTok Shop                         | Seller OAuth + quyền Customer Service | Hội thoại khách mua hàng và trả lời văn bản trong phạm vi API cho phép.                                                    |
| Telegram Bot                        | Bot Token + webhook                   | Bot API chính thức; văn bản, tài liệu, âm thanh. Không phải hộp thư Telegram cá nhân.                                      |
| Telegram cá nhân                    | API ID/API Hash + TDLib               | API chính thức; cần build native TDLib riêng.                                                                              |
| WhatsApp Business                   | Meta Cloud API                        | Văn bản, tài liệu, âm thanh, mẫu tin; cần Meta App và số Cloud API đủ điều kiện.                                           |
| Messenger cá nhân, Instagram, Email | Chưa hỗ trợ                           | Chưa có luồng kết nối hoạt động trong bản này.                                                                             |

**Có mã tích hợp không có nghĩa tài khoản đã được kết nối.** Những kênh chưa điền thông tin ứng dụng hoặc chưa được nhà cung cấp cấp quyền sẽ hiện trạng thái chưa cấu hình. Xem [giới hạn tài liệu/âm thanh](docs/media-attachments.md).

<a id="bat-dau-sau-khi-clone"></a>

## Bắt đầu sau khi clone

### 1. Chuẩn bị

- Git.
- Node.js **22.12 trở lên**, theo `engines` của repository.
- pnpm **12.15.0**, theo `packageManager` của repository.
- Docker có Compose, hoặc PostgreSQL đã cài sẵn. Compose của dự án dùng PostgreSQL 17.
- Chỉ khi dùng Telegram cá nhân: môi trường Linux và các công cụ build TDLib trong [hướng dẫn cấu hình](docs/cau-hinh.md#telegram-ca-nhan).

Nếu chưa có pnpm, có thể cài bằng npm:

```bash
npm install --global pnpm@12.15.0
```

### 2. Tải mã và tạo cấu hình

Chạy các lệnh sau ở thư mục gốc repository:

```bash
git clone https://github.com/hoaha110405/easy-chat.git
cd easy-chat
pnpm install
pnpm env:init
```

`pnpm env:init` tạo hai file:

| File            | Dùng để làm gì?                                                             |
| --------------- | --------------------------------------------------------------------------- |
| `apps/api/.env` | Database, mật khẩu quản trị, khóa mã hóa, thông tin ứng dụng của từng kênh. |
| `apps/web/.env` | URL gọi API, proxy và hostname tunnel cho frontend.                         |

Lệnh tự sinh `ADMIN_PASSWORD`, `SESSION_SECRET` và `TOKEN_ENCRYPTION_KEY` ngẫu nhiên; **giữ nguyên file đã tồn tại**. Thông tin Zalo/Meta/TikTok/Telegram của bạn cần bổ sung sau. Mở `apps/api/.env` để xem mật khẩu đăng nhập; không cần chép mật khẩu vào frontend.

### 3. Khởi động database và áp dụng migration

```bash
docker compose up -d --wait postgres
pnpm db:generate
pnpm db:deploy
```

Database mặc định: `localhost:5432`, tên `zalo_inbox`, user/password `postgres` cho phát triển local. Nếu dùng PostgreSQL riêng, sửa `DATABASE_URL` trong `apps/api/.env` và bỏ qua lệnh Docker.

`db:deploy` áp dụng các migration đã có. Không cần tạo lại schema hoặc chạy `db:migrate` cho lần clone đầu tiên.

### 4. Chạy ứng dụng

```bash
pnpm dev
```

Lệnh này chạy **frontend + API + một worker chung**. Giữ terminal chạy và mở:

- Web: <http://localhost:5173>.
- Trang kết nối ứng dụng: <http://localhost:5173/apps>.
- API: `http://localhost:3000/api`.

Đăng nhập bằng `ADMIN_PASSWORD` trong `apps/api/.env`. Chọn **Kết nối ứng dụng**, chọn kênh, rồi kết nối tài khoản. Hội thoại chỉ xuất hiện khi có dữ liệu nhận/đồng bộ thật; clone dự án không tạo sẵn tin nhắn hoặc tài khoản mẫu.

**Chưa có App ID/Secret vẫn chạy được web, đăng nhập và Inbox.** Nếu chỉ dùng Zalo cá nhân, bạn có thể quét QR ngay, không cần Zalo Developer App hay callback OA. Các kênh khác chỉ cần cấu hình khi sử dụng.

Không chạy thêm `pnpm dev`, `pnpm dev:worker` hoặc một API khác khi bộ tiến trình này đã chạy: sẽ trùng cổng hoặc worker lease. Dừng bộ cũ bằng `Ctrl+C` ở terminal của nó trước khi chạy lại.

## Điền `.env` như thế nào?

### Cấu hình nền tảng

Các giá trị sau đã được `env:init` chuẩn bị trong `apps/api/.env`:

| Biến                   | Giá trị/cách điền                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`             | `development` khi chạy local; `production` khi triển khai HTTPS.                                                         |
| `PORT`                 | `3000` cho API.                                                                                                          |
| `DATABASE_URL`         | `postgresql://postgres:postgres@localhost:5432/zalo_inbox?schema=public` nếu dùng Compose mặc định.                      |
| `FRONTEND_URL`         | `http://localhost:5173` ở local; đổi sang origin HTTPS khi dùng tunnel/domain. Không thêm `/apps`, `/inbox` hoặc `/api`. |
| `ADMIN_PASSWORD`       | Mật khẩu quản trị tự sinh, tối thiểu 12 ký tự.                                                                           |
| `SESSION_SECRET`       | Chuỗi tự sinh, tối thiểu 32 ký tự.                                                                                       |
| `TOKEN_ENCRYPTION_KEY` | Khóa tự sinh gồm 64 ký tự hex. Giữ ổn định để đọc được token/phiên/tệp đã mã hóa.                                        |

`apps/web/.env` cho local:

```dotenv
VITE_API_BASE_URL=/api
API_PROXY_TARGET=http://localhost:3000
DEV_ALLOWED_HOSTS=
```

Frontend gọi `/api`; Vite chuyển tiếp sang API cổng 3000. Không đưa App Secret, token, mật khẩu hoặc khóa mã hóa vào `VITE_*` vì chúng có thể được đưa vào mã trình duyệt.

File `.env` ở **gốc repository** chỉ dùng cho Docker Compose, ví dụ giữ `COMPOSE_PROJECT_NAME` của database cũ. Nó không thay thế hai file env của ứng dụng. Mẫu tham khảo: [backend env](apps/api/.env.example), [frontend env](apps/web/.env.example).

### Chọn kênh cần cấu hình

| Kênh              | Cần chuẩn bị                                                          | Hướng dẫn điền env và kết nối                           |
| ----------------- | --------------------------------------------------------------------- | ------------------------------------------------------- |
| Zalo cá nhân      | Điện thoại Zalo để quét QR                                            | [Zalo cá nhân](docs/cau-hinh.md#zalo-ca-nhan)           |
| Zalo OA           | Developer App, App ID/Secret, khóa ký webhook, quyền quản trị OA      | [Zalo OA](docs/cau-hinh.md#zalo-oa)                     |
| Facebook Page     | Meta App, App ID/Secret, Verify Token, quyền quản lý Page             | [Facebook Page](docs/cau-hinh.md#facebook-page)         |
| TikTok Business   | App được duyệt Business Messaging, App ID/Secret, URL cấp quyền       | [TikTok Business](docs/cau-hinh.md#tiktok-business)     |
| TikTok Shop       | Seller app được duyệt Customer Service, App Key/Secret, URL cấp quyền | [TikTok Shop](docs/cau-hinh.md#tiktok-shop)             |
| Telegram Bot      | Bot Token từ BotFather và webhook HTTPS                               | [Telegram Bot](docs/cau-hinh.md#telegram-bot)           |
| Telegram cá nhân  | API ID/API Hash từ Telegram, TDLib native                             | [Telegram cá nhân](docs/cau-hinh.md#telegram-ca-nhan)   |
| WhatsApp Business | Meta App, WABA ID, Phone Number ID, access token, webhook HTTPS       | [WhatsApp Business](docs/cau-hinh.md#whatsapp-business) |

Các biến `*_ENABLED=true` chỉ bật tính năng, không tự cấp quyền hay đăng nhập tài khoản. Thay vì thêm một nhóm biến trùng ở cuối file, hãy sửa giá trị dòng đã có. Sau khi đổi env, dừng và chạy lại **một** bộ `pnpm dev`.

## Callback và webhook điền URL nào?

**OAuth callback** là nơi nhà cung cấp đưa trình duyệt trở về sau khi cấp quyền. **Webhook** là nơi nhà cung cấp gửi tin nhắn/sự kiện tới API. Hai loại URL này có đường dẫn khác nhau; riêng Meta cũng gọi ô đăng ký webhook là “Callback URL”.

Ví dụ toàn bộ ứng dụng chạy tại `https://chat.example.com`:

| Kênh                  | OAuth callback                                                          | Webhook nhận sự kiện                                                                         |
| --------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Zalo OA               | `https://chat.example.com/api/zalo/callback`                            | `https://chat.example.com/api/webhooks/zalo`                                                 |
| Facebook Page         | `https://chat.example.com/api/channels/facebook-page/oauth/callback`    | `https://chat.example.com/api/channels/facebook-page/webhook`                                |
| TikTok Business       | `https://chat.example.com/api/channels/tiktok-business/oauth/callback`  | `https://chat.example.com/api/channels/tiktok-business/webhook`                              |
| TikTok Shop           | `https://chat.example.com/api/channels/tiktok-shop/oauth/callback`      | `https://chat.example.com/api/channels/tiktok-shop/webhook`                                  |
| Telegram Bot          | Không dùng OAuth callback                                               | `https://chat.example.com/api/channels/telegram-bot/<accountId>/webhook`, backend tự đăng ký |
| Zalo/Telegram cá nhân | Không dùng callback/webhook công khai để đăng nhập                      | Kết nối qua phiên do worker quản lý                                                          |
| WhatsApp Business     | Luồng trực tiếp không có OAuth callback; Embedded Signup dùng SDK riêng | `https://chat.example.com/api/webhooks/whatsapp`                                             |

**Thay `chat.example.com` bằng domain/tunnel của bạn**; thay `<accountId>` bằng ID nội bộ do easyChat tạo, không tự điền vào env. Không dùng URL trang `/inbox`, `/connection`, `/whatsapp` làm endpoint webhook.

Để nhà cung cấp gọi được từ Internet khi phát triển local:

1. Tạo một tunnel HTTPS tới **cổng 5173** hoặc dùng reverse proxy HTTPS chuyển tiếp `/api` tới cổng 3000.
2. Đổi `FRONTEND_URL` sang origin HTTPS đó; cập nhật callback/webhook của kênh đang dùng.
3. Điền hostname tunnel vào `DEV_ALLOWED_HOSTS` của frontend.
4. Khởi động lại bộ dev; mở và đăng nhập qua **chính URL HTTPS đó** trước khi bấm kết nối.
5. Đăng ký URL trong Developer Console, sau đó bắt đầu kết nối từ easyChat.

Hướng dẫn có mẫu env copy được và vị trí điền trên từng cổng quản trị: **[Cấu hình env, HTTPS, callback và webhook](docs/cau-hinh.md)**.

## Dữ liệu và các lệnh thường dùng

Docker Compose dùng project name mặc định `easy-chat`. Nếu đang chuyển checkout có database cũ, giữ `COMPOSE_PROJECT_NAME` cũ trong root `.env` **trước khi** chạy Compose. Ví dụ database từng tạo dưới project `demo-new-projects` cần giữ `COMPOSE_PROJECT_NAME=demo-new-projects`. Đổi project name có thể chọn một volume rỗng khác.

Không xóa volume để xử lý lỗi khởi động. `docker compose down` giữ volume; `docker compose down -v` xóa dữ liệu volume.

```bash
# Kiểm tra code
pnpm lint
pnpm test
pnpm format:check

# Build khi đã dừng bộ dev
pnpm build

# Chỉ khi chủ động thay đổi schema trong quá trình phát triển
pnpm db:migrate --name describe_change
pnpm db:generate

# Chạy riêng từng tiến trình, thay cho pnpm dev (ba terminal riêng)
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

Kiểm thử tích hợp dùng database riêng, tạo một lần:

```bash
docker compose exec -T postgres createdb -U postgres zalo_inbox_test
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/zalo_inbox_test pnpm test:integration
```

Bỏ qua `createdb` nếu database đã tồn tại. Suite chỉ nhận database có tên kết thúc bằng `_test`; không dùng database đang chứa hội thoại thật.

## Xử lý lỗi thường gặp

| Hiện tượng                                      | Cách kiểm tra/xử lý                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cổng `5173` hoặc `3000` đã được sử dụng         | Dừng bộ dev cũ ở đúng terminal, rồi chạy một bộ duy nhất. Linux có thể dùng `ss -ltnp '( sport = :5173 or sport = :3000 )'` để xác định tiến trình.                |
| Worker không khởi động                          | Kiểm tra `docker compose ps`, `DATABASE_URL`, `pnpm db:deploy` và worker đã chạy ở terminal khác chưa. Xem mã lỗi cụ thể thay vì chỉ dòng “Worker startup failed”. |
| `WORKER_SCHEMA_MISSING` sau khi đổi tên thư mục | Kiểm tra Compose project name/volume trước khi migrate; có thể đang trỏ vào một database rỗng khác.                                                                |
| Không đăng nhập được/Origin bị từ chối          | URL đang mở phải khớp `FRONTEND_URL`; dùng `ADMIN_PASSWORD` của backend.                                                                                           |
| Zalo `-14003` / Invalid redirect uri            | Ô **Official Account Callback Url** phải trùng `ZALO_REDIRECT_URI`, gồm giao thức, host, cổng, path và dấu `/` cuối.                                               |
| Zalo `-14068` / Không có OA                     | Tài khoản Zalo cấp quyền phải có OA đủ điều kiện quản trị. Có Developer App chưa có nghĩa đã có OA. Nếu chỉ cần tài khoản thường, dùng Zalo cá nhân.               |
| OAuth state/session hết hạn                     | Bắt đầu kết nối lại từ easyChat ở cùng trình duyệt và origin đã đăng nhập; không dùng lại link OAuth cũ.                                                           |
| Vite chặn tunnel                                | Thêm hostname, không có `https://` hoặc path, vào `DEV_ALLOWED_HOSTS`; khởi động lại frontend.                                                                     |
| Webhook verify thất bại                         | URL phải truy cập HTTPS công khai; Verify Token trong env và dashboard phải giống nhau. Proxy giữ nguyên raw body/header chữ ký.                                   |
| Kênh chưa cấu hình/chưa có tin                  | Điền credentials/quyền của đúng kênh, kết nối tài khoản và kiểm tra webhook/worker. Lịch sử trước khi tích hợp không được nhập tự động trên mọi nền tảng.          |
| Chưa thấy nút Tài liệu/Âm thanh                 | Mở một hội thoại và xem phía trên ô soạn tin. Nếu đang giữ giao diện cũ, tải lại trang; nút bị vô hiệu hóa sẽ có lý do theo quyền/kênh.                            |

## Kiến trúc và triển khai

```text
apps/api/          NestJS API, Prisma, các adapter và một worker chung
apps/web/          React, Vite, Tailwind; Inbox và trang kết nối ứng dụng
packages/shared/   Zod schemas và kiểu dữ liệu dùng chung
native/telegram/   Bridge/build TDLib cho Telegram cá nhân
docs/              Hướng dẫn cấu hình, giới hạn và báo cáo kiểm thử
```

Hàng đợi gửi dùng PostgreSQL transactional outbox; **không cần Redis**. Worker giữ kết nối và xử lý lệnh cho các kênh. Giao diện cập nhật qua SSE và refetch. Dữ liệu tài khoản được tách theo kênh/tài khoản; worker lease ngăn chạy trùng.

Khi triển khai: dùng `NODE_ENV=production`, một origin HTTPS cho frontend và `/api`, SPA fallback cho web, chạy API và đúng một worker thành hai tiến trình. Sau `pnpm build`, dùng `pnpm --filter @zalo/api start` và `pnpm --filter @zalo/api worker:start`; phục vụ `apps/web/dist` bằng web server. Docker Compose hiện chỉ chạy PostgreSQL; không tự đóng gói toàn bộ ứng dụng. Giữ backup database, env/khóa mã hóa và dữ liệu TDLib nếu sử dụng.

## Tài liệu chi tiết

- [Điền env, cấu hình callback/webhook từng kênh](docs/cau-hinh.md).
- [Zalo cá nhân](docs/zalo-personal.md) · [Facebook Page](docs/facebook-page-setup.md) · [Messenger cá nhân chưa hỗ trợ](docs/facebook-personal-evaluation.md).
- [TikTok](docs/tiktok-setup.md) · [Telegram và build TDLib](docs/telegram-setup.md) · [WhatsApp Business](docs/whatsapp-setup.md).
- [Tài liệu/âm thanh và giới hạn dung lượng](docs/media-attachments.md) · [Tin chưa đọc](docs/inbox-unread.md) · [Giao diện workspace](docs/frontend-workspace.md).

Kiểm thử tự động dùng mock/fixture cho lời gọi nhà cung cấp. Việc test/build thành công chưa xác nhận OAuth, quyền ứng dụng hoặc giao nhận trên tài khoản thật; cần nghiệm thu với cấu hình của bạn theo từng hướng dẫn kênh.
