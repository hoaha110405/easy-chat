# Báo cáo nghiệm thu triển khai TikTok

Thực hiện ngày 06–07/11/2026 trên repo easy-chat hiện có. Kết quả dưới đây phân biệt kiểm thử bằng mock, kiểm thử hệ thống local thật và nghiệm thu TikTok thật.

## Kết quả đã chạy

| Kiểm tra                                                      | Kết quả                                                                                                                                                                                                        |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                                                   | Pass shared/API/web, gồm ESLint và TypeScript. API và web đã kiểm tra lại sau các sửa đổi cuối.                                                                                                                |
| `pnpm test`                                                   | **157 pass**: API 125, shared 2, web 30. API/web đã chạy lại sau các sửa đổi cuối.                                                                                                                             |
| `TEST_DATABASE_URL=.../zalo_inbox_test pnpm test:integration` | **89 pass**: database 15, Zalo Personal 27, Facebook 23, TikTok 24. Tất cả trên PostgreSQL test riêng.                                                                                                         |
| Tổng số test tự động khác nhau                                | **246 pass**; trong đó 59 test TikTok mới (30 API unit/contract, 24 PostgreSQL integration, 5 web). Không cộng các lần chạy lại.                                                                               |
| NestJS production build                                       | Pass, tạo cả `main.js` và `worker.js` ở `/tmp/easychat-tiktok-validation/api-dist`. Dùng tsconfig extends cấu hình API gốc và Nest CLI, chỉ đổi thư mục đầu ra để không xóa dist của tiến trình dev đang chạy. |
| `pnpm --filter @zalo/web build`                               | Pass TypeScript + Vite production, gồm chunk trang TikTok.                                                                                                                                                     |
| `pnpm --filter @zalo/api exec prisma validate`                | Pass. Migration thêm trường/bảng đã deploy; không reset hoặc xóa dữ liệu.                                                                                                                                      |
| Firefox local thật                                            | Đăng nhập qua web/API thật; Business và Shop đúng trạng thái chưa cấu hình/chưa kết nối, nút Business bị tắt, worker online. Trang ứng dụng có hai thẻ TikTok riêng.                                           |
| Firefox UI dùng mock                                          | Trang Shop có tài khoản + selection, quyền và nút thao tác, tên shop dài. Mock chỉ ở lớp HTTP trong trang trình duyệt; không ghi fixture vào database phát triển.                                              |
| Desktop/mobile                                                | Kiểm tra 1440×1000 và 390×844; không có lỗi JavaScript, không tràn ngang ở document hoặc vùng nội dung cuộn. Đã sửa trường hợp tên tài khoản dài bị tràn card mobile.                                          |

API test có thể ghi một dòng lỗi đã làm sạch trong bài kiểm tra cố tình làm hỏng database transaction, và cảnh báo timeout trong mock Zalo. Những dòng này thuộc tình huống kiểm thử có chủ đích; suite kết thúc pass.

## Dữ liệu và tiến trình local

Sau migration, kiểm tra read-only cho thấy database phát triển còn 2 tài khoản hiện có, 29 tin đã lưu tại thời điểm kiểm tra, **0 tài khoản TikTok**; dữ liệu tin có thể tăng do listener thật đang chạy. PostgreSQL chỉ có **1 worker lease** advisory lock `240005`. Không khởi chạy thêm API/worker, không reset database, không gửi tin vào tài khoản thật để kiểm tra TikTok.

Mật khẩu đọc từ file cấu hình cho smoke test chỉ dùng đăng nhập cục bộ, không in ra log; phiên smoke test đã logout. `.env` và `apps/api/.env` vẫn bị Git bỏ qua. Token và shop cipher trong response fixture đều được kiểm tra không lộ qua API công khai.

## Các tình huống quan trọng đã kiểm thử

