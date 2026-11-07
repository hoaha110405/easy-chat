# Telegram: nguồn chính thức và quyết định kỹ thuật

Đối chiếu ngày 2026-11-07. Bot API và TDLib là hai kết nối độc lập, dùng lại ChannelAccount/Conversation/Message, PostgreSQL outbox, một PersonalWorker và SSE của easyChat. Repository hiện tại không có Redis/BullMQ nên tích hợp giữ queue PostgreSQL đang hoạt động.

## Nguồn và phiên bản

- [Bot API](https://core.telegram.org/bots/api), [FAQ](https://core.telegram.org/bots/faq): HTTPS trực tiếp, getMe/setWebhook/getWebhookInfo/deleteWebhook/sendMessage; header webhook secret chính thức; message_id scoped theo chat; error parameters.retry_after/migrate_to_chat_id.
- [TDLib getting started](https://core.telegram.org/tdlib/getting-started), [JSON/C interface](https://core.telegram.org/tdlib/docs/td__json__client_8h.html), [source chính thức](https://github.com/tdlib/td).
- [Schema TDLib đã khóa](https://github.com/tdlib/td/blob/4c6377aa7386c39217878a9a56d581922ad37ca4/td/generate/scheme/td_api.tl), [C header](https://github.com/tdlib/td/blob/4c6377aa7386c39217878a9a56d581922ad37ca4/td/telegram/td_json_client.h).
- [API ID](https://core.telegram.org/api/obtaining_api_id), [Terms](https://core.telegram.org/api/terms).

Source revision `4c6377aa7386c39217878a9a56d581922ad37ca4`, archive SHA256 `472015605fffa826bfba6ccf7d888905b436ecce94c8a6826203792edfbe5731`. Build đã chạy trả version `1.8.69`. Source archive không có Git metadata nên option commit_hash trả `GITDIR-NOTFOUND`; provenance dựa trên revision và archive checksum, không giả mạo commit runtime. Runtime chỉ chấp nhận version đã kiểm chứng 1.8.69; production nên dùng bản khóa này và kiểm thử contract khi nâng phiên bản.

## Hợp đồng quan trọng

| Điểm              | Cách triển khai                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Bot webhook       | Secret header constant-time compare; raw JSON precision-safe; receipt lưu bền vững trước HTTP 200; update_id dedupe mỗi bot/generation   |
| Bot reply         | Fixed official host, không redirect/proxy; schema ACK, chat ID và bot sender ID phải khớp; timeout/5xx/malformed send → UNKNOWN          |
| Native interface  | `td_create_client_id`, `td_send`, `td_receive`, `td_execute` qua bridge C++17 và dlopen; không tự triển khai Telegram protocol           |
| Async correlation | `@extra` UUID; update xử lý tuần tự; lỗi/crash process chỉ ảnh hưởng tài khoản tương ứng                                                 |
| Parameters        | `setTdlibParameters` flat fields, database_encryption_key là base64 bytes; không dùng authorization API cũ                               |
| IDs               | JSON int53/number giữ chính xác, int64 strings/BigInt khi serialize; PostgreSQL giữ strings; message key `chatId:messageId`              |
| Chat lists        | `loadChats` main/archive, 404 là kết thúc; `getChats` chỉ lấy snapshot đã load, không dùng array index như cursor Telegram               |
| History           | `getChatHistory` from_message_id, offset 0, limit 25, only_local false; trang ngắn chưa khẳng định hết lịch sử, trang rỗng là dừng       |
| Send              | `sendMessage.topic_id` nullable theo schema khóa, inputMessageText/formattedText; pending response chờ updateMessageSendSucceeded/Failed |
| Groups            | Kiểm tra quyền cơ bản và own member/admin status qua getBasicGroup/getSupergroup; forum không gửi trong MVP                              |
| Changes           | updateNewMessage, updateMessageContent/Edited, updateDeleteMessages chỉ khi permanent và không from_cache                                |
| Read              | updateChatReadInbox/Outbox; phân biệt unread provider và unread easyChat; không tự gọi hàm đánh dấu provider đã đọc                      |
| Error 406         | Không đọc/xử lý/hiển thị message của lỗi 406; chỉ trả mã lỗi generic                                                                     |

## Xác thực theo schema đã khóa

Các trạng thái: WaitTdlibParameters, WaitPhoneNumber, WaitCode, WaitPassword, WaitEmailAddress, WaitEmailCode, WaitOtherDeviceConfirmation, WaitPremiumPurchase, WaitRegistration, Ready, LoggingOut, Closing, Closed. UI hiển thị hành động đúng trạng thái và có fallback yêu cầu thao tác thêm.

Các hàm xác thực: setAuthenticationPhoneNumber, checkAuthenticationCode, checkAuthenticationPassword, setAuthenticationEmailAddress, checkAuthenticationEmailCode với emailAddressAuthenticationCode, requestQrCodeAuthentication.

Schema khóa này không có `authorizationStateWaitPasskey`. Nó có hàm tùy chọn getAuthenticationPasskeyParameters/checkAuthenticationPasskey; chúng không được dùng thay cho luồng xác thực hiện tại. MVP không triển khai WebAuthn passkey của Telegram tại origin easyChat (ràng buộc RP/Telegram domain phải được giải quyết bằng cơ chế chính thức trước). Không bịa state/hàm passkey và không dùng checkAuthenticationWebToken dành cho ứng dụng chính thức Telegram. Premium purchase và account registration được hướng dẫn hoàn tất trong ứng dụng Telegram chính thức.

## Giới hạn công khai

Chưa kiểm thử đăng nhập/gửi tin tài khoản thật do chưa được cung cấp API ID/API Hash/Bot Token. Bot không truy cập inbox cá nhân; Bot API không tải lịch sử chat tùy ý. Media download/avatar, gửi attachment, Secret Chats, broadcast channels, forum reply và WebAuthn passkey ngoài MVP. Các khả năng này không được hiển thị như đã hoạt động. Bản Docker artifact có tài liệu nhưng chưa build trong môi trường kiểm chứng này.
