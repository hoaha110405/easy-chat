import { describe, it, expect } from 'vitest';
import { ConfigService } from '../src/config/config.service';
import { config } from './helpers';
function configuration(overrides: Partial<ConfigService['env']>) {
  return Object.assign(
    Object.create(ConfigService.prototype) as ConfigService,
    {
      env: { ...config.env, ...overrides },
    },
  );
}
describe('separate OAuth and webhook configuration', () => {
  it('permits OA authorization before the webhook secret is configured', () => {
    const service = configuration({ ZALO_OA_SECRET_KEY: '' });
    expect(service.zaloConfigured).toBe(true);
    expect(service.webhookConfigured).toBe(false);
  });
  it('still requires the app secret for OAuth and the signing secret for webhooks', () => {
    const service = configuration({ ZALO_APP_SECRET: '' });
    expect(service.zaloConfigured).toBe(false);
    expect(service.webhookConfigured).toBe(true);
    const missingApp = configuration({ ZALO_APP_ID: '' });
    expect(missingApp.zaloConfigured).toBe(false);
    expect(missingApp.webhookConfigured).toBe(false);
  });
});

import { parseEnvironment } from '../src/config/env';
describe('personal-only production configuration', () => {
  it('does not require an OA callback when no OA application is configured', () => {
    const environment = Object.fromEntries(
      Object.entries(config.env).map(([key, value]) => [key, String(value)]),
    );
    const personalOnly = {
      ...environment,
      NODE_ENV: 'production',
      FRONTEND_URL: 'https://inbox.example.com',
      ZALO_APP_ID: '',
      ZALO_APP_SECRET: '',
    };
    expect(() => parseEnvironment(personalOnly)).not.toThrow();
    expect(() =>
      parseEnvironment({
        ...personalOnly,
        ZALO_APP_ID: '123',
        ZALO_APP_SECRET: 'test-secret',
      }),
    ).toThrow('HTTPS');
  });
  it('requires HTTPS for a configured Facebook callback independently of Zalo', () => {
    const environment = Object.fromEntries(
      Object.entries(config.env).map(([key, value]) => [key, String(value)]),
    );
    const pageOnly = {
      ...environment,
      NODE_ENV: 'production',
      FRONTEND_URL: 'https://inbox.example.com',
      ZALO_APP_ID: '',
      ZALO_APP_SECRET: '',
      FACEBOOK_APP_ID: '123456',
      FACEBOOK_APP_SECRET: 'fixture-meta-secret',
    };
    expect(() => parseEnvironment(pageOnly)).toThrow('HTTPS');
    expect(() =>
      parseEnvironment({
        ...pageOnly,
        FACEBOOK_OAUTH_REDIRECT_URI:
          'https://inbox.example.com/api/channels/facebook-page/oauth/callback',
      }),
    ).not.toThrow();
  });
  it('keeps Facebook optional, pins an explicit API version and disables Personal by default', () => {
    const environment = Object.fromEntries(
      Object.entries(config.env).map(([key, value]) => [key, String(value)]),
    );
    delete environment.FACEBOOK_GRAPH_API_VERSION;
    delete environment.FACEBOOK_PERSONAL_ENABLED;
    const parsed = parseEnvironment(environment);
    expect(parsed.FACEBOOK_GRAPH_API_VERSION).toBe('v26.0');
    expect(parsed.FACEBOOK_PERSONAL_ENABLED).toBe(false);
    expect(() =>
      parseEnvironment({
        ...environment,
        FACEBOOK_GRAPH_API_VERSION: '../unversioned',
      }),
    ).toThrow('FACEBOOK_GRAPH_API_VERSION');
    expect(
      configuration({ FACEBOOK_APP_ID: '', FACEBOOK_APP_SECRET: '' })
        .facebookConfigured,
    ).toBe(false);
    const service = configuration({
      FACEBOOK_APP_ID: '123456',
      FACEBOOK_APP_SECRET: 'fixture-meta-secret',
      FACEBOOK_VERIFY_TOKEN: '',
    });
    expect(service.facebookConfigured).toBe(true);
    expect(service.facebookWebhookConfigured).toBe(false);
  });
});
