import { waWindow } from '../whatsapp/whatsapp.types';
import type { ChannelAccount, Conversation } from '@prisma/client';
import { z } from 'zod';
import { ApiError } from '../../common/api-error';
export const PAGE_WINDOW_MS = 24 * 60 * 60 * 1000;
export function channelSendPolicy(
  account: Pick<ChannelAccount, 'channelType' | 'connectionStatus'> &
    Partial<
      Pick<
        ChannelAccount,
        'capabilities' | 'rateLimitedUntil' | 'tokenExpiresAt'
      >
    >,
  conversation: Pick<Conversation, 'lastInboundAt'> &
    Partial<Pick<Conversation, 'providerState' | 'externalConversationId'>>,
  online: boolean,
  now = Date.now(),
) {
  const expiresAt =
    account.channelType === 'FACEBOOK_PAGE' && conversation.lastInboundAt
      ? new Date(conversation.lastInboundAt.getTime() + PAGE_WINDOW_MS)
      : null;
  if (account.channelType === 'WHATSAPP_BUSINESS') {
    const window = waWindow(conversation.lastInboundAt, now);
    const deny = (code: string, message: string) => ({
      allowed: false,
      code,
      message,
      expiresAt: window.expiresAt,
    });
    if (
      account.connectionStatus !== 'CONNECTED' ||
      (account.tokenExpiresAt && account.tokenExpiresAt.getTime() <= now)
    )
      return deny(
        'WHATSAPP_NOT_CONNECTED',
        'Kết nối lại WhatsApp Business để trả lời.',
      );
    if (
      !z
        .object({ sendMessages: z.literal(true) })
        .safeParse(account.capabilities).success
    )
      return deny(
        'WHATSAPP_PERMISSION_REQUIRED',
        'Tài khoản chưa có quyền gửi WhatsApp.',
      );
    if (!online)
      return deny('CHANNEL_WORKER_UNAVAILABLE', 'Worker đang ngoại tuyến.');
    if (account.rateLimitedUntil && account.rateLimitedUntil.getTime() > now)
      return deny(
        'WHATSAPP_RATE_LIMITED',
        'WhatsApp yêu cầu chờ trước khi gửi tiếp.',
      );
    if (
      !window.open ||
      z
        .object({ replyBlockedUntilInbound: z.literal(true) })
        .safeParse(conversation.providerState).success
    )
      return deny(
        'WHATSAPP_WINDOW_CLOSED',
        'Đã hết cửa sổ trả lời 24 giờ. Chọn mẫu đã duyệt nếu người nhận đã đồng ý.',
      );
    return {
      allowed: true,
      code: null,
      message: null,
      expiresAt: window.expiresAt,
    };
  }
  if (account.channelType === 'ZALO_OA') {
    const expiresAt = conversation.lastInboundAt
      ? new Date(conversation.lastInboundAt.getTime() + 48 * 3600000)
      : null;
    const code =
      account.connectionStatus !== 'CONNECTED'
        ? 'CHANNEL_NOT_CONNECTED'
        : !online
          ? 'CHANNEL_WORKER_UNAVAILABLE'
          : !expiresAt || expiresAt.getTime() <= now
            ? 'ZALO_OA_REPLY_WINDOW_CLOSED'
            : null;
    return {
      allowed: !code,
      code,
      message:
        code === 'ZALO_OA_REPLY_WINDOW_CLOSED'
          ? 'Gửi file OA trong 48 giờ từ tin khách hàng gần nhất.'
          : code
            ? 'Kết nối lại OA/worker trước khi gửi.'
            : null,
      expiresAt,
    };
  }
  if (account.channelType === 'FACEBOOK_PERSONAL')
    return {
      allowed: false,
      code: 'FACEBOOK_PERSONAL_UNSUPPORTED',
      message:
        'Messenger cá nhân chưa được hỗ trợ, bao gồm hội thoại mã hóa E2EE.',
      expiresAt,
    };
  if (account.channelType.startsWith('TELEGRAM_')) {
    const deny = (code: string, message: string) => ({
      allowed: false,
      code,
      message,
      expiresAt: null,
    });
    if (account.connectionStatus !== 'CONNECTED')
      return deny(
        'TELEGRAM_NOT_CONNECTED',
        'Kết nối lại tài khoản Telegram để trả lời.',
      );
    if (
      !z
        .object({ sendMessages: z.literal(true) })
        .safeParse(account.capabilities).success
    )
      return deny(
        'TELEGRAM_PERMISSION_DENIED',
        'Tài khoản Telegram chưa có quyền gửi.',
      );
    if (account.rateLimitedUntil && account.rateLimitedUntil.getTime() > now)
      return deny(
        'TELEGRAM_RATE_LIMITED',
        'Telegram yêu cầu chờ trước khi gửi tiếp.',
      );
    const state = z
      .object({
        canSend: z.literal(true),
        topicUnsupported: z.boolean().optional(),
      })
      .safeParse(conversation.providerState);
    if (
      !conversation.externalConversationId ||
      !state.success ||
      state.data.topicUnsupported
    )
      return deny(
        'TELEGRAM_CHAT_READ_ONLY',
        'Cuộc chat Telegram này chưa được phép trả lời hoặc là topic chưa hỗ trợ.',
      );
    if (account.channelType === 'TELEGRAM_BOT' && !conversation.lastInboundAt)
      return deny(
        'TELEGRAM_BOT_INTERACTION_REQUIRED',
        'Bot chỉ trả lời cuộc chat đã tương tác với bot.',
      );
    if (!online)
      return deny('CHANNEL_WORKER_UNAVAILABLE', 'Worker đang ngoại tuyến.');
    return { allowed: true, code: null, message: null, expiresAt: null };
  }
  if (['TIKTOK_BUSINESS', 'TIKTOK_SHOP'].includes(account.channelType)) {
    const deny = (code: string, message: string) => ({
      allowed: false,
      code,
      message,
      expiresAt: null,
    });
    if (account.connectionStatus !== 'CONNECTED')
      return deny(
        'CHANNEL_NOT_CONNECTED',
        'Kết nối lại tài khoản TikTok để trả lời.',
      );
    const caps = z
      .object({ sendMessages: z.literal(true) })
      .safeParse(account.capabilities);
    if (!caps.success)
      return deny(
        'TIKTOK_PERMISSION_DENIED',
        'TikTok chưa cấp quyền gửi tin nhắn cho tài khoản này.',
      );
    if (!conversation.externalConversationId)
      return deny(
        'TIKTOK_REPLY_NOT_ALLOWED',
        'Chỉ trả lời hội thoại TikTok đã đồng bộ.',
      );
    const hours = account.channelType === 'TIKTOK_BUSINESS' ? 48 : 168;
    if (
      !conversation.lastInboundAt ||
      conversation.lastInboundAt.getTime() + hours * 3600000 <= now
    )
      return deny(
        'TIKTOK_REPLY_WINDOW_CLOSED',
        'Cửa sổ trả lời TikTok đã đóng. Chờ khách gửi tin mới.',
      );
    if (account.channelType === 'TIKTOK_SHOP') {
      const state = z
        .object({ canSend: z.literal(true), checkedAt: z.number() })
        .safeParse(conversation.providerState);
      if (!state.success)
        return deny(
          'TIKTOK_REPLY_NOT_ALLOWED',
          'TikTok Shop chưa cho phép trả lời hội thoại này. Hãy đồng bộ lại.',
        );
      if (state.data.checkedAt + 600000 < now)
        return deny(
          'TIKTOK_SYNC_REQUIRED',
          'Đồng bộ hội thoại để kiểm tra quyền trả lời mới nhất.',
        );
    }
    if (!online)
      return deny(
        'CHANNEL_WORKER_UNAVAILABLE',
        'Bộ xử lý tin nhắn đang ngoại tuyến.',
      );
    return {
      allowed: true,
      code: null,
      message: null,
      expiresAt: new Date(
        conversation.lastInboundAt.getTime() + hours * 3600000,
      ),
    };
  }
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
  account: Pick<ChannelAccount, 'channelType' | 'connectionStatus'> &
    Partial<
      Pick<
        ChannelAccount,
        'capabilities' | 'rateLimitedUntil' | 'tokenExpiresAt'
      >
    >,
  conversation: Pick<Conversation, 'lastInboundAt'> &
    Partial<Pick<Conversation, 'providerState' | 'externalConversationId'>>,
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
