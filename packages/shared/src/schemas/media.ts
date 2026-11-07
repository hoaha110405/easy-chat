import { z } from 'zod';
export const mediaInputSchema = z.object({
  kind: z.enum(['document', 'audio']),
  caption: z.string().trim().max(1024).default(''),
  idempotencyKey: z.string().uuid(),
});
export const mediaSupportSchema = z.object({
  document: z.boolean(),
  audio: z.boolean(),
  captions: z.boolean(),
  documentMaxBytes: z.number(),
  audioMaxBytes: z.number(),
  documentAccept: z.string(),
  audioAccept: z.string(),
  reason: z.string().nullable(),
  canSend: z.boolean(),
});
export type MediaSupport = z.infer<typeof mediaSupportSchema>;
export function channelMediaSupport(
  channelType: string,
): Omit<MediaSupport, 'canSend'> {
  const base = {
    documentMaxBytes: 20_000_000,
    audioMaxBytes: 16_000_000,
    documentAccept: '.pdf,.txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx',
    audioAccept: '.mp3,.m4a',
    captions: false,
    reason: null as string | null,
  };
  if (channelType === 'WHATSAPP_BUSINESS')
    return {
      ...base,
      document: true,
      audio: true,
      captions: true,
      audioAccept: '.aac,.amr,.mp3,.m4a,.ogg',
    };
  if (channelType === 'ZALO_PERSONAL')
    return { ...base, document: true, audio: true, audioAccept: '.mp3,.m4a' };
  if (['TELEGRAM_BOT', 'TELEGRAM_PERSONAL'].includes(channelType))
    return {
      ...base,
      document: true,
      audio: true,
      captions: true,
      audioAccept: '.mp3,.m4a',
    };
  if (channelType === 'FACEBOOK_PAGE')
    return { ...base, document: true, audio: true, audioAccept: '.mp3,.m4a' };
  if (channelType === 'ZALO_OA')
    return {
      ...base,
      document: true,
      audio: false,
      documentMaxBytes: 5_000_000,
      documentAccept: '.pdf,.doc,.docx,.csv',
      reason: 'Zalo OA không có API gửi tệp âm thanh trong luồng tư vấn này.',
    };
  return {
    ...base,
    document: false,
    audio: false,
    reason: channelType.startsWith('TIKTOK_')
      ? 'API TikTok hiện không hỗ trợ gửi tài liệu hoặc âm thanh trong hội thoại này.'
      : 'Kênh này chưa được nền tảng cấp API gửi tài liệu và âm thanh.',
  };
}
