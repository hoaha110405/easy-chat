import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { RawBodyRequest } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../src/database/prisma.service';
import type { ConfigService } from '../src/config/config.service';
import { FacebookWebhookController } from '../src/modules/facebook-page/facebook-webhook.controller';
import { FacebookWebhookService } from '../src/modules/facebook-page/facebook-webhook.service';
import {
  FACEBOOK_WEBHOOK_MAX_BYTES,
  facebookWebhookDigest,
  parseFacebookWebhook,
  verifyFacebookWebhookSignature,
  type FacebookWebhookPayload,
} from '../src/modules/facebook-page/facebook-webhook';

const PAGE = '90071992547409931234';
const PERSON = '90071992547409935678';
const WHEN = Math.floor(Date.now() / 1000) * 1000 - 30000;
const APP_SECRET = 'fixture-facebook-app-secret';
const VERIFY_TOKEN = 'fixture-facebook-verification-token';

function envelope(events: unknown[] = [message()]) {
  return {
    object: 'page',
    entry: [{ id: PAGE, time: Date.now(), messaging: events }],
  };
}
function message() {
  return {
    sender: { id: PERSON },
    recipient: { id: PAGE },
    timestamp: WHEN,
    message: { mid: 'm_fixture', text: 'Xin chào' },
  };
}
function raw(value: unknown) {
  return Buffer.from(JSON.stringify(value));
}
function sign(value: Buffer, secret = APP_SECRET) {
  return `sha256=${createHmac('sha256', secret).update(value).digest('hex')}`;
}
function setup() {
  const digests = new Set<string>();
  const rows: Prisma.WebhookEventCreateManyInput[] = [];
  const tx = {
    channelAccount: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: 'account-one', externalAccountId: PAGE }]),
    },
    webhookEvent: {
      createMany: vi
        .fn()
        .mockImplementation(
          async (input: { data: Prisma.WebhookEventCreateManyInput[] }) => {
            let count = 0;
            for (const value of input.data) {
              if (digests.has(value.digest)) continue;
              digests.add(value.digest);
              rows.push(value);
              count++;
            }
            return { count };
          },
        ),
    },
  };
  const db = {
    $transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)),
  };
  const config = {
    env: {
      FACEBOOK_APP_SECRET: APP_SECRET,
      FACEBOOK_VERIFY_TOKEN: VERIFY_TOKEN,
    },
  } as ConfigService;
  return {
    tx,
    db,
    rows,
    config,
    service: new FacebookWebhookService(db as unknown as PrismaService, config),
  };
}

