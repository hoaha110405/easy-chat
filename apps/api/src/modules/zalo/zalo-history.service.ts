import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { MessageStore, type NormalizedMessage } from '../inbox/message-store';
import { ApiError } from '../../common/api-error';
import { ZaloApiClient } from './zalo-api.client';
import { eventDate } from './zalo-webhook';
@Injectable()
export class ZaloHistoryService {
  constructor(
    private readonly db: PrismaService,
    private readonly api: ZaloApiClient,
    private readonly messages: MessageStore,
  ) {}
  // Deliberately backend-only: one bounded page for a known, locally stored conversation.
  // No global discovery, unbounded loops, or automatic polling of Zalo's history API.
  async syncConversationPage(conversationId: string, offset = 0, count = 10) {
    const conversation = await this.db.conversation.findUnique({
      where: { id: conversationId },
      include: { connection: true },
    });
    if (!conversation || !conversation.connectionId || !conversation.connection)
      throw new ApiError(
        404,
        'CONVERSATION_NOT_FOUND',
        'Conversation not found.',
      );
    const connectionId = conversation.connectionId;
    const connection = conversation.connection;
    const items = await this.api.getHistory(
      connectionId,
      conversation.externalUserId,
      offset,
      count,
    );
    return this.db.$transaction(async (tx) => {
      let inserted = 0;
      for (const item of items) {
        const incoming = item.src === 1;
        if (
          (incoming ? item.from_id : item.to_id) !==
            conversation.externalUserId ||
          (incoming ? item.to_id : item.from_id) !== connection.oaId
        )
          throw new ApiError(
            502,
            'INVALID_HISTORY_PARTICIPANTS',
            'Zalo history contains unexpected participants.',
          );
        const type =
          (
            { photo: 'image', GIF: 'gif', voice: 'audio' } as Record<
              string,
              string
            >
          )[item.type] ?? item.type;
        const message: NormalizedMessage = {
          oaId: connection.oaId,
          userId: conversation.externalUserId,
          externalMessageId: item.message_id,
          direction: incoming ? 'INCOMING' : 'OUTGOING',
          type,
          content: item.message ?? '',
          sentAt: eventDate(String(item.time)),
          source: 'HISTORY',
          customerName: incoming
            ? item.from_display_name
            : item.to_display_name,
          customerAvatar: incoming ? item.from_avatar : item.to_avatar,
          metadata: {
            attachments: item.url ? [{ type, payload: { url: item.url } }] : [],
          },
        };
        const result = await this.messages.persist(tx, connectionId, message);
        if (!result.duplicate) inserted++;
      }
      return { inserted, received: items.length, offset, count };
    });
  }
}
