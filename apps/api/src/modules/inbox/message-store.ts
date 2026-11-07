import { Injectable } from '@nestjs/common';
import type { Prisma, MessageDirection, MessageSource } from '@prisma/client';
import type { NormalizedPersonalMessage } from '../zalo-personal/personal-normalize';
export type NormalizedMessage = {
  oaId: string;
  userId: string;
  externalMessageId: string;
  direction: MessageDirection;
  type: string;
  content: string;
  sentAt: Date;
  metadata: Prisma.InputJsonObject;
  source: MessageSource;
  customerName?: string;
  customerAvatar?: string;
  externalConversationId?: string;
  externalContactId?: string;
  externalThreadType?: string;
};
type ChannelReference = {
  kind: 'oa' | 'personal';
  id: string;
  threadType?: string;
};
@Injectable()
export class MessageStore {
  persistChannel(
    tx: Prisma.TransactionClient,
    channelAccountId: string,
    message: NormalizedMessage,
    externalSenderId: string,
  ) {
    return this.persistRecord(
      tx,
      {
        kind: 'personal',
        id: channelAccountId,
        threadType: message.externalThreadType ?? 'PAGE_PSID',
      },
      message,
      externalSenderId,
    );
  }
  persist(
    tx: Prisma.TransactionClient,
    connectionId: string,
    message: NormalizedMessage,
  ) {
    return this.persistRecord(tx, { kind: 'oa', id: connectionId }, message);
  }
  persistPersonal(
    tx: Prisma.TransactionClient,
    channelAccountId: string,
    message: NormalizedPersonalMessage,
  ) {
    return this.persistRecord(
      tx,
      { kind: 'personal', id: channelAccountId },
      {
        oaId: '',
        userId: message.externalThreadId,
        externalMessageId: message.externalMessageId,
        direction: message.direction,
        type: message.type,
        content: message.content,
        sentAt: new Date(message.sentAt),
        metadata: { attachments: message.attachments },
        source: 'PERSONAL',
        customerName: message.customerName,
      },
      message.externalSenderId,
    );
  }
  private async persistRecord(
    tx: Prisma.TransactionClient,
    channel: ChannelReference,
    message: NormalizedMessage,
    externalSenderId?: string,
  ) {
    const reference =
      channel.kind === 'oa'
        ? { connectionId: channel.id }
        : { channelAccountId: channel.id };
    await tx.conversation.createMany({
      data: [
        {
          ...reference,
          externalThreadType: channel.threadType ?? 'USER',
          externalUserId: message.userId,
          externalConversationId: message.externalConversationId,
          externalContactId: message.externalContactId,
          customerName: message.customerName,
          customerAvatar: message.customerAvatar,
        },
      ],
      skipDuplicates: true,
    });
    const conversation = await tx.conversation.findUniqueOrThrow({
      where:
        channel.kind === 'oa'
          ? {
              connectionId_externalUserId: {
                connectionId: channel.id,
                externalUserId: message.userId,
              },
            }
          : {
              channelAccountId_externalUserId_externalThreadType: {
                channelAccountId: channel.id,
                externalUserId: message.userId,
                externalThreadType: channel.threadType ?? 'USER',
              },
            },
    });
    if (
      message.customerName !== undefined ||
      message.customerAvatar !== undefined ||
      message.externalContactId !== undefined ||
      message.externalConversationId !== undefined
    )
      await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          customerName: message.customerName,
          customerAvatar: message.customerAvatar,
          externalConversationId: message.externalConversationId,
          externalContactId: message.externalContactId,
        },
      });
    const inserted = await tx.message.createMany({
      data: [
        {
          ...reference,
          conversationId: conversation.id,
          externalMessageId: message.externalMessageId,
          externalSenderId,
          direction: message.direction,
          inboxUnread: message.direction === 'INCOMING',
          type: message.type,
          content: message.content,
          metadata: message.metadata,
          source: message.source,
          sentAt: message.sentAt,
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count > 0)
      await tx.conversation.updateMany({
        where: {
          id: conversation.id,
          OR: [
            { lastMessageAt: null },
            { lastMessageAt: { lt: message.sentAt } },
          ],
        },
        data: {
          lastMessageAt: message.sentAt,
          lastMessagePreview: (message.content || `[${message.type}]`).slice(
            0,
            280,
          ),
        },
      });
    if (
      channel.kind === 'oa' &&
      inserted.count > 0 &&
      message.direction === 'INCOMING'
    )
      await tx.conversation.updateMany({
        where: {
          id: conversation.id,
          OR: [
            { lastInboundAt: null },
            { lastInboundAt: { lt: message.sentAt } },
          ],
        },
        data: { lastInboundAt: message.sentAt },
      });
    // Only a real inbound message opens the Page reply window. Echoes and receipts never do.
    if (
      inserted.count > 0 &&
      [
        'PAGE_PSID',
        'TIKTOK_BUSINESS',
        'TIKTOK_SHOP',
        'TELEGRAM_BOT',
        'TELEGRAM_PERSONAL',
      ].includes(channel.threadType ?? '') &&
      message.direction === 'INCOMING' &&
      message.sentAt.getTime() <= Date.now() + 60000
    )
      await tx.conversation.updateMany({
        where: {
          id: conversation.id,
          OR: [
            { lastInboundAt: null },
            { lastInboundAt: { lt: message.sentAt } },
          ],
        },
        data: { lastInboundAt: message.sentAt },
      });
    const saved = await tx.message.findUniqueOrThrow({
      where:
        channel.kind === 'oa'
          ? {
              connectionId_externalMessageId: {
                connectionId: channel.id,
                externalMessageId: message.externalMessageId,
              },
            }
          : {
              channelAccountId_externalMessageId: {
                channelAccountId: channel.id,
                externalMessageId: message.externalMessageId,
              },
            },
    });
    if (saved.conversationId !== conversation.id)
      throw new Error('EXTERNAL_MESSAGE_ID_COLLISION');
    return {
      conversationId: conversation.id,
      messageId: saved.id,
      duplicate: inserted.count === 0,
    };
  }
}
