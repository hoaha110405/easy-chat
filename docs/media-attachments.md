# Gửi và nhận tài liệu, âm thanh trong easyChat

Phần đính kèm dùng chung trong Inbox đã được mở rộng khỏi WhatsApp. Mở đúng hội thoại/tài khoản nhận tin, chọn **Tài liệu** hoặc **Âm thanh**, chọn một tệp rồi bấm **Gửi**. Tên tài khoản trả lời vẫn hiện ở khung chat để tránh gửi nhầm.

## Khả năng theo kênh

| Kênh              | Gửi tài liệu                                                      | Gửi âm thanh                                                     | Nhận/xem                                                                                        |
| ----------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Zalo cá nhân      | PDF/TXT/Word/Excel/PowerPoint, ≤20 MB                             | MP3/M4A, ≤16 MB, upload rồi gửi voice trong session hiện tại     | File có tên/tải xuống, voice có trình phát; không còn bị chuẩn hóa thành unsupported            |
| Zalo OA           | PDF/DOC/DOCX/CSV, ≤5 MB, trong cửa sổ 48 giờ bảo thủ của easyChat | Chưa bật vì API tư vấn này không có hợp đồng gửi audio được dùng | Nhận file/voice qua webhook hoặc history khi Zalo cung cấp URL                                  |
| Facebook Page     | PDF/TXT/Office, ≤20 MB                                            | MP3/M4A, ≤16 MB                                                  | File/audio từ webhook và lịch sử Page; vẫn áp dụng quyền và cửa sổ 24 giờ                       |
| Telegram Bot      | PDF/TXT/Office, ≤20 MB                                            | MP3/M4A, ≤16 MB                                                  | File/audio/voice qua Bot API; download có xác thực, giới hạn 20 MB của proxy ứng dụng           |
| Telegram cá nhân  | PDF/TXT/Office, ≤20 MB                                            | MP3/M4A, ≤16 MB                                                  | TDLib chính thức; tải tệp thuộc tài khoản đang đăng nhập, không trả local path cho browser      |
| WhatsApp Business | PDF/TXT/Office, ≤20 MB                                            | AAC/AMR/MP3/M4A/OGG Opus mono, ≤16 MB                            | Giữ luồng Cloud API và private media proxy; cửa sổ 24 giờ                                       |
| TikTok Shop       | Chưa hỗ trợ qua API hiện tại                                      | Chưa hỗ trợ qua API hiện tại                                     | Các nội dung mà Customer Service API trả được; không giả hỗ trợ attachment bị nền tảng loại trừ |
| TikTok Business   | Chưa bật do chưa có hợp đồng document/audio đã được xác minh      | Chưa bật                                                         | Giữ luồng nhận nội dung hiện có; nút đính kèm giải thích giới hạn                               |
| Messenger cá nhân | Chưa hỗ trợ                                                       | Chưa hỗ trợ                                                      | Integration cá nhân/E2EE chưa có API chính thức phù hợp trong easyChat                          |

Các loại/cỡ tệp và quyền được kiểm tra lại ở backend. Telegram/WhatsApp hỗ trợ chú thích tối đa 1024 ký tự; âm thanh WhatsApp, file/audio Zalo cá nhân và Facebook Page gửi thành tin riêng, không âm thầm gửi thêm một tin văn bản. UI yêu cầu gửi hoặc xóa draft trước khi chọn tệp không hỗ trợ chú thích. Chưa có ghi âm micro trực tiếp.

## Hiển thị và an toàn khi gửi

