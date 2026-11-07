import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { channelMediaSupport, mediaInputSchema } from '@zalo/shared';
import type { ChannelAccount, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { MediaStore } from '../../common/media-store';
import { ApiError } from '../../common/api-error';
import { ADMIN_OWNER_ID } from '../auth/auth.service';
import { serializeMessage } from '../inbox/inbox.service';
import { personalWorkerOnline } from '../zalo-personal/personal-runtime';
import { channelSendPolicy } from '../messaging/channel-policy';
import { publishEvent } from '../realtime/publish';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import {
  validateWhatsAppUpload,
  type WhatsAppUpload,
} from '../whatsapp/whatsapp.media';
import { whatsappApiError } from '../whatsapp/whatsapp.controller';
export const mediaWhereOwner = (ownerId: string): Prisma.MessageWhereInput => ({
  OR: [
    { channelAccount: { ownerId } },
    ...(ownerId === ADMIN_OWNER_ID ? [{ connectionId: { not: null } }] : []),
  ],
});
@Injectable()
export class MediaService {
  constructor(
    readonly db: PrismaService,
    readonly store: MediaStore,
    readonly whatsapp: WhatsAppService,
  ) {}
  async message(ownerId: string, id: string) {
    const m = await this.db.message.findFirst({
      where: { id, deletedAt: null, ...mediaWhereOwner(ownerId) },
      include: { channelAccount: true },
    });
    if (!m)
      throw new ApiError(
        404,
        'MEDIA_NOT_FOUND',
        'Không tìm thấy tệp trong tài khoản của bạn.',
      );
    return m;
  }
  async send(
    ownerId: string,
    conversationId: string,
    input: z.infer<typeof mediaInputSchema>,
    file?: WhatsAppUpload,
  ) {
    const conversation = await this.db.conversation.findFirst({
      where: {
        id: conversationId,
        OR: [
          { channelAccount: { ownerId } },
          ...(ownerId === ADMIN_OWNER_ID
            ? [{ connectionId: { not: null } }]
            : []),
        ],
      },
      include: { channelAccount: true, connection: true },
    });
    if (!conversation)
      throw new ApiError(
        404,
        'CONVERSATION_NOT_FOUND',
        'Không tìm thấy hội thoại.',
      );
    const type = conversation.channelAccount?.channelType ?? 'ZALO_OA',
      support = channelMediaSupport(type);
    if (type === 'WHATSAPP_BUSINESS') {
      try {
        return await this.whatsapp.sendMedia(
          ownerId,
          conversationId,
          input,
          file,
        );
      } catch (e) {
        whatsappApiError(e);
      }
    }
    if (!support[input.kind])
      throw new ApiError(
        409,
        'MEDIA_CHANNEL_UNSUPPORTED',
        support.reason ?? 'Kênh này chưa hỗ trợ loại tệp đã chọn.',
      );
    if (input.caption && !support.captions)
      throw new ApiError(
        400,
        'MEDIA_CAPTION_UNSUPPORTED',
        'Gửi nội dung văn bản thành tin riêng cho kênh này.',
      );
    if (!file)
      throw new ApiError(
        400,
        'MEDIA_REQUIRED',
        'Chọn một tài liệu hoặc tệp âm thanh.',
      );
    const ext =
      '.' + (file.originalname.split('.').at(-1)?.toLowerCase() ?? '');
    if (
      !(
        input.kind === 'document' ? support.documentAccept : support.audioAccept
      )
        .split(',')
        .includes(ext) ||
      file.size >
        (input.kind === 'document'
          ? support.documentMaxBytes
          : support.audioMaxBytes)
    )
      throw new ApiError(
        413,
        'MEDIA_UNSUPPORTED',
        'Loại hoặc dung lượng tệp không được kênh này hỗ trợ.',
      );
    let upload: ReturnType<typeof validateWhatsAppUpload>;
    try {
      upload = validateWhatsAppUpload(
        ext === '.csv'
          ? {
              ...file,
              originalname: file.originalname.slice(0, -4) + '.txt',
              mimetype:
                !file.mimetype ||
                [
                  'text/csv',
                  'application/csv',
                  'application/vnd.ms-excel',
                  'application/octet-stream',
                ].includes(file.mimetype)
                  ? 'text/plain'
                  : file.mimetype,
            }
          : file,
        input.kind,
      );
      if (ext === '.csv') {
        upload.mime = 'text/csv';
        upload.name = upload.name.slice(0, -4) + '.csv';
      }
    } catch {
      throw new ApiError(
        400,
        'MEDIA_INVALID_FILE',
        'Nội dung tệp không khớp định dạng hoặc loại MIME được hỗ trợ.',
      );
    }
    return this.db.$transaction(
      async (tx) => {
        let accountId = conversation.channelAccountId;
        if (!accountId && conversation.connectionId) {
          const c = await tx.zaloConnection.findUniqueOrThrow({
            where: { id: conversation.connectionId },
          });
          if (c.status !== 'CONNECTED')
            throw new ApiError(
              409,
              'CHANNEL_NOT_CONNECTED',
              'Kết nối lại Zalo OA để gửi.',
            );
          const bridge = await tx.channelAccount.upsert({
            where: {
              ownerId_channelType_externalAccountId: {
                ownerId,
                channelType: 'ZALO_OA',
                externalAccountId: c.oaId,
              },
            },
            create: {
              ownerId,
              channelType: 'ZALO_OA',
              externalAccountId: c.oaId,
              name: c.oaName,
              avatarUrl: c.avatarUrl,
              connectionStatus: 'CONNECTED',
              providerMetadata: { connectionId: c.id },
            },
            update: {
              connectionStatus: 'CONNECTED',
              name: c.oaName,
              avatarUrl: c.avatarUrl,
            },
          });
          accountId = bridge.id;
          // Only the command uses the OA dispatch account; preserve the original one-channel conversation/message constraints.
        }
        const a = (
          await tx.$queryRaw<
            ChannelAccount[]
          >`SELECT * FROM "ChannelAccount" WHERE "id"=${accountId} FOR UPDATE`
        )[0];
        if (!a)
          throw new ApiError(
            409,
            'CHANNEL_NOT_CONNECTED',
            'Tài khoản chưa sẵn sàng gửi.',
          );
        const old = conversation.connectionId
          ? await tx.message.findFirst({
              where: {
                connectionId: conversation.connectionId,
                idempotencyKey: input.idempotencyKey,
              },
            })
          : await tx.message.findUnique({
              where: {
                channelAccountId_idempotencyKey: {
                  channelAccountId: a.id,
                  idempotencyKey: input.idempotencyKey,
                },
              },
            });
        if (old) {
          const v = z
            .object({
              mediaUpload: z.object({
                sha256: z.string(),
                name: z.string(),
                kind: z.string(),
                caption: z.string(),
              }),
            })
            .safeParse(old.metadata);
          if (
            old.conversationId !== conversationId ||
            !v.success ||
            v.data.mediaUpload.sha256 !== upload.sha256 ||
            v.data.mediaUpload.name !== upload.name ||
            v.data.mediaUpload.kind !== input.kind ||
            v.data.mediaUpload.caption !== input.caption
          )
            throw new ApiError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'Khóa gửi đã dùng cho tệp hoặc nội dung khác.',
            );
          return serializeMessage(old);
        }
        const current = await tx.conversation.findUniqueOrThrow({
          where: { id: conversationId },
        });
        const policy = channelSendPolicy(
          a,
          current,
          await personalWorkerOnline(tx),
        );
        if (!policy.allowed)
          throw new ApiError(
            409,
            policy.code ?? 'CHANNEL_NOT_CONNECTED',
            policy.message ?? 'Chưa thể gửi trong hội thoại này.',
          );
        if (
          type === 'ZALO_OA' &&
          (!conversation.connection ||
            (
              await tx.zaloConnection.findUnique({
                where: { id: conversation.connectionId! },
              })
            )?.status !== 'CONNECTED')
        )
          throw new ApiError(409, 'CHANNEL_NOT_CONNECTED', 'Kết nối lại OA.');
        if (
          (await tx.message.count({
            where: {
              channelAccountId: a.id,
              deliveryStatus: { in: ['PENDING', 'SENDING'] },
            },
          })) >= 20
        )
          throw new ApiError(
            429,
            'MEDIA_QUEUE_FULL',
            'Hàng đợi đang đầy. Chờ các tin trước được xử lý.',
          );
        const m = await tx.message.create({
          data: {
            channelAccountId: conversation.connectionId ? null : a.id,
            connectionId: conversation.connectionId,
            conversationId,
            externalSenderId: a.externalAccountId,
            source:
              type === 'ZALO_PERSONAL'
                ? 'PERSONAL'
                : type === 'ZALO_OA'
                  ? 'WEBHOOK'
                  : type === 'FACEBOOK_PAGE'
                    ? 'FACEBOOK'
                    : 'TELEGRAM',
            direction: 'OUTGOING',
            type: input.kind === 'document' ? 'file' : 'audio',
            content: input.caption,
            sentAt: new Date(),
            deliveryStatus: 'PENDING',
            idempotencyKey: input.idempotencyKey,
            metadata: {
              attachments: [
                {
                  type: input.kind === 'document' ? 'file' : 'audio',
                  payload: { name: upload.name, local: true },
                },
              ],
              mediaUpload: { ...upload, caption: input.caption },
            },
          },
        });
        await this.store.put(tx, m.id, {
          bytes: file.buffer,
          name: upload.name,
          mime: upload.mime,
          size: upload.size,
        });
        await tx.personalCommand.create({
          data: {
            channelAccountId: a.id,
            messageId: m.id,
            kind: 'SEND',
            generation: a.generation,
            deduplicationKey: 'send:' + m.id,
          },
        });
        await tx.conversation.update({
          where: { id: conversationId },
          data: {
            lastMessageAt: m.sentAt,
            lastMessagePreview: (
              input.caption ||
              `${input.kind === 'document' ? 'Tài liệu' : 'Âm thanh'}: ${upload.name}`
            ).slice(0, 280),
          },
        });
        await publishEvent(tx, ownerId, {
          type: 'message.created',
          channelAccountId: a.id,
          conversationId,
          messageId: m.id,
        });
        return serializeMessage(m);
      },
      { timeout: 20000 },
    );
  }
}
