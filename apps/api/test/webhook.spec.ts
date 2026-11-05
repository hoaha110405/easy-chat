import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import incoming from './fixtures/user-send-text.json';
import outgoing from './fixtures/oa-send-text.json';
import image from './fixtures/user-send-image.json';
import {
  normalizeWebhook,
  verifySignature,
  eventDate,
} from '../src/modules/zalo/zalo-webhook';
import { config } from './helpers';
describe('Zalo webhook protocol', () => {
  it('uses the exact raw body and concatenated SHA-256, with timing-safe hex comparison', () => {
    const raw = Buffer.from(JSON.stringify(incoming, null, 2));
    const signature = createHash('sha256')
      .update(incoming.app_id)
      .update(raw)
      .update(incoming.timestamp)
      .update(config.env.ZALO_OA_SECRET_KEY)
      .digest('hex');
    expect(() =>
      verifySignature(
        incoming.app_id,
        raw,
        incoming.timestamp,
        config.env.ZALO_OA_SECRET_KEY,
        `mac=${signature}`,
      ),
    ).not.toThrow();
    expect(() =>
      verifySignature(
        incoming.app_id,
        Buffer.from(JSON.stringify(incoming)),
        incoming.timestamp,
        config.env.ZALO_OA_SECRET_KEY,
        signature,
      ),
    ).toThrow();
    for (const invalid of [undefined, 'garbage', 'a'.repeat(64), ''])
      expect(() =>
        verifySignature(
          incoming.app_id,
          raw,
          incoming.timestamp,
          config.env.ZALO_OA_SECRET_KEY,
          invalid,
        ),
      ).toThrow();
  });
  it('normalizes incoming and outgoing participants without losing ID precision', () => {
    expect(normalizeWebhook(incoming)).toMatchObject({
      oaId: incoming.recipient.id,
      userId: incoming.sender.id,
      direction: 'INCOMING',
      externalMessageId: incoming.message.msg_id,
      source: 'WEBHOOK',
    });
    expect(normalizeWebhook(outgoing)).toMatchObject({
      oaId: outgoing.sender.id,
      userId: outgoing.recipient.id,
      direction: 'OUTGOING',
    });
    expect(() =>
      normalizeWebhook({
        ...incoming,
        sender: { id: Number(incoming.sender.id) },
      }),
    ).toThrow();
  });
  it('retains image and file attachment metadata and handles unknown message types', () => {
    expect(normalizeWebhook(image).metadata.attachments).toEqual(
      image.message.attachments,
    );
    expect(
      normalizeWebhook({
        ...image,
        event_name: 'user_send_file',
        message: {
          msg_id: 'file-1',
          attachments: [
            {
              type: 'file',
              payload: {
                url: 'https://example.com/test.pdf',
                name: 'test.pdf',
                size: '42',
              },
            },
          ],
        },
      }),
    ).toMatchObject({
      type: 'file',
      metadata: {
        attachments: [{ type: 'file', payload: { name: 'test.pdf' } }],
      },
    });
    expect(
      normalizeWebhook({ ...incoming, event_name: 'user_send_future_type' })
        .type,
    ).toBe('future_type');
  });
  it('rejects missing text, missing message IDs and future or invalid timestamps', () => {
    expect(() =>
      normalizeWebhook({ ...incoming, message: { text: 'no ID' } }),
    ).toThrow();
    expect(() =>
      normalizeWebhook({ ...incoming, message: { msg_id: 'no-text' } }),
    ).toThrow();
    expect(() => eventDate('154390853474')).toThrow();
    expect(() => eventDate(String(Date.now() + 6 * 60 * 1000))).toThrow();
    expect(eventDate(incoming.timestamp).getTime()).toBe(
      Number(incoming.timestamp),
    );
  });
});
