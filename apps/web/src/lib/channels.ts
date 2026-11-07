export type ProviderId =
  | 'zalo'
  | 'messenger'
  | 'telegram'
  | 'tiktok-business'
  | 'tiktok-shop'
  | 'instagram'
  | 'whatsapp'
  | 'email';
export type ProviderDefinition = {
  id: ProviderId;
  name: string;
  category: 'messaging' | 'email';
  available: boolean;
  description: string;
  color: string;
  background: string;
};

// UI metadata only. A provider becomes available after its backend adapter is implemented.
export const providers: ProviderDefinition[] = [
  {
    id: 'zalo',
    name: 'Zalo',
    category: 'messaging',
    available: true,
    description:
      'Kết nối tài khoản cá nhân và Official Account vào cùng một hộp thư.',
    color: '#0866ed',
    background: '#edf4ff',
  },
  {
    id: 'messenger',
    name: 'Messenger',
    category: 'messaging',
    available: true,
    description:
      'Nhận và trả lời tin nhắn Facebook Page. Messenger cá nhân đang thử nghiệm, chưa hỗ trợ kết nối.',
    color: '#7055e8',
    background: '#f2efff',
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    category: 'messaging',
    available: true,
    description: 'Tin nhắn số WhatsApp Business qua Cloud API chính thức.',
    color: '#139a62',
    background: '#edfaf3',
  },
  {
    id: 'tiktok-business',
    name: 'TikTok Business',
    category: 'messaging',
    available: true,
    description:
      'Tin nhắn Business chính thức; cần ứng dụng được TikTok duyệt và tài khoản đủ điều kiện.',
    color: '#111827',
    background: '#f1f5f9',
  },
  {
    id: 'tiktok-shop',
    name: 'TikTok Shop',
    category: 'messaging',
    available: true,
    description:
      'Hội thoại người mua và người bán; cần quyền Customer Service của TikTok Shop.',
    color: '#cf3562',
    background: '#fff1f5',
  },
  {
    id: 'telegram',
    name: 'Telegram',
    category: 'messaging',
    available: true,
    description:
      'Kết nối bot qua API chính thức hoặc tài khoản cá nhân bằng TDLib.',
    color: '#168ac0',
    background: '#edf8ff',
  },
  {
    id: 'instagram',
    name: 'Instagram',
    category: 'messaging',
    available: false,
    description: 'Giữ liên lạc với khách hàng qua tin nhắn Instagram.',
    color: '#cd5480',
    background: '#fff0f5',
  },
  {
    id: 'email',
    name: 'Email',
    category: 'email',
    available: false,
    description: 'Theo dõi email và tin nhắn của bạn trong một không gian.',
    color: '#c87832',
    background: '#fff5e9',
  },
];
export const channelDefinitions: Record<
  string,
  {
    providerId: ProviderId;
    label: string;
    shortLabel: string;
    settingsPath: string;
    experimental?: boolean;
  }
> = {
  WHATSAPP_BUSINESS: {
    providerId: 'whatsapp',
    label: 'WhatsApp Business',
    shortLabel: 'Business Cloud API',
    settingsPath: '/whatsapp',
  },
  TELEGRAM_PERSONAL: {
    providerId: 'telegram',
    label: 'Telegram cá nhân',
    shortLabel: 'Cá nhân',
    settingsPath: '/telegram/personal',
  },
  TELEGRAM_BOT: {
    providerId: 'telegram',
    label: 'Telegram Bot',
    shortLabel: 'Bot',
    settingsPath: '/telegram/bot',
  },
  ZALO_PERSONAL: {
    providerId: 'zalo',
    label: 'Zalo cá nhân',
    shortLabel: 'Cá nhân',
    settingsPath: '/personal',
  },
  ZALO_OA: {
    providerId: 'zalo',
    label: 'Zalo Official Account',
    shortLabel: 'Official Account',
    settingsPath: '/connection',
  },
  TIKTOK_BUSINESS: {
    providerId: 'tiktok-business',
    label: 'TikTok Business',
    shortLabel: 'TikTok Business',
    settingsPath: '/tiktok/business',
  },
  TIKTOK_SHOP: {
    providerId: 'tiktok-shop',
    label: 'TikTok Shop',
    shortLabel: 'TikTok Shop',
    settingsPath: '/tiktok/shop',
  },
  FACEBOOK_PAGE: {
    providerId: 'messenger',
    label: 'Facebook Page',
    shortLabel: 'Facebook Page',
    settingsPath: '/facebook/page',
  },
  FACEBOOK_PERSONAL: {
    providerId: 'messenger',
    label: 'Messenger cá nhân',
    shortLabel: 'Messenger cá nhân',
    settingsPath: '/facebook/personal',
    experimental: true,
  },
};
export function channelInfo(type?: string) {
  return (
    channelDefinitions[type ?? 'ZALO_OA'] ?? {
      providerId: undefined,
      label: 'Ứng dụng khác',
      shortLabel: 'Tài khoản',
      settingsPath: '/apps',
    }
  );
}
export function connectionLabel(status: string) {
  return (
    (
      {
        CONNECTED: 'Đã kết nối',
        RECONNECTING: 'Đang kết nối lại',
        REAUTH_REQUIRED: 'Cần đăng nhập lại',
        DISCONNECTED: 'Chưa kết nối',
        QR_PENDING: 'Chờ quét mã QR',
        CONNECTING: 'Chờ xác nhận',
        ERROR: 'Cần kiểm tra',
        UNSUPPORTED: 'Chưa hỗ trợ',
        PERMISSION_REQUIRED: 'Cần cấp quyền',
      } as Record<string, string>
    )[status] ?? 'Chưa kết nối'
  );
}

