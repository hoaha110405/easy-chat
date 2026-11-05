import { createHmac } from 'node:crypto';
import { AxiosError, type AxiosRequestConfig } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import {
  FacebookGraphClient,
  FacebookGraphError,
} from '../src/modules/facebook-page/facebook-graph.client';

const config = {
  appId: '123456',
  appSecret: 'test-app-secret',
  graphVersion: 'v26.0',
};
const pageId = '9007199254740993123';
const psid = '9007199254740993456';
const pageToken = 'test-page-access-token';

function setup(data: unknown = { data: [] }, status = 200) {
  const request = vi
    .fn<
      (config: AxiosRequestConfig) => Promise<{ data: unknown; status: number }>
    >()
    .mockResolvedValue({ data, status });
  return { client: new FacebookGraphClient(config, { request }), request };
}

describe('Facebook Graph infrastructure contracts', () => {
  it('exchanges a real OAuth code and long-lived token using the configured application', async () => {
    const { client, request } = setup({
      access_token: 'user-token',
      expires_in: 3600,
      token_type: 'bearer',
    });
    expect(
      await client.exchangeCode(
        'oauth-code',
        'https://easychat.example/api/facebook-page/callback',
      ),
    ).toEqual({
      accessToken: 'user-token',
      expiresIn: 3600,
      tokenType: 'bearer',
    });
    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'GET',
      url: 'https://graph.facebook.com/v26.0/oauth/access_token',
      params: {
        client_id: config.appId,
        client_secret: config.appSecret,
        code: 'oauth-code',
        redirect_uri: 'https://easychat.example/api/facebook-page/callback',
      },
      timeout: 10000,
      maxRedirects: 0,
      maxContentLength: 2 * 1024 * 1024,
      proxy: false,
    });
    expect(request.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    await client.exchangeLongLivedToken('user-token');
    expect(request.mock.calls[1][0].params).toMatchObject({
      grant_type: 'fb_exchange_token',
      fb_exchange_token: 'user-token',
    });
  });

  it('lists managed Pages with exact string IDs, backend-only Page tokens and task grants', async () => {
    const { client, request } = setup({
      data: [
        {
          id: pageId,
          name: 'Support Page',
          access_token: pageToken,
          tasks: ['MESSAGING', 'MANAGE'],
          picture: {
            data: { url: 'https://platform-lookaside.fbsbx.com/picture.jpg' },
          },
        },
      ],
      paging: {
        cursors: { after: 'opaque-after-cursor' },
        next: 'https://attacker.example/?access_token=secret',
      },
    });
    expect(await client.listPages('user-token', { limit: 25 })).toEqual({
      items: [
        {
          id: pageId,
          name: 'Support Page',
          accessToken: pageToken,
          tasks: ['MESSAGING', 'MANAGE'],
          avatarUrl: 'https://platform-lookaside.fbsbx.com/picture.jpg',
        },
      ],
      after: 'opaque-after-cursor',
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toMatchObject({
      url: 'https://graph.facebook.com/v26.0/me/accounts',
      headers: { Authorization: 'Bearer user-token' },
      params: {
        fields: 'id,name,access_token,tasks,picture{url}',
        limit: 25,
        appsecret_proof: createHmac('sha256', config.appSecret)
          .update('user-token')
          .digest('hex'),
      },
    });
    expect(request.mock.calls[0][0].params).not.toHaveProperty('access_token');
  });

  it('retains declined scopes and inspects token app identity, target Pages and expiry', async () => {
    const { client, request } = setup({
      data: [
        { permission: 'pages_messaging', status: 'declined' },
        { permission: 'pages_show_list', status: 'granted' },
      ],
    });
    expect(await client.grantedPermissions('user-token')).toContainEqual({
      permission: 'pages_messaging',
      status: 'declined',
    });
    request.mockResolvedValueOnce({
      status: 200,
      data: {
        data: {
          app_id: config.appId,
          is_valid: true,
          type: 'PAGE',
          profile_id: pageId,
          expires_at: 0,
          scopes: ['pages_messaging'],
          granular_scopes: [{ scope: 'pages_messaging', target_ids: [pageId] }],
        },
      },
    });
    expect(await client.inspectToken(pageToken)).toMatchObject({
      appId: config.appId,
      valid: true,
      profileId: pageId,
      expiresAt: 0,
      scopes: ['pages_messaging'],
      granularScopes: [{ scope: 'pages_messaging', targetIds: [pageId] }],
    });
    expect(request.mock.calls[1][0]).toMatchObject({
      url: 'https://graph.facebook.com/v26.0/debug_token',
      params: { input_token: pageToken },
      headers: { Authorization: `Bearer ${config.appId}|${config.appSecret}` },
    });
  });

  it('uses supported Page webhook field names and only verifies success after Meta confirms it', async () => {
    const { client, request } = setup({ success: true });
    await client.subscribePage(pageId, pageToken);
    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      url: `https://graph.facebook.com/v26.0/${pageId}/subscribed_apps`,
      data: {
        subscribed_fields: [
          'messages',
          'messaging_postbacks',
          'message_echoes',
          'message_deliveries',
          'message_reads',
        ],
      },
    });
    await client.unsubscribePage(pageId, pageToken);
    expect(request.mock.calls[1][0]).toMatchObject({
      method: 'DELETE',
      url: `https://graph.facebook.com/v26.0/${pageId}/subscribed_apps`,
    });
  });

  it('normalizes conversation participants and cursor pages without following Graph next URLs', async () => {
    const { client, request } = setup({
      data: [
        {
          id: 't_12345',
          updated_time: '2026-11-05T01:00:00+0000',
          participants: {
            data: [
              { id: pageId, name: 'Support' },
              { id: psid, name: 'Customer' },
            ],
          },
          message_count: 2,
          snippet: 'Hello',
        },
      ],
      paging: {
        cursors: { after: 'cursor-next' },
        next: 'http://169.254.169.254/metadata',
      },
    });
    expect(
      await client.listConversations(pageId, pageToken, {
        after: 'cursor-previous',
        limit: 10,
      }),
    ).toEqual({
      items: [
        {
          id: 't_12345',
          updatedAt: '2026-11-05T01:00:00+0000',
          participants: [
            { id: pageId, name: 'Support' },
            { id: psid, name: 'Customer' },
          ],
          messageCount: 2,
          snippet: 'Hello',
        },
      ],
      after: 'cursor-next',
    });
    expect(request.mock.calls[0][0]).toMatchObject({
      url: `https://graph.facebook.com/v26.0/${pageId}/conversations`,
      params: { after: 'cursor-previous', platform: 'messenger', limit: 10 },
    });
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValueOnce({
      status: 200,
      data: {
        data: [],
        paging: {
          cursors: { after: 'cursor-next' },
          next: 'https://graph.facebook.com/next',
        },
      },
    });
    await expect(
      client.listConversations(pageId, pageToken, { after: 'cursor-next' }),
    ).rejects.toMatchObject({ code: 'FACEBOOK_INVALID_RESPONSE' });
    request.mockResolvedValueOnce({
      status: 200,
      data: { data: [], paging: { cursors: { after: 'terminal-cursor' } } },
    });
    expect(
      (await client.listConversations(pageId, pageToken)).after,
    ).toBeNull();
  });

  it('normalizes message history and rejects unsafe media URLs without fetching attachments', async () => {
    const { client, request } = setup({
      data: [
        {
          id: 'm_123',
          created_time: '2026-11-05T01:00:00+0000',
          from: { id: psid, name: 'Customer' },
          to: { data: [{ id: pageId }] },
          message: 'A photo',
          attachments: {
            data: [
              {
                mime_type: 'image/jpeg',
                name: 'photo.jpg',
                image_data: { url: 'https://scontent.xx.fbcdn.net/photo.jpg' },
              },
              {
                mime_type: 'video/mp4',
                video_data: {
                  url: 'https://video.xx.fbcdn.net/movie.mp4',
                  preview_url: 'https://scontent.xx.fbcdn.net/preview.jpg',
                },
              },
              { file_url: 'javascript:alert(1)' },
              { file_url: 'https://127.0.0.1/private' },
              {
                file_url:
                  'https://graph.facebook.com/picture?access_token=secret',
              },
            ],
          },
        },
      ],
    });
    expect((await client.listMessages('t_12345', pageToken)).items[0]).toEqual({
      id: 'm_123',
      createdAt: '2026-11-05T01:00:00+0000',
      from: { id: psid, name: 'Customer' },
      to: [{ id: pageId }],
      text: 'A photo',
      attachments: [
        {
          type: 'image',
          url: 'https://scontent.xx.fbcdn.net/photo.jpg',
          previewUrl: null,
          name: 'photo.jpg',
        },
        {
          type: 'video',
          url: 'https://video.xx.fbcdn.net/movie.mp4',
          previewUrl: 'https://scontent.xx.fbcdn.net/preview.jpg',
          name: null,
        },
        { type: 'file', url: null, previewUrl: null, name: null },
        { type: 'file', url: null, previewUrl: null, name: null },
        { type: 'file', url: null, previewUrl: null, name: null },
      ],
    });
    expect(request.mock.calls[0][0]).toMatchObject({
      url: 'https://graph.facebook.com/v26.0/t_12345/messages',
      params: { fields: 'id,created_time,from,to,message,attachments' },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('requires the returned Page and PSID to match the requested identity', async () => {
    const { client, request } = setup({ id: '999', name: 'Other Page' });
    await expect(client.getPage(pageId, pageToken)).rejects.toMatchObject({
      code: 'FACEBOOK_INVALID_RESPONSE',
    });
    request.mockResolvedValueOnce({
      status: 200,
      data: {
        id: psid,
        first_name: 'An',
        last_name: 'Nguyen',
        profile_pic: 'https://scontent.xx.fbcdn.net/avatar.jpg',
      },
    });
    expect(await client.getUserProfile(psid, pageToken)).toEqual({
      id: psid,
      name: 'An Nguyen',
      avatarUrl: 'https://scontent.xx.fbcdn.net/avatar.jpg',
    });
  });

  it('sends RESPONSE text only to the exact Page-scoped recipient using that Page token', async () => {
    const { client, request } = setup({
      message_id: 'm_sent',
      recipient_id: psid,
    });
    expect(await client.sendText(pageId, pageToken, psid, 'Hello')).toEqual({
      messageId: 'm_sent',
      recipientId: psid,
    });
    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      url: `https://graph.facebook.com/v26.0/${pageId}/messages`,
      headers: { Authorization: `Bearer ${pageToken}` },
      data: {
        recipient: { id: psid },
        messaging_type: 'RESPONSE',
        message: { text: 'Hello' },
      },
    });
    expect(request.mock.calls[0][0].data).not.toHaveProperty('tag');
  });

  it('rejects invalid IDs, cursor input, oversized text and unconfigured apps before HTTP', async () => {
    const { client, request } = setup();
    await expect(
      client.listConversations('https://attacker.example', pageToken),
    ).rejects.toMatchObject({
      code: 'FACEBOOK_INVALID_REQUEST',
      ambiguous: false,
    });
    await expect(
      client.listMessages('../../debug_token', pageToken),
    ).rejects.toMatchObject({ code: 'FACEBOOK_INVALID_REQUEST' });
    await expect(
      client.listPages('token', { limit: 101 }),
    ).rejects.toMatchObject({ code: 'FACEBOOK_INVALID_REQUEST' });
    await expect(
      client.listPages('token', { after: '\nmalformed' }),
    ).rejects.toMatchObject({ code: 'FACEBOOK_INVALID_REQUEST' });
    await expect(
      client.sendText(pageId, pageToken, psid, 'a'.repeat(2001)),
    ).rejects.toMatchObject({ code: 'FACEBOOK_INVALID_REQUEST' });
    await expect(
      new FacebookGraphClient(
        { ...config, appSecret: '' },
        { request },
      ).listPages('token'),
    ).rejects.toMatchObject({ code: 'FACEBOOK_NOT_CONFIGURED' });
    expect(
      () =>
        new FacebookGraphClient(
          { ...config, graphVersion: 'v26.0/../../' },
          { request },
        ),
    ).toThrow(FacebookGraphError);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('Facebook Graph failure certainty and secret handling', () => {
  it.each([
    [190, 'FACEBOOK_REAUTH_REQUIRED', true, false],
    [10, 'FACEBOOK_PERMISSION_DENIED', false, false],
    [4, 'FACEBOOK_RATE_LIMITED', false, true],
    [100, 'FACEBOOK_REQUEST_REJECTED', false, false],
  ])(
    'classifies explicit Graph rejection %s without copying provider details',
    async (code, expected, reauth, retryable) => {
      const { client, request } = setup(
        {
          error: {
            code,
            error_subcode: 77,
            message: `${pageToken} ${config.appSecret} sensitive provider detail`,
            fbtrace_id: 'sensitive-trace',
          },
        },
        400,
      );
      const error = await client
        .sendText(pageId, pageToken, psid, 'Hello')
        .catch((v: unknown) => v);
      expect(error).toMatchObject({
        code: expected,
        ambiguous: false,
        definiteFailure: true,
        reauthRequired: reauth,
        retryable,
        providerCode: code,
        providerSubcode: 77,
      });
      expect(JSON.stringify(error)).not.toContain(pageToken);
      expect(String(error)).not.toContain(config.appSecret);
      expect(error).not.toHaveProperty('cause');
      expect(error).not.toHaveProperty('response');
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('treats transport loss, HTTP failures without a Graph rejection and malformed acknowledgements as UNKNOWN sends', async () => {
    const { client, request } = setup();
    request.mockRejectedValueOnce(
      new AxiosError(`timeout token=${pageToken}`, 'ECONNABORTED'),
    );
    await expect(
      client.sendText(pageId, pageToken, psid, 'Hello'),
    ).rejects.toMatchObject({
      ambiguous: true,
      definiteFailure: false,
      retryable: false,
    });
    request.mockResolvedValueOnce({
      status: 502,
      data: '<html>upstream failed</html>',
    });
    await expect(
      client.sendText(pageId, pageToken, psid, 'Hello'),
    ).rejects.toMatchObject({ ambiguous: true, retryable: false });
    request.mockResolvedValueOnce({
      status: 200,
      data: { recipient_id: psid },
    });
    await expect(
      client.sendText(pageId, pageToken, psid, 'Hello'),
    ).rejects.toMatchObject({
      code: 'FACEBOOK_INVALID_RESPONSE',
      ambiguous: true,
      retryable: false,
    });
    request.mockResolvedValueOnce({
      status: 200,
      data: { recipient_id: '999', message_id: 'm_wrong_recipient' },
    });
    await expect(
      client.sendText(pageId, pageToken, psid, 'Hello'),
    ).rejects.toMatchObject({ ambiguous: true, retryable: false });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('recognizes explicit Graph rejections attached to Axios errors', async () => {
    const { client, request } = setup();
    const failure = new AxiosError('raw sensitive transport error');
    failure.response = {
      status: 400,
      data: { error: { code: 190 } },
    } as NonNullable<AxiosError['response']>;
    request.mockRejectedValueOnce(failure);
    await expect(
      client.sendText(pageId, pageToken, psid, 'Hello'),
    ).rejects.toMatchObject({
      code: 'FACEBOOK_REAUTH_REQUIRED',
      ambiguous: false,
    });
  });

  it('marks network failures on read operations retryable without any automatic HTTP replay', async () => {
    const { client, request } = setup();
    request.mockRejectedValueOnce(new Error('raw secret connection failure'));
    await expect(client.listPages('user-token')).rejects.toMatchObject({
      code: 'FACEBOOK_UNAVAILABLE',
      ambiguous: false,
      retryable: true,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
