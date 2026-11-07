# Tin chưa đọc trong easyChat

Hộp thư chung hiển thị dấu chấm, tên/tin gần nhất nổi bật và số tin đến chưa đọc trên từng hội thoại. Số trên 99 hiện `99+`; tooltip và nhãn hỗ trợ đọc màn hình giữ số đầy đủ. Phần đầu danh sách có tổng số tin chưa đọc theo bộ lọc tài khoản/kênh; tổng được lấy từ database, không chỉ cộng các chat đang tải. Menu tài khoản cũng có số chưa đọc riêng.

## Quy tắc theo dõi

- PostgreSQL lưu `Message.inboxUnread` riêng cho easyChat. Tin đến được lưu mới qua `MessageStore` bắt đầu chưa đọc; tin đi không được đếm. Khi nhập lịch sử chưa từng lưu trong easyChat, các tin đến đó cũng là tin chưa xem trong easyChat.
- Tin đã có trước migration giữ mốc ban đầu đã đọc vì bản trước không theo dõi lượt xem; không suy đoán trạng thái cũ từ ứng dụng gốc.
- Trình duyệt chỉ gửi ID tin đến chưa đọc đang hiện trong vùng chat sau 400 ms, khi tab hiển thị và cửa sổ có focus. Tin ngoài viewport, chat chưa mở và tin đến sau snapshot vẫn giữ trạng thái. Rời chat hủy timer đang chờ.
- Đã đọc được lưu trên máy chủ, đồng bộ qua realtime giữa các cửa sổ và giữ khi tải lại. Webhook/history trùng ID không đánh dấu một tin đã đọc thành chưa đọc lần nữa.
- Lỗi lưu trạng thái giữ số chưa đọc; chat có thông báo và nút thử lại. Yêu cầu đã đọc có tính idempotent.
- Trạng thái này không đổi `readAt`, không gửi read receipt về nhà cung cấp và không thay đổi cửa sổ được phép trả lời. `Conversation.unreadCount` do TikTok Shop trả vẫn tách riêng và hiển thị ở chi tiết hội thoại; badge trong danh sách dùng `inboxUnreadCount`.

## API và database

| Trường/route                       | Ý nghĩa                                                                                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Message `inboxUnread`              | Cờ chưa đọc cục bộ, trả cùng tin nhắn đã lưu.                                                                                                                              |
| Conversation `inboxUnreadCount`    | Số tin đến còn chưa đọc trong đúng hội thoại.                                                                                                                              |
| InboxAccount `unreadMessageCount`  | Tổng tin đến chưa đọc của tài khoản, không phụ thuộc phân trang.                                                                                                           |
| POST `/api/conversations/:id/read` | Body `{messageIds: [...]}` gồm 1–200 ID tin. Cần session quản trị và Origin frontend. Chỉ cập nhật tin đến thuộc đúng hội thoại/owner; trả `{data: {markedRead: number}}`. |

Migration `20261107000000_inbox_unread` chỉ thêm cột boolean mặc định false và ba index theo conversation/account/OA + cờ chưa đọc; không xóa tin hay reset dữ liệu. Đánh dấu đã đọc phát `conversation.updated` sau transaction commit và không thay thứ tự hội thoại.

## Kiểm tra đã chạy ngày 07/11/2026

- `pnpm lint`: pass ESLint/TypeScript shared, API và web.
- `pnpm test`: **162 pass** (API 125, shared 2, web 35).
- `TEST_DATABASE_URL=.../zalo_inbox_test pnpm test:integration`: **100 pass**, gồm **11 test unread mới**, không thao tác database phát triển.
- Tổng **262 test**; có 16 bài mới cho trạng thái chưa đọc (11 PostgreSQL/HTTP, 5 UI/hook). Kiểm tra incoming/outgoing, nhiều kênh, owner/conversation, trùng event, hai lượt read đồng thời, tin mới đến sau snapshot, tổng ngoài trang đã tải, Origin/session và độc lập với provider read state.
- NestJS production build ra `/tmp/easychat-unread-validation/api-dist` và Vite production build: pass. Không xóa dist của tiến trình đang chạy để build.
- Firefox desktop 1440×1000 và mobile 390×844 dùng dữ liệu giả lập trong trình duyệt: tổng 16 → 13 khi xem đúng ba tin cuối; chín tin cũ khuất và bốn tin của chat chưa mở giữ nguyên. Không lỗi JavaScript hoặc tràn ngang. Kết quả/ảnh ở `/tmp/easychat-unread-validation/`.
- Đã khởi động lại đúng một bộ dev sau migration để API/worker nạp Prisma mới; smoke test API local xác nhận các trường đếm có thật, worker online và đúng một advisory lock. Smoke test không mở/đánh dấu tin thật của người dùng.

File chính: `apps/api/src/modules/inbox/{message-store,inbox.service,inbox.controller}.ts`, Prisma schema/migration, shared `schemas/api.ts`, web `pages/inbox.tsx`, `features/inbox/{use-inbox-read,account-filter,conversation-details}`, cùng các test unread. Các thay đổi TikTok/Zalo/Facebook có sẵn được giữ nguyên.
