export type ProviderId =
  'zalo' | 'messenger' | 'instagram' | 'whatsapp' | 'email';
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
    id: 'instagram',
    name: 'Instagram',
    category: 'messaging',
    available: false,
    description: 'Giữ liên lạc với khách hàng qua tin nhắn Instagram.',
    color: '#cd5480',
    background: '#fff0f5',
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    category: 'messaging',
    available: false,
    description: 'Mở rộng hộp thư với các cuộc trò chuyện WhatsApp.',
    color: '#139a62',
    background: '#edfaf3',
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
        CONNECTED: 'Đang kết nối',
        RECONNECTING: 'Đang kết nối lại',
        REAUTH_REQUIRED: 'Cần đăng nhập lại',
        DISCONNECTED: 'Chưa kết nối',
        QR_PENDING: 'Chờ quét mã QR',
        CONNECTING: 'Chờ xác nhận',
        ERROR: 'Cần kiểm tra',
        UNSUPPORTED: 'Chưa hỗ trợ',
      } as Record<string, string>
    )[status] ?? 'Chưa kết nối'
  );
}

export function sendBlockedMessage(reason?: string | null) {
  return (
    (
      {
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
          'Tin nhắn này chưa thể gửi lại an toàn. Kiểm tra hội thoại trên Messenger trước.',
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
      } as Record<string, string>
    )[value] ?? value
  );
}