- OAuth khác provider/session/owner, state đã dùng, lượt kết nối cũ, logout và selection hết hạn/đã dùng bị từ chối. Không CONNECTED nếu thiếu quyền hoặc subscribe webhook thất bại.
- Có thể chọn nhiều shop qua các lượt OAuth; đúng cipher từng shop chỉ trong credentials đã mã hóa. Truy vấn/gửi/đồng bộ không xuyên owner hoặc tài khoản.
- Business và Shop dùng đúng hai kiểu token/signature, đúng expiry tương đối/tuyệt đối, scope thực, cursor và API version tương ứng. Lỗi được làm sạch không chứa token/nội dung trò chuyện.
- Webhook exact bytes hợp lệ mới được lưu; persistence thất bại không ACK thành công; receipt trùng và history/webhook trùng không tạo tin thứ hai. Receipt giữ generation; sự kiện thu hồi quyền từ kết nối cũ hoặc có thời điểm trước lần cấp quyền mới không xóa credentials mới.
- Đồng bộ giữ checkpoint và giới hạn số trang; hồi tiếp lịch sử cũ/echo/read không mở lại cửa sổ trả lời. Shop giữ unread/can-send do provider trả.
- Gửi dùng outbox/idempotency hiện có, kiểm tra quyền/cửa sổ/quota cả lúc xếp hàng và dispatch. Tối đa ba lần thử cho lỗi chắc chắn an toàn; mất ACK và restart giữa SENDING giữ UNKNOWN, không replay POST.
- Echo sớm được hợp nhất với intent sau ACK. Read receipt chỉ cập nhật tin đi thuộc đúng tài khoản/hội thoại. Disconnect/revoke xóa credentials, hủy job cũ và giữ lịch sử.
- PG NOTIFY chỉ phát sau commit và chỉ chứa owner + ID để web refetch; không chứa credentials hay nội dung tin.
- Giao diện kiểm tra cấu hình thiếu, chọn shop, URL OAuth không tin cậy, lỗi quyền, bộ lọc kênh, unread thật và composer/trạng thái gửi dùng chung.

## Build API trong khi dev đang chạy

Không chạy root `pnpm build` để tránh xóa thư mục dist mà API/worker hiện dùng. Lệnh build đã thực hiện:

```sh
pnpm --filter @zalo/api exec nest build \
  --path ../../../../../../tmp/easychat-tiktok-validation/tsconfig.json \
  --config ../../../../../../tmp/easychat-tiktok-validation/nest-cli.json
```

Hai file tạm extends API tsconfig thực và đặt `outDir` ngoài repo. Khi không chạy dev, có thể dùng lệnh build tiêu chuẩn của repo; lệnh root đầy đủ **không được ghi nhận là đã chạy** trong lần này.

## Chưa kiểm thử TikTok live

Người dùng chưa có app được duyệt/credentials. Chưa xác nhận bằng provider thật:

- OAuth được TikTok chấp nhận, scope/market/eligibility của app cụ thể.
- Public HTTPS callback/webhook, subscription trên app thật và độ trễ giao tin xuyên proxy/firewall.
- Đồng bộ tài khoản/shop thật, reply xuất hiện trên TikTok, read receipt, quota và lỗi policy thực tế.
- Refresh/rotation/revocation do TikTok thật phát sinh và tính khả dụng Customer Service của seller/shop.

Phần code và mock tests đã sẵn; các mục này cần nghiệm thu bằng checklist trong [TikTok setup](tiktok-setup.md). Các giới hạn 20 tin Business, phạm vi reply bảo thủ, chưa gửi media/tạo hội thoại/đánh dấu Shop đã đọc vẫn được giữ rõ ràng.

## Tài liệu bàn giao

- [Setup, file thay đổi, kiến trúc, migration, REST API, biến môi trường, Developer Console, approval và checklist live](tiktok-setup.md).
- [Nguồn API chính thức, phiên bản và khác biệt giữa Business/Shop](tiktok-api-research.md).

Ảnh và kết quả browser kiểm tra local lưu ở `/tmp/easychat-tiktok-validation/`: `browser-results.json`, `business-unconfigured-desktop.png`, `shop-unconfigured-mobile.png`, `apps-mobile.png`, `shop-mocked-selection-desktop.png`, `shop-mocked-selection-mobile.png`. Ảnh có chữ/ID “fixture” là minh họa kiểm thử giao diện, không phải kết nối TikTok thật.
