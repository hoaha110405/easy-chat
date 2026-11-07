# WhatsApp Business Cloud API: hợp đồng đã đối chiếu

Ngày đối chiếu: 2026-11-07. Chỉ dùng tài liệu Meta, Graph API HTTPS và JavaScript SDK chính thức cho Embedded Signup. Không dùng WhatsApp Web, QR session, personal account client hay gateway.

Tài liệu Meta đọc trực tiếp qua HTTPS trong lần triển khai này có ví dụ **Graph v27.0**. easyChat mặc định v27.0, cho phép cấu hình v26.0 cho hợp đồng Cloud API nền tảng; `messaging_account_id` chỉ gửi với v27.0. Facebook Page giữ cấu hình version riêng. Không tuyên bố mọi Graph version đều đã được xác minh.

## Nguồn chính thức

- [Cloud API overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/overview/), [Meta Postman Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/collection/wlk6lh4/whatsapp-cloud-api).
- [Access tokens](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens/).
- [Embedded Signup implementation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation/), cập nhật 2026-10-27; [Tech Provider onboarding](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider/).
- [Send messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages/), [text messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/text-messages/).
- [Messages webhooks](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/), [status payload](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status/).
- [Templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-management/), [customer service/pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages/).
- [Media](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media/), [document messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/document-messages/), [audio messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/audio-messages/), [error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes/).
- [Business App onboarding / Coexistence](https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users/).

Một số lần đọc bằng search/open bị Meta trả 429; nội dung tài liệu được tải trực tiếp từ chính domain Meta qua HTTPS và đối chiếu với collection Postman của Meta. Không dùng bài hướng dẫn bên thứ ba làm hợp đồng triển khai. Một số trang Meta còn dùng ví dụ v21/v23 cho endpoint ổn định; các trang gửi tin/token/media hiện có ví dụ v27.0.

## Quyết định API

| Hạng mục           | Hợp đồng sử dụng                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authentication     | Bearer token riêng từng ChannelAccount, appsecret_proof HMAC; app ID phải khớp debug_token và token còn hiệu lực                                                                                                   |
| Scopes             | whatsapp_business_management + whatsapp_business_messaging cho onboarding/quản lý/gửi. business_management chỉ cần cho thao tác business portfolio khác, không yêu cầu thêm trong MVP                              |
| WABA/phone         | GET /WABA_ID, GET /WABA_ID/phone_numbers phân trang, GET /PHONE_ID với status/platform_type/is_on_biz_app; lưu IDs dưới dạng string                                                                                |
| Register           | POST /PHONE_ID/register với messaging_product=whatsapp và PIN 6 chữ số do người dùng cung cấp; chỉ đăng ký số đã xác minh sở hữu, không tự đoán PIN                                                                |
| App webhook        | Kiểm tra GET /APP_ID/subscriptions: đúng object, callback URL active và field messages; Embedded Signup còn cần account_update                                                                                     |
| WABA subscribe     | POST và GET /WABA_ID/subscribed_apps; xác nhận đúng app trước CONNECTED                                                                                                                                            |
| Incoming webhook   | GET challenge với verify token; POST HMAC-SHA256 raw bytes với Meta App Secret, constant-time compare; object whatsapp_business_account, entry.id = WABA/messaging account ID, metadata.phone_number_id            |
| Send text/template | POST /PHONE_ID/messages; individual recipient; v27 thêm messaging_account_id để xác định WABA context; biz_opaque_callback_data là message ID + UUID của lần gửi để đối chiếu status, cô lập callback cũ sau retry |
| ACK                | HTTP thành công + wamid chỉ xác nhận Meta đã nhận yêu cầu. UI hiển thị “Meta đã nhận yêu cầu” cho đến khi có provider status; không suy ra delivered/read                                                          |
| Status             | sent/delivered/read/failed được xử lý bền vững, không hạ READ/DELIVERED khi event cũ đến muộn; callback/account/recipient phải khớp                                                                                |
| Window             | Freeform tối đa 24 giờ từ tin khách hàng được xác minh gần nhất, kiểm tra cả lúc queue lẫn trước POST; không dùng last outbound hoặc thời gian billing để kéo dài cửa sổ                                           |
| Templates          | GET /WABA_ID/message_templates; chỉ APPROVED, hỗ trợ HEADER text/BODY/FOOTER, biến POSITIONAL hoặc NAMED; kiểm tra lại ngay trước gửi                                                                              |
| Media              | GET /MEDIA_ID?phone_number_id=... rồi tải HTTPS bằng Bearer; URL tạm 5 phút giữ ở backend. MIME/size/digest được kiểm tra, cookie/owner guard bảo vệ proxy                                                         |
| Provider read      | POST /PHONE_ID/messages với status=read và message_id, chỉ qua thao tác riêng được agent yêu cầu                                                                                                                   |
| Disconnect         | DELETE WABA subscribed_apps khi không còn số active khác của easyChat trong WABA; không deregister số hoặc thu hồi quyền dùng chung một cách tự động                                                               |