export function sendBlockedMessage(reason?: string | null) {
  return (
    (
      {
        ZALO_OA_MEDIA_ONLY:
          'Dùng nút Tài liệu để gửi file qua OA. Văn bản và âm thanh chưa bật ở kênh này.',
        ZALO_OA_REPLY_WINDOW_CLOSED:
          'Chỉ gửi file OA trong 48 giờ từ tin khách hàng gần nhất. Chờ khách nhắn lại.',
        ZALO_MEDIA_UPLOAD_FAILED:
          'Chưa tải được tệp lên Zalo. Hệ thống chỉ thử lại trong giới hạn an toàn.',
        ZALO_MEDIA_FAILED:
          'OA chưa chấp nhận file. Kiểm tra quyền gửi tin, định dạng và hạn mức của OA.',
        MEDIA_EXPIRED:
          'Tệp chờ gửi đã hết hạn. Hãy chọn lại tệp để gửi tin mới.',
        MEDIA_UNAVAILABLE: 'Chưa đọc được tệp. Kiểm tra lưu trữ và thử lại.',
        MEDIA_CHANNEL_UNSUPPORTED: 'Kênh này chưa hỗ trợ loại tệp đã chọn.',
        TELEGRAM_MEDIA_UNAVAILABLE:
          'Chưa tải được tệp Telegram hoặc tệp vượt dung lượng cho phép.',
        WHATSAPP_NOT_CONFIGURED:
          'Chưa cấu hình Meta App và webhook HTTPS tại máy chủ.',
        WHATSAPP_NOT_CONNECTED: 'Kết nối lại số WhatsApp Business để trả lời.',
        WHATSAPP_REAUTH_REQUIRED:
          'Token WhatsApp đã hết hạn hoặc bị thu hồi. Kết nối lại bằng token được cấp quyền.',
        WHATSAPP_PERMISSION_REQUIRED:
          'Thiếu quyền WhatsApp Business hoặc quyền truy cập số điện thoại.',
        WHATSAPP_REGISTRATION_REQUIRED:
          'Số điện thoại cần đăng ký Cloud API bằng PIN của số đã xác minh.',
        WHATSAPP_WINDOW_CLOSED:
          'Đã hết cửa sổ trả lời 24 giờ. Chọn mẫu được Meta duyệt nếu người nhận đã đồng ý.',
        WHATSAPP_RATE_LIMITED:
          'WhatsApp yêu cầu chờ trước khi gửi tiếp. Hệ thống sẽ tôn trọng thời gian giới hạn.',
        WHATSAPP_RECIPIENT_RESTRICTED:
          'Meta chưa cho phép gửi tin tới người nhận này. Kiểm tra sự đồng ý và giới hạn hiện tại.',
        WHATSAPP_SEND_UNKNOWN:
          'Chưa rõ kết quả gửi. Hệ thống chờ webhook xác nhận và không tự gửi lại.',
        WHATSAPP_TEMPLATE_REJECTED:
          'Mẫu hoặc tham số bị Meta từ chối. Kiểm tra mẫu đã duyệt trước khi thử lại.',
        WHATSAPP_WEBHOOK_NOT_CONFIGURED:
          'Webhook Meta chưa đúng URL hoặc chưa đăng ký trường messages.',
        WHATSAPP_PHONE_NOT_AUTHORIZED:
          'Số điện thoại không thuộc WABA được token này cấp quyền.',
        WHATSAPP_CLEANUP_UNCONFIRMED:
          'Đã ngắt trong easyChat; chưa xác nhận gỡ subscription trên Meta. Kiểm tra Meta App nếu cần.',
        TELEGRAM_NOT_CONFIGURED: 'Chưa cấu hình ứng dụng Telegram ở máy chủ.',
        TELEGRAM_NATIVE_UNAVAILABLE:
          'TDLib native chưa sẵn sàng. Kiểm tra thư viện và bridge tại máy chủ.',
        TELEGRAM_WORKER_UNAVAILABLE:
          'Worker Telegram đang ngoại tuyến. Khởi động lại worker chung.',
        TELEGRAM_NOT_CONNECTED:
          'Kết nối lại tài khoản Telegram trước khi trả lời.',
        TELEGRAM_REAUTH_REQUIRED:
          'Quyền Telegram đã hết hạn hoặc bị thu hồi. Kết nối lại tài khoản.',
        TELEGRAM_PERMISSION_DENIED:
          'Telegram chưa cho phép gửi trong cuộc chat này. Kiểm tra quyền và trạng thái nhóm.',
        TELEGRAM_CHAT_READ_ONLY:
          'Chat này chỉ xem hoặc là topic chưa hỗ trợ gửi. Đồng bộ để kiểm tra lại.',
        TELEGRAM_RATE_LIMITED:
          'Telegram yêu cầu chờ trước khi thử lại. Hệ thống sẽ tôn trọng thời gian giới hạn.',
        TELEGRAM_SEND_UNKNOWN:
          'Chưa rõ kết quả gửi. Kiểm tra Telegram trước khi tạo yêu cầu mới.',
        TELEGRAM_SEND_FAILED: 'Telegram xác nhận tin chưa gửi được.',
        TELEGRAM_WEBHOOK_MISMATCH:
          'Webhook của bot chưa trỏ về easyChat. Kết nối lại bot để đăng ký.',
        TELEGRAM_WEBHOOK_DELIVERY_ERROR:
          'Telegram đang báo lỗi giao webhook. Kiểm tra HTTPS và máy chủ nhận.',
        TELEGRAM_WEBHOOK_CLEANUP_UNCONFIRMED:
          'Đã ngắt trong easyChat, nhưng chưa xác nhận gỡ webhook trên Telegram.',
        TELEGRAM_SESSION_CLEANUP_UNCONFIRMED:
          'Đã ngắt trong easyChat; chưa xác nhận thu hồi phiên Telegram. Kiểm tra Telegram → Settings → Devices nếu cần.',
        TELEGRAM_BOT_HISTORY_UNAVAILABLE:
          'Bot API không cung cấp lịch sử chat tùy ý.',
        TELEGRAM_AUTH_SESSION_EXPIRED:
          'Phiên xác thực hết hạn. Bắt đầu kết nối lại.',
        TELEGRAM_AUTH_INPUT_INVALID:
          'Mã xác minh hoặc mật khẩu chưa đúng. Kiểm tra và nhập lại.',
        TELEGRAM_AUTH_CODE_EXPIRED:
          'Mã xác minh đã hết hạn. Bắt đầu kết nối lại.',
        TELEGRAM_AUTH_STATE_CHANGED:
          'Bước xác thực đã thay đổi. Làm mới trạng thái rồi tiếp tục.',
        TELEGRAM_ACCOUNT_MISMATCH:
          'Đây là tài khoản Telegram khác. Tạo kết nối riêng để giữ đúng lịch sử.',
        TELEGRAM_CHAT_MIGRATED:
          'Nhóm đã chuyển sang supergroup. Dùng hội thoại mới do Telegram cung cấp.',
        TELEGRAM_SYNC_LIMIT_REACHED:
          'Đã tới giới hạn của lượt đồng bộ. Bấm Đồng bộ để tiếp tục phần còn lại.',
        TELEGRAM_NETWORK_RECONNECTING:
          'Telegram đang kết nối lại mạng. Chờ phiên sẵn sàng rồi trả lời.',
        TIKTOK_NOT_CONFIGURED: 'Ứng dụng TikTok chưa được cấu hình đầy đủ.',
        TIKTOK_AUTH_FAILED:
          'Chưa hoàn tất cấp quyền TikTok. Bắt đầu kết nối lại.',
        TIKTOK_AUTH_URL_INVALID:
          'URL cấp quyền chưa đúng. Sao chép URL chính thức từ trang quản lý ứng dụng TikTok.',
        TIKTOK_PUBLIC_HTTPS_REQUIRED:
          'Cần URL HTTPS công khai để hoàn tất đăng ký webhook TikTok.',
        TIKTOK_PERMISSION_DENIED:
          'TikTok chưa cấp đủ quyền. Kiểm tra quyền ứng dụng và kết nối lại tài khoản.',
        TIKTOK_SHOP_APPROVAL_REQUIRED:
          'Ứng dụng cần được TikTok Shop duyệt Customer Service và cấp quyền truy cập shop.',
        TIKTOK_ACCOUNT_NOT_ELIGIBLE:
          'Tài khoản chưa đủ điều kiện hoặc chưa được cấp quyền Business Messaging.',
        TIKTOK_TOKEN_EXPIRED:
          'Quyền truy cập TikTok đã hết hạn hoặc bị thu hồi. Kết nối lại tài khoản.',
        TIKTOK_TOKEN_REFRESH_UNKNOWN:
          'Chưa xác nhận được lần làm mới token. Kết nối lại tài khoản TikTok.',
        TIKTOK_SEND_UNKNOWN:
          'Chưa xác định được kết quả gửi. Kiểm tra TikTok trước khi tạo tin nhắn mới.',
        TIKTOK_REPLY_WINDOW_CLOSED:
          'Cửa sổ trả lời TikTok đã đóng. Bạn có thể trả lời khi khách gửi tin mới.',
        TIKTOK_REPLY_LIMIT_REACHED:
          'Đã đạt giới hạn trả lời của lượt tương tác này. Chờ tin mới từ khách.',
        TIKTOK_REPLY_NOT_ALLOWED:
          'TikTok chưa cho phép trả lời hội thoại này. Đồng bộ và kiểm tra lại quyền.',
        TIKTOK_SYNC_REQUIRED:
          'Cần đồng bộ lại để kiểm tra quyền trả lời mới nhất.',
        TIKTOK_RATE_LIMITED:
          'TikTok đang giới hạn tần suất. Hệ thống sẽ thử lại trong giới hạn cho phép.',
        TIKTOK_SYNC_LIMIT_REACHED:
          'Đã tới giới hạn đồng bộ của lượt này. Bấm Đồng bộ để tiếp tục phần còn lại.',
        FACEBOOK_PAGE_MESSAGING_WINDOW_CLOSED:
          'Đã hết thời gian trả lời 24 giờ. Bạn có thể trả lời khi khách hàng nhắn tin lại cho Page.',
        FACEBOOK_PAGE_TOKEN_EXPIRED:
          'Quyền truy cập Page đã hết hạn. Kết nối lại Page để tiếp tục trả lời.',
        FACEBOOK_PAGE_PERMISSION_DENIED:
          'Page chưa được cấp đủ quyền nhắn tin. Kết nối lại và kiểm tra quyền được cấp.',
        FACEBOOK_PERSONAL_UNSUPPORTED:
          'Messenger cá nhân hiện chưa hỗ trợ đọc hoặc gửi tin nhắn, bao gồm hội thoại mã hóa đầu cuối.',
        CHANNEL_NOT_CONNECTED: 'Kết nối lại tài khoản để trả lời.',
        CHANNEL_WORKER_UNAVAILABLE:
          'Bộ xử lý tin nhắn đang ngoại tuyến. Vui lòng thử lại sau.',
        FACEBOOK_REAUTH_REQUIRED:
          'Quyền truy cập Page đã hết hạn hoặc bị thu hồi. Kết nối lại Page.',
        FACEBOOK_PERMISSION_DENIED:
          'Page thiếu quyền nhắn tin. Kết nối lại và kiểm tra quyền đã cấp.',
        FACEBOOK_SEND_UNKNOWN:
          'Chưa xác định được kết quả gửi. Kiểm tra hội thoại trên Messenger trước khi gửi tin mới.',
        MESSAGE_NOT_RETRYABLE:
          'Tin nhắn này chưa thể gửi lại an toàn. Kiểm tra hội thoại trên ứng dụng gốc trước.',
        WORKER_UNAVAILABLE:
          'Bộ xử lý tin nhắn đang ngoại tuyến. Vui lòng thử lại sau.',
      } as Record<string, string>
    )[reason ?? ''] ??
    'Tài khoản hiện chưa thể gửi tin nhắn. Kiểm tra trạng thái kết nối để tiếp tục.'
  );
}
export function conversationPreview(value: string | null) {
  if (!value) return 'Chưa có tin nhắn';
  return (
    (
      {
        '[image]': '📷  Hình ảnh',
        '[photo]': '📷  Hình ảnh',
        '[sticker]': 'Sticker',
        '[gif]': 'Ảnh động',
        '[unsupported]': 'Tin nhắn khác',
        '[deleted]': 'Tin nhắn đã xóa',
        '[file]': 'Tệp đính kèm',
        '[document]': 'Tài liệu',
        '[audio]': 'Âm thanh',
        '[voice]': 'Tin nhắn thoại',
      } as Record<string, string>
    )[value] ?? value
  );
}
