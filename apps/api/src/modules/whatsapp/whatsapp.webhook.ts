import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { constantEquals, hash } from '../../common/crypto.service';
import { ApiError } from '../../common/api-error';
import { WhatsAppSettings } from './whatsapp.service';
import {
  waId,
  waJson,
  waMessageSchema,
  waStatusSchema,
} from './whatsapp.types';
export const waReceiptSchema = z.object({
  generation: z.number().int(),
  wabaId: waId,
  phoneId: waId,
  kind: z.enum(['message', 'status', 'account', 'template']),
  data: z.record(z.unknown()),
  contactName: z.string().max(1000).optional(),
});
@Injectable()
export class WhatsAppWebhook {
  constructor(
    readonly db: PrismaService,
    readonly settings: WhatsAppSettings,
  ) {}
  verify(query: Record<string, unknown>) {
    if (
      !this.settings.enabled ||
      !this.settings.config.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ||
      query['hub.mode'] !== 'subscribe' ||
      typeof query['hub.verify_token'] !== 'string' ||
      !constantEquals(
        query['hub.verify_token'],
        this.settings.config.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
      ) ||
      typeof query['hub.challenge'] !== 'string' ||
      query['hub.challenge'].length > 1000
    )
      throw new ApiError(
        403,
        'WHATSAPP_WEBHOOK_INVALID',
        'Webhook verification rejected.',
      );
    return query['hub.challenge'];
  }
  async receive(raw: Buffer | undefined, signature: string | undefined) {
    const secret = this.settings.config.env.WHATSAPP_META_APP_SECRET;
    if (
      !this.settings.enabled ||
      !secret ||
      !raw?.length ||
      raw.length > 1024 * 1024 ||
      !signature ||
      !/^sha256=[a-f0-9]{64}$/i.test(signature) ||
      !constantEquals(
        signature.toLowerCase(),
        'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'),
      )
    )
      throw new ApiError(
        401,
        'WHATSAPP_WEBHOOK_INVALID',
        'Webhook signature rejected.',
      );
    const schema = z.object({
      object: z.literal('whatsapp_business_account'),
      entry: z
        .array(
          z.object({
            id: waId,
            changes: z
              .array(
                z.object({
                  field: z.string().max(200),
                  value: z
                    .object({
                      messaging_product: z.literal('whatsapp').optional(),
                      metadata: z
                        .object({
                          phone_number_id: waId,
                          display_phone_number: z.string().optional(),
                        })
                        .optional(),
                      contacts: z
                        .array(
                          z.object({
                            wa_id: z.string().optional(),
                            profile: z
                              .object({ name: z.string().max(1000) })
                              .optional(),
                          }),
                        )
                        .max(100)
                        .optional(),
                      messages: z.array(waMessageSchema).max(100).optional(),
                      statuses: z.array(waStatusSchema).max(100).optional(),
                    })
                    .passthrough(),
                }),
              )
              .max(100),
          }),
        )
        .max(100),
    });
    let body: z.infer<typeof schema>;
    try {
      body = schema.parse(waJson.parse(raw.toString('utf8')));
    } catch {
      throw new ApiError(
        400,
        'WHATSAPP_WEBHOOK_INVALID',
        'Malformed WhatsApp webhook.',
      );
    }
    if (
      body.entry.reduce(
        (n, e) =>
          n +
          e.changes.reduce(
            (m, c) =>
              m +
              (c.value.messages?.length ?? 0) +
              (c.value.statuses?.length ?? 0) +
              1,
            0,
          ),
        0,
      ) > 1000
    )
      throw new ApiError(
        400,
        'WHATSAPP_WEBHOOK_INVALID',
        'Webhook batch too large.',
      );
    const rows: Prisma.WebhookEventCreateManyInput[] = [];
    for (const entry of body.entry)
      for (const change of entry.changes) {
        if (
          ![
            'messages',
            'account_update',
            'message_template_status_update',
          ].includes(change.field)
        )
          continue;
        const phoneId = change.value.metadata?.phone_number_id;
        const accounts = await this.db.channelAccount.findMany({
          where: {
            channelType: 'WHATSAPP_BUSINESS',
            connectionStatus: { not: 'DISCONNECTED' },
            ...(phoneId ? { externalAccountId: phoneId } : {}),
            providerMetadata: { path: ['wabaId'], equals: entry.id },
          },
        });
        for (const a of accounts) {
          const add = (
            kind: 'message' | 'status' | 'account' | 'template',
            data: Record<string, unknown>,
            key: string,
            name?: string,
          ) => {
            const payload = waReceiptSchema.parse({
              generation: a.generation,
              wabaId: entry.id,
              phoneId: a.externalAccountId,
              kind,
              data,
              contactName: name,
            });
            rows.push({
              channelAccountId: a.id,
              eventName: 'whatsapp.' + kind,
              digest: hash(`whatsapp:${a.id}:${kind}:${key}`),
              payload: JSON.parse(
                JSON.stringify(payload),
              ) as Prisma.InputJsonObject,
            });
          };
          if (change.field === 'messages') {
            if (!phoneId || change.value.messaging_product !== 'whatsapp')
              throw new ApiError(
                400,
                'WHATSAPP_WEBHOOK_INVALID',
                'Missing WhatsApp phone metadata.',
              );
            for (const m of change.value.messages ?? [])
              add(
                'message',
                m,
                m.id,
                change.value.contacts?.find((c) => c.wa_id === m.from)?.profile
                  ?.name,
              );
            for (const s of change.value.statuses ?? [])
              add(
                'status',
                s,
                [
                  s.id,
                  s.status,
                  s.timestamp,
                  JSON.stringify(s.errors ?? []),
                ].join(':'),
              );
          } else
            add(
              change.field === 'account_update' ? 'account' : 'template',
              change.value,
              hash(JSON.stringify(change.value)),
            );
        }
      }
    if (rows.length)
      await this.db.webhookEvent.createMany({
        data: rows,
        skipDuplicates: true,
      });
    return { accepted: rows.length };
  }
}