## Embedded Signup

Triển khai **v4** theo ví dụ Meta hiện hành: official SDK từ connect.facebook.net, FB.init với app ID/version và FB.login với config_id, response_type=code, override_default_response_type=true, extras.setup={}. Không thêm tham số feature/sessionInfoVersion cũ để mô phỏng flow đã nghỉ hoạt động.

Frontend chỉ chấp nhận postMessage từ origin HTTPS thuộc facebook.com với delimiter domain đúng. Session assets là gợi ý; backend xác minh lại bằng token và WABA phone edge. Code được đổi ngay qua GET /oauth/access_token với client_id/client_secret/code; không tự thêm redirect_uri không thuộc hợp đồng JavaScript SDK này. Theo Meta, code chỉ tồn tại 30 giây. Nonce riêng của easyChat được hash, single-use, ràng buộc admin session/owner và TTL; token selection mã hóa và hết hạn sau 10 phút.

v4 yêu cầu Tech Provider/Solution Partner phù hợp, cấu hình Facebook Login for Business, HTTPS/allowed domains/valid OAuth redirect URIs, account_update subscription và permissions/Advanced Access cần thiết. Flag cấu hình chỉ thể hiện tính năng đã được quản trị viên bật; không đại diện App Review hoặc doanh nghiệp đã được Meta duyệt. Meta kiểm tra eligibility trong flow và qua API thực tế.

## Policy, history và Coexistence

Cloud API không có endpoint chung để liệt kê inbox cá nhân hoặc tải toàn bộ lịch sử trước khi tích hợp. easyChat dùng dữ liệu PostgreSQL đã nhận. Chỉ theo dõi cửa sổ từ message webhook mà MVP nhận diện là tương tác khách hàng; không tự suy diễn thêm từ cuộc gọi/entry point/billing vì các luồng đó chưa tích hợp.

Mẫu Utility/Marketing văn bản yêu cầu operator xác nhận sự đồng ý phù hợp cho từng lần gửi. Hệ thống lưu xác nhận này để audit, không tự tạo marketing campaign. Meta vẫn có thể chặn vì khu vực, tần suất, chất lượng hoặc điều kiện người nhận (ví dụ 131049); backend giữ lỗi và không vòng qua bằng loại tin khác.

Coexistence là luồng dành cho **WhatsApp Business App đủ điều kiện**, không phải WhatsApp cá nhân. Tài liệu Meta mô tả webhook history/smb_app_state_sync/smb_message_echoes, bước bỏ qua register và thời hạn đồng bộ sau onboarding. Những quyền, event schemas và authorization lịch sử chưa được kích hoạt cho app hiện tại. MVP từ chối is_on_biz_app=true và phiên FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING, không đăng ký các field này, không giả nhập lịch sử/echo. Điều này không chặn số Cloud API bình thường.

API mới có Business Scoped User IDs (US.…). MVP gửi theo số/wa_id đã biết; không tự đổi BSUID hoặc group ID thành số điện thoại. Group messaging, BSUID-only contacts, template media/buttons/authentication và Coexistence nằm ngoài phạm vi hiện tại. Gửi tài liệu/âm thanh đã được triển khai bằng media upload chính thức và outbox chung; không có ghi âm micro trực tiếp.

## Upload tài liệu và âm thanh

Đối chiếu thêm ngày 2026-11-07 với các trang Media (cập nhật 2026-10-30), Document messages và Audio messages của Meta. `POST /PHONE_ID/media` dùng multipart, Bearer token, `messaging_product=whatsapp`, MIME và file bytes; response trả media ID, chưa gửi tới người nhận. Sau đó `POST /PHONE_ID/messages` với `type=document`, `document.id`, `filename`, `caption` tùy chọn tối đa 1024 ký tự; hoặc `type=audio`, `audio.id`. MVP không bật `voice=true` và không tự chuyển mã audio.

Meta hỗ trợ tài liệu PDF/TXT/Office và audio AAC/AMR/MP3/MP4/OGG. Giới hạn riêng của easyChat là 20 MB tài liệu và 16 MB audio; OGG chỉ nhận Opus mono. ID upload hết hạn sau 30 ngày, ID trong webhook sau 7 ngày; URL download chỉ 5 phút. File không được lưu public hoặc sao chép lâu dài ở local. Chỉ media ID/hash/tên/loại được persist; bytes dùng bộ nhớ có giới hạn trong request.
