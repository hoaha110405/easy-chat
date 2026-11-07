import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { facebookOrigin, launchWhatsAppSignup } from './whatsapp-signup';
import { MessageAttachment } from '@/features/inbox/message-attachment';
afterEach(() => {
  delete window.FB;
  vi.restoreAllMocks();
});
describe('official Meta signup boundary and private media rendering', () => {
  it('validates full Meta origins rather than unsafe suffix matches', () => {
    expect(facebookOrigin('https://www.facebook.com')).toBe(true);
    expect(facebookOrigin('https://business.facebook.com')).toBe(true);
    for (const origin of [
      'http://facebook.com',
      'https://evilfacebook.com',
      'https://facebook.com.evil.example',
      'https://facebook.com:444',
    ])
      expect(facebookOrigin(origin)).toBe(false);
  });
  it('only trusts Meta session messages, uses the documented v4 SDK options and does not log codes', async () => {
    let callback:
      ((r: { authResponse?: { code?: string } }) => void) | undefined;
    const login = vi.fn(
      (cb: (r: { authResponse?: { code?: string } }) => void) => {
        callback = cb;
      },
    );
    window.FB = { init: vi.fn(), login };
    const assets = vi.fn();
    const log = vi.spyOn(console, 'log');
    const pending = launchWhatsAppSignup('401', assets);
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://evilfacebook.com',
        data: JSON.stringify({
          type: 'WA_EMBEDDED_SIGNUP',
          event: 'FINISH',
          data: { waba_id: 'evil' },
        }),
      }),
    );
    expect(assets).not.toHaveBeenCalled();
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://www.facebook.com',
        data: JSON.stringify({
          type: 'WA_EMBEDDED_SIGNUP',
          event: 'FINISH',
          data: { waba_id: '201', phone_number_id: '101' },
        }),
      }),
    );
    expect(assets).toHaveBeenCalledWith({
      wabaId: '201',
      phoneNumberId: '101',
    });
    callback!({ authResponse: { code: 'ephemeral-code' } });
    expect(await pending).toBe('ephemeral-code');
    expect(login.mock.calls[0]).toHaveLength(2);
    expect(log).not.toHaveBeenCalled();
  });
  it('handles Meta cancellation and explicitly declines Coexistence onboarding', async () => {
    window.FB = { init: vi.fn(), login: vi.fn() };
    for (const event of ['CANCEL', 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING']) {
      const pending = launchWhatsAppSignup('401', vi.fn());
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://www.facebook.com',
          data: JSON.stringify({
            type: 'WA_EMBEDDED_SIGNUP',
            event,
            data: { waba_id: '201' },
          }),
        }),
      );
      await expect(pending).rejects.toThrow();
    }
  });
  it('renders an authenticated media URL without exposing the provider URL or token', () => {
    render(
      <MessageAttachment
        attachment={{
          type: 'image',
          url: 'https://evil.example/ignored',
          name: 'Photo',
          authenticatedPath:
            '/channels/whatsapp/messages/cmh0000000000000000000001/media',
        }}
      />,
    );
    expect(screen.getByRole('img', { name: 'Photo' })).toHaveAttribute(
      'src',
      '/api/channels/whatsapp/messages/cmh0000000000000000000001/media',
    );
    expect(screen.getByRole('link', { name: 'Mở ảnh gốc' })).toHaveAttribute(
      'href',
      '/api/channels/whatsapp/messages/cmh0000000000000000000001/media',
    );
  });
});
