import { z } from 'zod';
import {
  telegramId,
  unsignedId,
  TelegramError,
  type TelegramMessage,
} from '../telegram/telegram.types';
import type { TdObject } from './tdjson.client';
const type = z.object({ '@type': z.string() }).passthrough();
export const tdMessageSchema = z.object({
  id: telegramId,
  chat_id: telegramId,
  sender_id: z.object({
    '@type': z.enum(['messageSenderUser', 'messageSenderChat']),
    user_id: telegramId.optional(),
    chat_id: telegramId.optional(),
  }),
  is_outgoing: z.boolean(),
  date: z.number().int().positive(),
  edit_date: z.number().int().optional(),
  content: type,
  sending_state: type.nullable().optional(),
  topic_id: type.nullable().optional(),
});
export const tdChatSchema = z.object({
  id: telegramId,
  title: z.string(),
  type: type,
  permissions: z
    .object({ can_send_basic_messages: z.boolean() })
    .passthrough()
    .optional(),
  easychat_can_send: z.boolean().optional(),
  easychat_topic_unsupported: z.boolean().optional(),
  unread_count: z.number().int().nonnegative().optional(),
  last_read_inbox_message_id: telegramId.optional(),
  last_read_outbox_message_id: telegramId.optional(),
  last_message: tdMessageSchema.nullable().optional(),
  positions: z
    .array(z.object({ list: type, order: telegramId }).passthrough())
    .optional(),
});
export function tdChatAllowed(value: unknown) {
  const c = tdChatSchema.parse(value);
  return (
    ['chatTypePrivate', 'chatTypeBasicGroup', 'chatTypeSupergroup'].includes(
      c.type['@type'],
    ) &&
    !(c.type['@type'] === 'chatTypeSupergroup' && c.type.is_channel === true)
  );
}
export function mapTdMessage(value: unknown): TelegramMessage {
  const m = tdMessageSchema.parse(value);
  const text =
    m.content['@type'] === 'messageText' ? m.content.text : m.content.caption;
  const body = z.object({ text: z.string().max(100000) }).safeParse(text);
  const senderId = m.sender_id.user_id ?? m.sender_id.chat_id;
  if (!senderId) throw new TelegramError('TELEGRAM_INVALID_RESPONSE');
  const kinds: Record<string, string> = {
    messageText: 'text',
    messagePhoto: 'image',
    messageDocument: 'file',
    messageVideo: 'video',
    messageSticker: 'sticker',
    messageAnimation: 'gif',
    messageVoiceNote: 'audio',
    messageAudio: 'audio',
  };
  const info = z
    .record(z.unknown())
    .safeParse(m.content.document ?? m.content.audio ?? m.content.voice_note);
  let media: TelegramMessage['media'];
  if (info.success) {
    const f = z
      .object({ id: z.number().int().positive() })
      .safeParse(info.data.document ?? info.data.audio ?? info.data.voice);
    if (f.success)
      media = {
        fileId: String(f.data.id),
        name:
          typeof info.data.file_name === 'string'
            ? info.data.file_name
            : undefined,
        mimeType:
          typeof info.data.mime_type === 'string'
            ? info.data.mime_type
            : undefined,
      };
  }
  return {
    ...(media ? { media } : {}),
    id: m.id,
    chatId: m.chat_id,
    senderId,
    direction: m.is_outgoing ? 'OUTGOING' : 'INCOMING',
    type: kinds[m.content['@type']] ?? 'unsupported',
    content: body.success ? body.data.text : '',
    at: new Date(m.date * 1000),
    ...(m.edit_date ? { editedAt: new Date(m.edit_date * 1000) } : {}),
    topic: Boolean(m.topic_id),
  };
}
export function authPresentation(state: TdObject) {
  const kind = state['@type'];
  const names: Record<string, string> = {
    authorizationStateWaitTdlibParameters: 'INITIALIZING',
    authorizationStateWaitPhoneNumber: 'PHONE_REQUIRED',
    authorizationStateWaitCode: 'CODE_REQUIRED',
    authorizationStateWaitPassword: 'PASSWORD_REQUIRED',
    authorizationStateWaitEmailAddress: 'EMAIL_REQUIRED',
    authorizationStateWaitEmailCode: 'EMAIL_CODE_REQUIRED',
    authorizationStateWaitOtherDeviceConfirmation:
      'DEVICE_CONFIRMATION_REQUIRED',
    authorizationStateReady: 'READY',
    authorizationStateLoggingOut: 'CLOSING',
    authorizationStateClosing: 'CLOSING',
    authorizationStateClosed: 'CLOSED',
    authorizationStateWaitPremiumPurchase: 'PREMIUM_REQUIRED',
    authorizationStateWaitRegistration: 'REGISTRATION_REQUIRED',
  };
  let confirmationLink: string | undefined;
  if (
    kind === 'authorizationStateWaitOtherDeviceConfirmation' &&
    typeof state.link === 'string' &&
    /^tg:\/\/login\?token=[A-Za-z0-9_=-]+$/.test(state.link)
  )
    confirmationLink = state.link;
  const code = z
    .object({
      type: type,
      phone_number: z.string().optional(),
      length: z.number().optional(),
    })
    .safeParse(state.code_info);
  return {
    state: names[kind] ?? 'ADDITIONAL_ACTION_REQUIRED',
    tdlibState: kind,
    ...(confirmationLink ? { confirmationLink } : {}),
    ...(code.success ? { codeDelivery: code.data.type['@type'] } : {}),
    ...(typeof state.password_hint === 'string'
      ? { passwordHint: state.password_hint.slice(0, 200) }
      : {}),
  };
}
export function authRequest(
  state: string,
  action: string,
  value?: string,
): Record<string, unknown> {
  if (
    action === 'qr' &&
    [
      'authorizationStateWaitPhoneNumber',
      'authorizationStateWaitCode',
      'authorizationStateWaitPassword',
      'authorizationStateWaitEmailAddress',
      'authorizationStateWaitEmailCode',
      'authorizationStateWaitRegistration',
      'authorizationStateWaitPremiumPurchase',
    ].includes(state)
  )
    return { '@type': 'requestQrCodeAuthentication', other_user_ids: [] };
  const choices: Record<string, [string, string, string]> = {
    phone: [
      'authorizationStateWaitPhoneNumber',
      'setAuthenticationPhoneNumber',
      'phone_number',
    ],
    code: ['authorizationStateWaitCode', 'checkAuthenticationCode', 'code'],
    password: [
      'authorizationStateWaitPassword',
      'checkAuthenticationPassword',
      'password',
    ],
    email: [
      'authorizationStateWaitEmailAddress',
      'setAuthenticationEmailAddress',
      'email_address',
    ],
    email_code: [
      'authorizationStateWaitEmailCode',
      'checkAuthenticationEmailCode',
      'code',
    ],
  };
  const selected = choices[action];
  if (!selected || state !== selected[0] || !value)
    throw new TelegramError('TELEGRAM_AUTH_STATE_CHANGED');
  return {
    '@type': selected[1],
    [selected[2]]:
      action === 'email_code'
        ? { '@type': 'emailAddressAuthenticationCode', code: value }
        : value,
    ...(action === 'phone' ? { settings: null } : {}),
  };
}
export const validTdVersion = (result: TdObject) =>
  result['@type'] === 'optionValueString' &&
  typeof result.value === 'string' &&
  result.value === '1.8.69';
export const tdSenderId = unsignedId;
