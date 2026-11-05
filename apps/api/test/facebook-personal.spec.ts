import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/common/api-error';
import type { ConfigService } from '../src/config/config.service';
import {
  FacebookPersonalAdapterError,
  type FacebookPersonalOperation,
} from '../src/modules/facebook-personal/facebook-personal.adapter';
import { FacebookPersonalController } from '../src/modules/facebook-personal/facebook-personal.controller';
import { FacebookPersonalService } from '../src/modules/facebook-personal/facebook-personal.service';
import { UnsupportedFacebookPersonalAdapter } from '../src/modules/facebook-personal/unsupported-facebook-personal.adapter';

const session = {
  expectedExternalAccountId: '90071992547409939999',
  opaqueSession: 'private-session-material-must-not-leak',
};

describe('Facebook Personal unavailable provider boundary', () => {
  it.each([false, true])(
    'does not turn feature flag %s into working authentication or E2EE',
    (enabled) => {
      const service = new FacebookPersonalService({
        env: { FACEBOOK_PERSONAL_ENABLED: enabled },
      } as ConfigService);
      const status = service.status();
      expect(status.enabled).toBe(enabled);
      expect(status).toMatchObject({
        status: 'UNSUPPORTED',
        experimental: true,
        reasonCode: 'FACEBOOK_PERSONAL_UNSUPPORTED',
        library: null,
      });
      expect(Object.values(status.capabilities).every((value) => !value)).toBe(
        true,
      );
      expect(() => {
        (status.capabilities as { e2ee: boolean }).e2ee = true;
      }).toThrow();
      expect(service.status().capabilities.e2ee).toBe(false);
    },
  );

  it('cannot report a connected or restored session, including after restart', async () => {
    const adapter = new UnsupportedFacebookPersonalAdapter();
    expect(adapter.getConnectionStatus()).toBe('UNSUPPORTED');
    await expect(adapter.connect(session)).rejects.toMatchObject({
      code: 'FACEBOOK_PERSONAL_UNSUPPORTED',
      safeToRetry: false,
    });
    expect(adapter.getConnectionStatus()).toBe('UNSUPPORTED');
    adapter.disconnect();
    adapter.disconnect();
    expect(adapter.getConnectionStatus()).toBe('DISCONNECTED');
    const restarted = new UnsupportedFacebookPersonalAdapter();
    await expect(restarted.restoreSession(session)).rejects.toMatchObject({
      code: 'FACEBOOK_PERSONAL_UNSUPPORTED',
    });
    expect(restarted.getConnectionStatus()).toBe('UNSUPPORTED');
  });

  it('rejects listening without registering callbacks or generating messages', async () => {
    const adapter = new UnsupportedFacebookPersonalAdapter();
    const onMessage = vi.fn();
    const onClosed = vi.fn();
    await expect(
      adapter.startListening(onMessage, onClosed),
    ).rejects.toMatchObject({ code: 'FACEBOOK_PERSONAL_UNSUPPORTED' });
    adapter.stopListening();
    adapter.stopListening();
    adapter.disconnect();
    expect(onMessage).not.toHaveBeenCalled();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('does not fabricate empty history, delivery acknowledgement, or message IDs', async () => {
    const adapter = new UnsupportedFacebookPersonalAdapter();
    for (const operation of [
      adapter.listConversations('private-cursor'),
      adapter.getMessages('90071992547409939999'),
      adapter.sendTextMessage('90071992547409939999', 'private-message'),
    ]) {
      await expect(operation).rejects.toMatchObject({
        code: 'FACEBOOK_PERSONAL_UNSUPPORTED',
        safeToRetry: false,
      });
    }
    expect(adapter.getConnectionStatus()).toBe('UNSUPPORTED');
  });

  it('uses safe specific errors with no supplied sessions, thread IDs or content', async () => {
    const adapter = new UnsupportedFacebookPersonalAdapter();
    const failures = await Promise.allSettled([
      adapter.connect(session),
      adapter.restoreSession(session),
      adapter.sendTextMessage(
        session.expectedExternalAccountId,
        'private-text',
      ),
    ]);
    for (const result of failures) {
      expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') continue;
      expect(result.reason).toBeInstanceOf(FacebookPersonalAdapterError);
      const serialized = String(result.reason) + JSON.stringify(result.reason);
      expect(serialized).not.toMatch(
        /private-session|90071992547409939999|private-text/,
      );
    }
    expect(new FacebookPersonalAdapterError('e2ee').code).toBe(
      'FACEBOOK_PERSONAL_E2EE_UNSUPPORTED',
    );
  });

  it('returns actionable HTTP 501 errors for every unavailable operation', () => {
    const service = new FacebookPersonalService({
      env: { FACEBOOK_PERSONAL_ENABLED: true },
    } as ConfigService);
    const operations: FacebookPersonalOperation[] = [
      'connect',
      'restoreSession',
      'listConversations',
      'history',
      'receive',
      'sendText',
      'e2ee',
    ];
    for (const operation of operations) {
      try {
        service.assertSupported(operation);
        expect.unreachable('Unavailable operations must fail closed');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).getStatus()).toBe(501);
        expect((error as ApiError).code).toBe(
          operation === 'e2ee'
            ? 'FACEBOOK_PERSONAL_E2EE_UNSUPPORTED'
            : 'FACEBOOK_PERSONAL_UNSUPPORTED',
        );
      }
    }
    const controller = new FacebookPersonalController(service);
    expect(() => controller.connect()).toThrow(ApiError);
    expect(() => controller.create()).toThrow(ApiError);
    expect(controller.status().data).toEqual(controller.capabilities().data);
  });
});
