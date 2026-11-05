import { Injectable } from '@nestjs/common';
import type {
  Conversation,
  ChannelAccount,
  ZaloConnection,
  Message,
  Prisma,
} from '@prisma/client';
import type {
  Pagination,
  ConversationFilter,
  InboxMessage,
  InboxAccount,
} from '@zalo/shared';
import { z } from 'zod';
import { channelSendPolicy } from '../messaging/channel-policy';
import { PrismaService } from '../../database/prisma.service';
import { personalWorkerOnline } from '../zalo-personal/personal-runtime';
import { ADMIN_OWNER_ID } from '../auth/auth.service';
import { ApiError } from '../../common/api-error';
const attachmentsSchema = z
  .object({
    attachments: z
      .array(
        z
          .object({
            type: z.string(),
            payload: z
              .object({
                url: z.string().optional(),
                name: z.string().optional(),
                previewUrl: z.string().optional(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
const accountSelect = {
  channelType: true,
  name: true,
  avatarUrl: true,
  externalAccountId: true,
  connectionStatus: true,
} as const;
const connectionSelect = { oaName: true, avatarUrl: true, oaId: true } as const;
export function serializeMessage(message: Message): InboxMessage {
  const parsed = attachmentsSchema.safeParse(message.metadata);
  return {
    id: message.id,
    externalMessageId: message.externalMessageId,
    deliveryStatus: message.deliveryStatus,
    deliveryError: message.deliveryError,
    idempotencyKey: message.idempotencyKey,
    direction: message.direction,
    type: message.type,
    content: message.content,
    sentAt: message.sentAt.toISOString(),
    source: message.source,
    deliveredAt: message.deliveredAt?.toISOString() ?? null,
    readAt: message.readAt?.toISOString() ?? null,
    attachments: parsed.success
      ? (parsed.data.attachments ?? []).map((a) => ({
          type: a.type,
          url: a.payload.url ?? null,
          name: a.payload.name ?? null,
          previewUrl: a.payload.previewUrl ?? null,
        }))
      : [],
  };
}
@Injectable()
export class InboxService {
  constructor(private readonly db: PrismaService) {}
  private encodeCursor(at: Date | null, id: string) {
    return Buffer.from(
      JSON.stringify({ at: at?.toISOString() ?? null, id }),
    ).toString('base64url');
  }
  private decodeCursor(
    cursor?: string,
  ): { at: string | null; id: string } | null {
    if (!cursor) return null;
    try {
      return z
        .object({ at: z.string().datetime().nullable(), id: z.string().cuid() })
        .strict()
        .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    } catch {
      throw new ApiError(400, 'INVALID_CURSOR', 'Invalid pagination cursor.');
    }
  }
  async accounts(ownerId = ADMIN_OWNER_ID) {
    const [personal, oa, online] = await Promise.all([
      this.db.channelAccount.findMany({
        where: { ownerId },
        select: {
          id: true,
          ...accountSelect,
          _count: { select: { conversations: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.db.zaloConnection.findMany({
        where: ownerId === ADMIN_OWNER_ID ? {} : { id: { in: [] } },
        select: {
          id: true,
          ...connectionSelect,
          status: true,
          _count: { select: { conversations: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      personalWorkerOnline(this.db),
    ]);
    const accounts: InboxAccount[] = [
      ...personal.map((a) => ({
        key: `${a.channelType === 'FACEBOOK_PAGE' ? 'facebook-page' : a.channelType === 'FACEBOOK_PERSONAL' ? 'facebook-personal' : 'personal'}:${a.id}`,
        id: a.id,
        channelType: a.channelType as InboxAccount['channelType'],
        name: a.name,
        avatarUrl: a.avatarUrl,
        externalAccountId: a.externalAccountId,
        status:
          !online && a.connectionStatus === 'CONNECTED'
            ? 'RECONNECTING'
            : a.connectionStatus,
        conversationCount: a._count.conversations,
      })),
      ...oa.map((a) => ({
        key: `oa:${a.id}`,
        id: a.id,
        channelType: 'ZALO_OA' as const,
        name: a.oaName,
        avatarUrl: a.avatarUrl,
        externalAccountId: a.oaId,
        status: a.status,
        conversationCount: a._count.conversations,
      })),
    ];
    return { accounts };
  }
  private whereOwner(ownerId: string): Prisma.ConversationWhereInput {
    return {
      OR: [
        ...(ownerId === ADMIN_OWNER_ID
          ? [{ connectionId: { not: null } }]
          : []),
        { channelAccount: { ownerId } },
      ],
    };
  }
  private serialize(
    conversation: Conversation & {
      channelAccount: Pick<
        ChannelAccount,
        | 'name'
        | 'avatarUrl'
        | 'externalAccountId'
        | 'connectionStatus'
        | 'channelType'
      > | null;
      connection: Pick<ZaloConnection, 'oaName' | 'avatarUrl' | 'oaId'> | null;
    },
    online: boolean,
  ) {
    return {
      ...conversation,
      channelAccount: undefined,
      connection: undefined,
      channelType: conversation.channelAccount?.channelType ?? 'ZALO_OA',
      sendBlockedReason: conversation.channelAccount
        ? channelSendPolicy(conversation.channelAccount, conversation, online)
            .code
        : 'Kênh này chỉ hỗ trợ xem lịch sử.',
      messagingWindowExpiresAt: conversation.channelAccount
        ? (channelSendPolicy(
            conversation.channelAccount,
            conversation,
            online,
          ).expiresAt?.toISOString() ?? null)
        : null,
      accountName:
        conversation.channelAccount?.name ??
        conversation.connection?.oaName ??
        'Zalo',
      accountAvatar:
        conversation.channelAccount?.avatarUrl ??
        conversation.connection?.avatarUrl ??
        null,
      accountExternalId:
        conversation.channelAccount?.externalAccountId ??
        conversation.connection?.oaId ??
        null,
      canSend: conversation.channelAccount
        ? channelSendPolicy(conversation.channelAccount, conversation, online)
            .allowed
        : false,
    };
  }
  async conversation(id: string, ownerId = ADMIN_OWNER_ID) {
    const item = await this.db.conversation.findFirst({
      where: { id, ...this.whereOwner(ownerId) },
      include: {
        channelAccount: { select: accountSelect },
        connection: { select: connectionSelect },
      },
    });
    if (!item)
      throw new ApiError(
        404,
        'CONVERSATION_NOT_FOUND',
        'Conversation not found.',
      );
    return this.serialize(item, await personalWorkerOnline(this.db));
  }
  async conversations(
    { page, limit, account, channelType, cursor }: ConversationFilter,
    ownerId = ADMIN_OWNER_ID,
  ) {
    const online = await personalWorkerOnline(this.db);
    const position = this.decodeCursor(cursor);
    const filters: Prisma.ConversationWhereInput[] = [this.whereOwner(ownerId)];
    if (channelType)
      filters.push(
        channelType === 'ZALO_OA'
          ? { connectionId: { not: null } }
          : { channelAccount: { channelType } },
      );
    if (account) {
      const [prefix, id] = account.split(':');
      filters.push(
        prefix === 'oa'
          ? { connectionId: id }
          : {
              channelAccountId: id,
              channelAccount: {
                channelType:
                  prefix === 'personal'
                    ? 'ZALO_PERSONAL'
                    : prefix === 'facebook-page'
                      ? 'FACEBOOK_PAGE'
                      : 'FACEBOOK_PERSONAL',
              },
            },
      );
    }
    if (position)
      filters.push(
        position.at === null
          ? { lastMessageAt: null, id: { lt: position.id } }
          : {
              OR: [
                { lastMessageAt: { lt: new Date(position.at) } },
                {
                  lastMessageAt: new Date(position.at),
                  id: { lt: position.id },
                },
                { lastMessageAt: null },
              ],
            },
      );
    const items = await this.db.conversation.findMany({
      where: { AND: filters },
      include: {
        channelAccount: { select: accountSelect },
        connection: { select: connectionSelect },
      },
      orderBy: [
        { lastMessageAt: { sort: 'desc', nulls: 'last' } },
        { id: 'desc' },
      ],
      skip: cursor ? 0 : (page - 1) * limit,
      take: limit + 1,
    });
    return {
      items: items.slice(0, limit).map((item) => this.serialize(item, online)),
      page,
      limit,
      hasMore: items.length > limit,
      nextCursor:
        items.length > limit
          ? this.encodeCursor(
              items[limit - 1].lastMessageAt,
              items[limit - 1].id,
            )
          : null,
    };
  }
  async messages(
    id: string,
    { page, limit, cursor }: Pagination,
    ownerId = ADMIN_OWNER_ID,
  ) {
    if (
      !(await this.db.conversation.findFirst({
        where: { id, ...this.whereOwner(ownerId) },
        select: { id: true },
      }))
    )
      throw new ApiError(
        404,
        'CONVERSATION_NOT_FOUND',
        'Conversation not found.',
      );
    const position = this.decodeCursor(cursor);
    if (position?.at === null)
      throw new ApiError(400, 'INVALID_CURSOR', 'Invalid message cursor.');
    const items = await this.db.message.findMany({
      where: {
        conversationId: id,
        ...(position
          ? {
              OR: [
                { sentAt: { lt: new Date(position.at!) } },
                { sentAt: new Date(position.at!), id: { lt: position.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
      skip: cursor ? 0 : (page - 1) * limit,
      take: limit + 1,
    });
    return {
      items: items.slice(0, limit).map(serializeMessage),
      page,
      limit,
      hasMore: items.length > limit,
      nextCursor:
        items.length > limit
          ? this.encodeCursor(items[limit - 1].sentAt, items[limit - 1].id)
          : null,
    };
  }
}