- Chọn tệp hiện tên, dung lượng và nút bỏ tệp. File có liên kết tải, âm thanh dùng trình phát native với tua qua HTTP byte ranges. Khi trình duyệt không phát được codec hoặc file đang tải, có **Thử tải lại / Tải tệp gốc**.
- Mỗi lần gửi có idempotency key. Nếu mất phản hồi, **Kiểm tra yêu cầu** dùng lại đúng file/key; gửi đồng thời cùng key chỉ tạo một intent. Đổi file/nội dung dưới key đã dùng bị từ chối.
- Các kênh dùng PersonalCommand outbox và worker chung. API upload của Zalo cá nhân, Facebook hoặc Telegram không trực tiếp tạo tin gửi ngoài worker. WhatsApp giữ flow upload asset rồi queue intent trước đó.
- SENDING bị gián đoạn/POST mất ACK chuyển UNKNOWN và không tự gửi lại. Chỉ retry khi đã biết thất bại; tệp đã hết hạn yêu cầu chọn tệp mới. Cửa sổ, kết nối và generation được kiểm tra trước dispatch.
- OA giữ nguyên ZaloConnection/Conversation/Message với ràng buộc đúng một kênh mỗi record. ChannelAccount nội bộ chỉ định tuyến PersonalCommand; không chuyển hội thoại OA sang một account thứ hai hoặc nhân đôi tài khoản trong bộ lọc. Mỗi lệnh OA kiểm tra lại trạng thái đúng connection trước gửi; không sửa hành vi disconnect toàn hệ thống.

## Lưu trữ và quyền tải tệp

Migration `20261107040000_message_media` chỉ thêm bảng MessageMedia, FK cascade theo Message, index expiry và ràng buộc size ≤20 MB. Không thay đổi hoặc reset lịch sử đang có.

Tệp upload cho Zalo/Facebook/Telegram và cache Telegram được lưu trong PostgreSQL với AES-256-GCM, IV ngẫu nhiên, AAD gắn message ID, SHA256 và tên/MIME đã làm sạch. API đọc kiểm tra owner/cookie, deletedAt và integrity trước trả bytes; tệp không nằm trong thư mục public. Quota hiện tại 1 GB/owner, thời hạn 30 ngày, worker xóa bytes hết hạn theo batch và giữ Message/metadata. Không dùng khóa mới: cần giữ TOKEN_ENCRYPTION_KEY ổn định như credentials hiện có.

Incoming Zalo/Facebook vẫn dùng liên kết provider đã chuẩn hóa; URL có thể hết hiệu lực theo nền tảng. Incoming Telegram được tải theo yêu cầu và cache riêng tư; thay media qua edit sẽ xóa cache cũ. WhatsApp vẫn dùng media ID của Meta, với thời hạn/provider token riêng; bảng này không kéo dài thời hạn Meta. Thông tin thêm ở [WhatsApp setup](whatsapp-setup.md).

TDLib cần file nguồn cục bộ để upload: mỗi tệp có thư mục UUID riêng trong data dir của đúng account, mode thư mục 0700/file 0600. Sau provider confirmation hoặc lỗi chắc chắn sẽ xóa nguồn; kết quả UNKNOWN giữ nguồn tối đa khoảng 24 giờ để không cắt upload còn chạy, có dọn theo batch. Cache gốc do TDLib quản lý cũng nằm trong private account directory. Proxy download xác minh file hoàn tất, kích thước và realpath nằm dưới files dir của account, không cho đọc file tùy ý.

Kiểm tra header bytes/MIME/extension không thay thế antivirus hoặc phân tích codec đầy đủ. Cần theo dõi dung lượng PostgreSQL, backup và bảo vệ data dir khi vận hành. Không có campaign hay gửi file hàng loạt tự động.

## API

- `POST /api/conversations/:id/media`: multipart `file`, `kind=document|audio`, `caption`, `idempotencyKey`; admin session, Origin, throttle 10/min, một file ≤20 MB. Với WhatsApp, controller cũ vẫn tương thích và gọi cùng nghiệp vụ.
- `GET /api/messages/:id/media`: tệp local/private cache; yêu cầu cookie/owner, no-store/nosniff, Content-Disposition phù hợp, Range/206/416 cho trình phát.
- Retry dùng endpoint messages/retry hiện có; OA chỉ được retry intent có outbox thuộc owner quản trị OA hiện tại.
- Telegram cá nhân tải qua Unix RPC ký HMAC tới worker, chỉ truyền message ID và kết quả ready; không đưa file bytes lớn, bot token, local path hoặc credentials vào browser/RPC response.

## Nguồn kỹ thuật

Đối chiếu ngày 2026-11-07:

