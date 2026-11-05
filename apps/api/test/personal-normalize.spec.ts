import { describe, it, expect } from 'vitest';
import {
  normalizePersonalMessage,
  personalExternalId,
} from '../src/modules/zalo-personal/personal-normalize';
const incoming = {
  type: 0,
  threadId: '900719925474099301',
  isSelf: false,
  data: {
    msgId: '900719925474099399',
    uidFrom: '900719925474099301',
    idTo: '900719925474099302',
    dName: 'Fixture contact',
    ts: String(Date.now()),
    msgType: 'webchat',
    content: 'Personal text fixture',
  },
};
describe('personal message normalization', () => {
  it('retains long string IDs and normalizes one-to-one messages', () => {
    expect(
      normalizePersonalMessage(incoming, incoming.data.idTo),
    ).toMatchObject({
      externalThreadId: incoming.threadId,
      externalMessageId: incoming.data.msgId,
      direction: 'INCOMING',
      content: incoming.data.content,
      customerName: 'Fixture contact',
    });
  });
  it('normalizes self-sent messages from another device', () => {
    const event = {
      ...incoming,
      isSelf: true,
      data: {
        ...incoming.data,
        uidFrom: incoming.data.idTo,
        idTo: incoming.threadId,
      },
    };
    expect(normalizePersonalMessage(event, incoming.data.idTo)).toMatchObject({
      direction: 'OUTGOING',
      externalSenderId: incoming.data.idTo,
    });
  });
  it('ignores groups and retains a safe placeholder for unsupported content', () => {
    expect(
      normalizePersonalMessage({ ...incoming, type: 1 }, incoming.data.idTo),
    ).toBeNull();
    expect(
      normalizePersonalMessage(
        {
          ...incoming,
          data: {
            ...incoming.data,
            content: { href: 'https://example.com/private' },
          },
        },
        incoming.data.idTo,
      ),
    ).toMatchObject({ type: 'unsupported', content: '' });
  });
  it('rejects rounded IDs, wrong participants and impossible timestamps', () => {
    expect(
      personalExternalId.safeParse(Number(incoming.data.msgId)).success,
    ).toBe(false);
    expect(
      personalExternalId.parse({ toFixed: () => incoming.data.msgId }),
    ).toBe(incoming.data.msgId);
    expect(() =>
      normalizePersonalMessage(
        { ...incoming, threadId: '123' },
        incoming.data.idTo,
      ),
    ).toThrow();
    expect(() =>
      normalizePersonalMessage(
        { ...incoming, data: { ...incoming.data, ts: '1' } },
        incoming.data.idTo,
      ),
    ).toThrow();
  });
  it('retains image URLs, previews and captions while discarding unrelated payload fields', () => {
    const normalized = normalizePersonalMessage(
      {
        ...incoming,
        data: {
          ...incoming.data,
          msgType: 'chat.photo',
          content: {
            href: 'https://example.com/normal.jpg',
            thumb: 'https://example.com/thumb.jpg',
            description: 'Photo caption',
            params: JSON.stringify({
              hdUrl: 'https://example.com/full.jpg',
              privateKey: 'discard-me',
            }),
            privateCookie: 'discard-me',
          },
        },
      },
      incoming.data.idTo,
    );
    expect(normalized).toMatchObject({
      type: 'image',
      content: 'Photo caption',
      attachments: [
        {
          type: 'image',
          payload: {
            url: 'https://example.com/full.jpg',
            previewUrl: 'https://example.com/thumb.jpg',
          },
        },
      ],
    });
    expect(JSON.stringify(normalized)).not.toContain('discard-me');
  });
  it('recognizes stickers with direct assets or an ID that can be resolved later', () => {
    const normalize = (content: unknown) =>
      normalizePersonalMessage(
        {
          ...incoming,
          data: { ...incoming.data, msgType: 'chat.sticker', content },
        },
        incoming.data.idTo,
      );
    expect(
      normalize({ id: '123', href: 'https://example.com/sticker.webp' }),
    ).toMatchObject({
      type: 'sticker',
      content: '',
      attachments: [
        {
          type: 'sticker',
          payload: { stickerId: 123, url: 'https://example.com/sticker.webp' },
        },
      ],
    });
    expect(normalize({ id: 123 })).toMatchObject({
      type: 'sticker',
      attachments: [{ type: 'sticker', payload: { stickerId: 123 } }],
    });
  });
  it('handles JSON media content and direct photo URLs without confusing text with media', () => {
    expect(
      normalizePersonalMessage(
        {
          ...incoming,
          data: {
            ...incoming.data,
            msgType: 'chat.gif',
            content: JSON.stringify({
              href: 'https://example.com/animated.gif',
            }),
          },
        },
        incoming.data.idTo,
      ),
    ).toMatchObject({
      type: 'gif',
      attachments: [
        { type: 'gif', payload: { url: 'https://example.com/animated.gif' } },
      ],
    });
    expect(
      normalizePersonalMessage(
        {
          ...incoming,
          data: {
            ...incoming.data,
            msgType: 'chat.photo',
            content: 'https://example.com/image.jpg',
          },
        },
        incoming.data.idTo,
      ),
    ).toMatchObject({
      type: 'image',
      attachments: [{ payload: { url: 'https://example.com/image.jpg' } }],
    });
    expect(
      normalizePersonalMessage(
        {
          ...incoming,
          data: { ...incoming.data, content: 'https://example.com/image.jpg' },
        },
        incoming.data.idTo,
      ),
    ).toMatchObject({
      type: 'text',
      content: 'https://example.com/image.jpg',
      attachments: [],
    });
  });
  it('rejects unsafe media URLs but keeps the message and safe thumbnail', () => {
    const normalized = normalizePersonalMessage(
      {
        ...incoming,
        data: {
          ...incoming.data,
          msgType: 'chat.photo',
          content: {
            href: 'javascript:alert(1)',
            hdUrl: 'data:image/png;base64,abc',
            thumb: 'https://example.com/thumb.jpg',
          },
        },
      },
      incoming.data.idTo,
    );
    expect(normalized).toMatchObject({
      type: 'image',
      attachments: [{ payload: { url: 'https://example.com/thumb.jpg' } }],
    });
    expect(JSON.stringify(normalized)).not.toMatch(/javascript:|data:image/);
  });
});
