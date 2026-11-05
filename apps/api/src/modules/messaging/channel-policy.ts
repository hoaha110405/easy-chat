import type { ChannelAccount, Conversation } from '@prisma/client';
import { ApiError } from '../../common/api-error';
export const PAGE_WINDOW_MS = 24 * 60 * 60 * 1000;
export function channelSendPolicy(
  account: Pick<ChannelAccount, 'channelType' | 'connectionStatus'>,
  conversation: Pick<Conversation, 'lastInboundAt'>,
  online: boolean,
  now = Date.now(),
) {
  const expiresAt =
    account.channelType === 'FACEBOOK_PAGE' && conversation.lastInboundAt
      ? new Date(conversation.lastInboundAt.getTime() + PAGE_WINDOW_MS)
      : null;
  if (account.channelType === 'FACEBOOK_PERSONAL')
    return {
      allowed: false,
      code: 'FACEBOOK_PERSONAL_UNSUPPORTED',
      message:
        'Messenger cá nhân chưa được hỗ trợ, bao gồm hội thoại mã hóa E2EE.',
      expiresAt,
    };
  if (!['ZALO_PERSONAL', 'FACEBOOK_PAGE'].includes(account.channelType))
    return {
      allowed: false,
      code: 'CHANNEL_UNSUPPORTED',
      message: 'Kênh này chưa hỗ trợ gửi tin nhắn.',
      expiresAt,
    };
  if (account.connectionStatus !== 'CONNECTED')
    return {
      allowed: false,
      code: 'CHANNEL_NOT_CONNECTED',
      message: 'Kết nối lại tài khoản để gửi tin nhắn.',
      expiresAt,
    };
  if (
    account.channelType === 'FACEBOOK_PAGE' &&
    (!expiresAt || expiresAt.getTime() <= now)
  )
    return {
      allowed: false,
      code: 'FACEBOOK_PAGE_MESSAGING_WINDOW_CLOSED',
      message:
        'Đã ngoài cửa sổ trả lời 24 giờ. Người nhận cần gửi tin mới cho Page trước khi bạn có thể trả lời.',
      expiresAt,
    };
  if (!online)
    return {
      allowed: false,
      code: 'CHANNEL_WORKER_UNAVAILABLE',
      message: 'Dịch vụ đồng bộ đang tạm dừng. Vui lòng thử lại sau.',
      expiresAt,
    };
  return { allowed: true, code: null, message: null, expiresAt };
}
export function assertChannelSend(
  account: Pick<ChannelAccount, 'channelType' | 'connectionStatus'>,
  conversation: Pick<Conversation, 'lastInboundAt'>,
  online: boolean,
) {
  const policy = channelSendPolicy(account, conversation, online);
  if (!policy.allowed)
    throw new ApiError(
      policy.code === 'FACEBOOK_PERSONAL_UNSUPPORTED' ? 501 : 409,
      policy.code!,
      policy.message!,
    );
}