- [Zalo OA upload file](https://developers.zalo.me/docs/official-account/tin-nhan/quan-ly-tin-nhan/upload-file), [gửi tư vấn đính kèm file](https://developers.zalo.me/docs/official-account/tin-nhan/tin-tu-van/gui-tin-tu-van-dinh-kem-file), [điều kiện tư vấn](https://developers.zalo.me/docs/official-account/tin-nhan/tin-tu-van/dieu-kien-gui-tin-tu-van). Trang mới xác định từ sitemap chính thức; một số nội dung web cần JavaScript. Hợp đồng upload PDF/DOC/DOCX/CSV ≤5 MB còn được trả trong tài liệu Zalo được index. easyChat chọn tập con trả lời 48 giờ, không tự mở rộng sang các chế độ có tính phí.
- SDK Zalo cá nhân đang pin `zca-js@2.2.0`: source/definitions thực tế của `sendMessage`, `uploadAttachment`, `sendVoice` và [repository của thư viện](https://github.com/RFS-ADRENO/zca-js). Đây là adapter cá nhân sẵn có, không phải API OA chính thức; yêu cầu listener hoạt động để xác nhận upload. WhatsApp không dùng adapter này.
- [Meta Messenger Attachment Upload API](https://developers.facebook.com/docs/messenger-platform/reference/attachment-upload-api/), [collection chính thức Meta](https://www.postman.com/meta/messenger-platform-api). Upload `message_attachments` với multipart message/filedata, sau đó messages với attachment_id. Các lần Meta Docs trả 429/không có nội dung đọc được được ghi nhận; không coi mock là xác minh live.
- [Telegram Bot API](https://core.telegram.org/bots/api): sendDocument/sendAudio multipart và getFile/download HTTPS. [TDLib schema revision đang pin](https://github.com/tdlib/td/blob/4c6377aa7386c39217878a9a56d581922ad37ca4/td/generate/scheme/td_api.tl): inputMessageDocument/inputDocument, inputMessageAudio/inputAudio, inputFileLocal, getFile/downloadFile.
- [TikTok Shop Send Message 202606](https://partner.tiktokshop.com/docv2/page/send-message), [Customer Service support matrix](https://partner.us.tiktokshop.com/docv2/page/659645f9a46cdd02bc8aeacf): loại send không có FILE/AUDIO, attachments đánh dấu không hỗ trợ. TikTok Business chưa bật document/audio khi hợp đồng/quyền chưa được xác minh; không gửi loại tin tự đặt.

## Kiểm chứng

Các suite tự động đã kiểm tra gửi tài liệu/audio qua worker, HTTP multipart, Zalo SDK boundary, typed native TDLib requests, file tạm và download path isolation, nhận file/audio Telegram, nhận file/voice Zalo, range playback, cookie/Origin/owner isolation, dedupe, tampered ciphertext, expiry, UNKNOWN khi mất ACK, restart và OA disconnect trước send.

Kiểm chứng cuối ngày 2026-11-07: **453 tests PASS** — 197 backend unit, 68 web/UI, 2 shared schema, 186 PostgreSQL/HTTP integration (8 suites). `pnpm lint`, `pnpm build`, worker build riêng và `git diff --check` đều PASS. Migration status: 10 migrations, database up to date.

HTTP smoke sau khi khởi động lại một nhóm `pnpm dev`: login 200, inbox 200 với 12 hội thoại Zalo hiện có đều có mediaSupport document/audio, workerOnline=true, frontend `/inbox` 200, title easyChat; endpoint media không có cookie trả 401. Database dev vẫn có 12 conversations/33 messages và chưa có file thử trong MessageMedia. Không gửi tin thử vào tài khoản thật. Web đang chạy tại `http://localhost:5173`.

Lệnh đã chạy: `pnpm --filter @zalo/api test`, `pnpm --filter @zalo/web test`, `pnpm --filter @zalo/shared test`, `TEST_DATABASE_URL=.../zalo_inbox_test pnpm test:integration`, `pnpm lint`, `pnpm build`, `pnpm --filter @zalo/api exec tsc -p tsconfig.worker.json`, `pnpm --filter @zalo/api exec prisma migrate status`. Provider calls trong tests đều mock/native fixture. Chưa thực hiện gửi file hoặc voice tới người nhận thật trên bất kỳ nền tảng nào trong lần triển khai này.