describe('Facebook Page webhook verification and durable intake', () => {
  it('returns the exact plain-text challenge only for a matching verify token', () => {
    const { service } = setup();
    const challenge = '000197642538';
    expect(service.verify('subscribe', VERIFY_TOKEN, challenge)).toBe(
      challenge,
    );
    for (const [mode, token] of [
      ['subscribe', 'wrong-token'],
      ['unsubscribe', VERIFY_TOKEN],
      ['subscribe', [VERIFY_TOKEN]],
    ]) {
      expect(() => service.verify(mode, token, challenge)).toThrowError(
        expect.objectContaining({ code: 'INVALID_FACEBOOK_VERIFY_TOKEN' }),
      );
    }
    expect(() => service.verify('subscribe', VERIFY_TOKEN, '')).toThrowError(
      expect.objectContaining({ code: 'INVALID_FACEBOOK_WEBHOOK_CHALLENGE' }),
    );
    const response = {
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };
    new FacebookWebhookController(service).verify(
      'subscribe',
      VERIFY_TOKEN,
      challenge,
      response as unknown as Response,
    );
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.type).toHaveBeenCalledWith('text/plain');
    expect(response.send).toHaveBeenCalledWith(challenge);
  });

  it('fails closed when webhook secrets are not configured', async () => {
    const { config, service, db } = setup();
    config.env.FACEBOOK_VERIFY_TOKEN = '';
    expect(() => service.verify('subscribe', '', '123')).toThrowError(
      expect.objectContaining({ code: 'FACEBOOK_PAGE_NOT_CONFIGURED' }),
    );
    config.env.FACEBOOK_APP_SECRET = '';
    await expect(service.receive(raw(envelope()))).rejects.toMatchObject({
      code: 'FACEBOOK_PAGE_NOT_CONFIGURED',
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('checks HMAC SHA256 over exact raw bytes before parsing or writing', async () => {
    const { service, db } = setup();
    const body = raw(envelope());
    for (const signature of [
      undefined,
      'sha256=00',
      'sha1=' + 'a'.repeat(40),
      'sha256=' + 'g'.repeat(64),
      sign(body, 'wrong-secret'),
    ]) {
      await expect(service.receive(body, signature)).rejects.toMatchObject({
        code: 'INVALID_FACEBOOK_WEBHOOK_SIGNATURE',
      });
    }
    const changed = Buffer.from(
      body.toString('utf8').replace('Xin chào', 'Changed'),
    );
    await expect(service.receive(changed, sign(body))).rejects.toMatchObject({
      code: 'INVALID_FACEBOOK_WEBHOOK_SIGNATURE',
    });
    // A signed body with different whitespace and escaped unicode is valid;
    // reserializing JSON before HMAC verification would reject this request.
    const spaced = Buffer.from(
      JSON.stringify(envelope(), null, 2).replace('chào', 'ch\\u00e0o'),
    );
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(await service.receive(spaced, sign(spaced))).toMatchObject({
      accepted: 1,
    });
    expect(() =>
      verifyFacebookWebhookSignature(body, '', sign(body, '')),
    ).toThrow();
  });

  it('persists only whitelisted event fields for connected Page accounts', async () => {
    const { service, rows, tx } = setup();
    const body = raw(
      envelope([
        {
          ...message(),
          unknownSecret: 'never-persist-this-secret',
          sender: { id: PERSON, access_token: 'never-persist-this-secret' },
          message: {
            ...message().message,
            app_id: 'omit-unneeded-id',
            metadata: 'never-persist-this-secret',
            attachments: [
              {
                type: 'image',
                payload: {
                  url: 'https://cdn.example.test/image.jpg',
                  token: 'never-persist-this-secret',
                },
              },
              { type: 'file', payload: { url: 'javascript:alert(1)' } },
              {
                type: 'image',
                payload: { url: 'https://user:password@cdn.example.test/a' },
              },
            ],
          },
        },
      ]),
    );
    expect(await service.receive(body, sign(body))).toEqual({
      received: true,
      accepted: 1,
      ignored: 0,
    });
    expect(tx.channelAccount.findMany).toHaveBeenCalledWith({
      where: {
        channelType: 'FACEBOOK_PAGE',
        connectionStatus: 'CONNECTED',
        externalAccountId: { in: [PAGE] },
      },
      select: { id: true, externalAccountId: true },
    });
    expect(rows[0]).toMatchObject({
      channelAccountId: 'account-one',
      eventName: 'facebook.page',
      payload: {
        pageId: PAGE,
        event: {
          sender: { id: PERSON },
          recipient: { id: PAGE },
          timestamp: WHEN,
          message: {
            mid: 'm_fixture',
            text: 'Xin chào',
            attachments: [
              {
                type: 'image',
                payload: { url: 'https://cdn.example.test/image.jpg' },
              },
              { type: 'file', payload: {} },
              { type: 'image', payload: {} },
            ],
          },
        },
      },
    });
    expect(JSON.stringify(rows)).not.toMatch(
      /never-persist|javascript:|password|omit-unneeded/,
    );
    expect(rows[0]).not.toHaveProperty('status'); // Database default RECEIVED.
    expect(tx.webhookEvent.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });

  it('deduplicates retries despite JSON key order, extra fields or entry delivery time', async () => {
    const { service, rows } = setup();
    const first = raw(envelope());
    const retry = raw({
      entry: [
        {
          messaging: [
            {
              message: {
                text: 'Xin chào',
                mid: 'm_fixture',
                metadata: 'ignored',
              },
              timestamp: WHEN,
              recipient: { id: PAGE },
              sender: { id: PERSON },
            },
          ],
          time: 1,
          id: PAGE,
        },
      ],
      object: 'page',
    });
    expect((await service.receive(first, sign(first))).accepted).toBe(1);
    expect((await service.receive(retry, sign(retry))).accepted).toBe(0);
    expect(rows).toHaveLength(1);
  });

  it('scopes deduplication by internal channel account rather than global PSID', async () => {
    const { service, rows, tx } = setup();
    tx.channelAccount.findMany.mockResolvedValue([
      { id: 'account-one', externalAccountId: PAGE },
      { id: 'account-two', externalAccountId: PAGE },
    ]);
    const body = raw(envelope());
    expect((await service.receive(body, sign(body))).accepted).toBe(2);
    expect(rows[0].digest).not.toBe(rows[1].digest);
    expect(rows.map((value) => value.channelAccountId)).toEqual([
      'account-one',
      'account-two',
    ]);
    const payload = rows[0].payload as unknown as FacebookWebhookPayload;
    expect(facebookWebhookDigest('account-one', payload)).toBe(rows[0].digest);
  });

  it('normalizes echoes, delivery, read and postback with original platform times', () => {
    const result = parseFacebookWebhook(
      raw(
        envelope([
          {
            sender: { id: PAGE },
            recipient: { id: PERSON },
            timestamp: WHEN,
            message: { mid: 'echo_1', is_echo: true, text: 'From Page' },
          },
          {
            sender: { id: PERSON },
            recipient: { id: PAGE },
            delivery: { mids: ['echo_1'], watermark: String(WHEN) },
          },
          {
            sender: { id: PERSON },
            recipient: { id: PAGE },
            read: { watermark: WHEN },
          },
          {
            sender: { id: PERSON },
            recipient: { id: PAGE },
            timestamp: String(WHEN),
            postback: {
              mid: 'postback_1',
              payload: 'GET_STARTED',
              title: 'Begin',
            },
          },
        ]),
      ),
    );
    expect(result.events).toHaveLength(4);
    expect(result.events.every((value) => value.event.timestamp === WHEN)).toBe(
      true,
    );
    expect(result.events[0].event.message?.is_echo).toBe(true);
    expect(result.events[1].event.delivery).toEqual({
      mids: ['echo_1'],
      watermark: WHEN,
    });
    expect(result.events[2].event.read).toEqual({ watermark: WHEN });
    expect(result.events[3].event.postback?.payload).toBe('GET_STARTED');
  });

  it('accepts old retried messages without replacing their time with entry delivery time', () => {
    const old = Date.UTC(2020, 0, 1);
    const result = parseFacebookWebhook(
      raw(envelope([{ ...message(), timestamp: old }])),
    );
    expect(result.events[0].event.timestamp).toBe(old);
  });

  it('rejects malformed, ambiguous, future, unsafe numeric-ID or misrouted supported events', async () => {
    const { service, db } = setup();
    const invalid = [
      { object: 'instagram', entry: [] },
      envelope([{ ...message(), sender: { id: Number(PERSON) } }]),
      envelope([{ ...message(), timestamp: Date.now() + 10 * 60 * 1000 }]),
      envelope([{ ...message(), timestamp: undefined }]),
      envelope([{ ...message(), recipient: { id: '1234' } }]),
      envelope([{ ...message(), message: { mid: 'bad_echo', is_echo: true } }]),
      envelope([{ ...message(), read: { watermark: WHEN } }]),
      envelope([{ ...message(), message: undefined, delivery: {} }]),
    ];
    for (const value of invalid) {
      const body = raw(value);
      await expect(service.receive(body, sign(body))).rejects.toMatchObject({
        code: 'INVALID_FACEBOOK_WEBHOOK_PAYLOAD',
      });
    }
    const broken = Buffer.from('{"object":"page"');
    await expect(service.receive(broken, sign(broken))).rejects.toMatchObject({
      code: 'INVALID_FACEBOOK_WEBHOOK_PAYLOAD',
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('bounds raw payloads, per-entry events and total events across entries', async () => {
    const { service, db } = setup();
    const large = Buffer.alloc(FACEBOOK_WEBHOOK_MAX_BYTES + 1);
    await expect(service.receive(large, sign(large))).rejects.toMatchObject({
      code: 'INVALID_FACEBOOK_WEBHOOK_PAYLOAD',
    });
    for (const body of [
      raw(envelope(Array.from({ length: 1001 }, message))),
      raw({
        object: 'page',
        entry: Array.from({ length: 2 }, () => ({
          id: PAGE,
          messaging: Array.from({ length: 501 }, message),
        })),
      }),
    ]) {
      await expect(service.receive(body, sign(body))).rejects.toMatchObject({
        code: 'INVALID_FACEBOOK_WEBHOOK_PAYLOAD',
      });
    }
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('acknowledges irrelevant event types and unconnected Pages without fake receipts', async () => {
    const { service, tx, rows } = setup();
    tx.channelAccount.findMany.mockResolvedValue([]);
    const body = raw(
      envelope([message(), { optin: { ref: 'ignore unsupported event' } }]),
    );
    expect(await service.receive(body, sign(body))).toEqual({
      received: true,
      accepted: 0,
      ignored: 2,
    });
    expect(rows).toEqual([]);
    expect(tx.webhookEvent.createMany).not.toHaveBeenCalled();
  });

  it('never acknowledges before transaction commit and propagates failed persistence', async () => {
    const { service, db, tx } = setup();
    let releaseCommit!: () => void;
    const commit = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    db.$transaction.mockImplementationOnce(async (fn) => {
      const result = await fn(tx);
      await commit;
      return result;
    });
    const body = raw(envelope());
    let acknowledged = false;
    const pending = service.receive(body, sign(body)).then(() => {
      acknowledged = true;
    });
    await vi.waitFor(() =>
      expect(tx.webhookEvent.createMany).toHaveBeenCalled(),
    );
    expect(acknowledged).toBe(false);
    releaseCommit();
    await pending;
    expect(acknowledged).toBe(true);
    db.$transaction.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.receive(body, sign(body))).rejects.toThrow(
      'database unavailable',
    );
  });

  it('requires captured raw JSON bytes in the controller', async () => {
    const { service } = setup();
    const receive = vi.spyOn(service, 'receive');
    const controller = new FacebookWebhookController(service);
    await expect(
      controller.receive({} as RawBodyRequest<Request>),
    ).rejects.toMatchObject({ code: 'RAW_BODY_REQUIRED' });
    expect(receive).not.toHaveBeenCalled();
    const body = raw(envelope());
    expect(
      await controller.receive(
        { rawBody: body } as RawBodyRequest<Request>,
        sign(body),
      ),
    ).toEqual({ data: { received: true, accepted: 1, ignored: 0 } });
  });
});
