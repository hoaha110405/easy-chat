import { Injectable } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { TikTokBusinessClient } from '../tiktok-business/tiktok-business.client';
import { TikTokShopClient } from '../tiktok-shop/tiktok-shop.client';
import { TikTokError } from './tiktok-http';
import type { TikTokType, TikTokAdapter } from './tiktok.types';
export function validateAuthorizationUrl(
  value: string,
  type: TikTokType,
  redirect: string,
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TikTokError('TIKTOK_NOT_CONFIGURED');
  }
  const valid =
    type === 'TIKTOK_BUSINESS'
      ? url.hostname === 'www.tiktok.com' &&
        /^\/(v2\/)?auth\/authorize\/?$/.test(url.pathname)
      : ['services.tiktokshop.com', 'services.us.tiktokshop.com'].includes(
          url.hostname,
        ) && url.pathname === '/open/authorize';
  if (
    !valid ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    throw new TikTokError('TIKTOK_AUTH_URL_INVALID');
  if (
    url.searchParams.has('redirect_uri') &&
    url.searchParams.get('redirect_uri') !== redirect
  )
    throw new TikTokError('TIKTOK_AUTH_URL_INVALID');
  return url;
}
@Injectable()
export class TikTokRegistry {
  constructor(
    private readonly config: ConfigService,
    private readonly business: TikTokBusinessClient,
    private readonly shop: TikTokShopClient,
  ) {}
  adapter(type: TikTokType): TikTokAdapter {
    return type === 'TIKTOK_BUSINESS' ? this.business : this.shop;
  }
  settings(type: TikTokType) {
    const e = this.config.env;
    return type === 'TIKTOK_BUSINESS'
      ? {
          enabled: e.TIKTOK_BUSINESS_ENABLED,
          appId: e.TIKTOK_BUSINESS_APP_ID,
          secret: e.TIKTOK_BUSINESS_APP_SECRET,
          authorizationUrl: e.TIKTOK_BUSINESS_AUTHORIZATION_URL,
          redirectUri: e.TIKTOK_BUSINESS_REDIRECT_URI,
        }
      : {
          enabled: e.TIKTOK_SHOP_ENABLED,
          appId: e.TIKTOK_SHOP_APP_KEY,
          secret: e.TIKTOK_SHOP_APP_SECRET,
          authorizationUrl: e.TIKTOK_SHOP_AUTHORIZATION_URL,
          redirectUri: e.TIKTOK_SHOP_REDIRECT_URI,
        };
  }
  configured(type: TikTokType) {
    const s = this.settings(type);
    return Boolean(s.enabled && s.appId && s.secret && s.authorizationUrl);
  }
  webhookUrl(type: TikTokType) {
    const s = this.settings(type);
    const u = new URL(s.redirectUri);
    u.pathname = `/api/channels/${type === 'TIKTOK_BUSINESS' ? 'tiktok-business' : 'tiktok-shop'}/webhook`;
    u.search = '';
    u.hash = '';
    if (u.protocol !== 'https:' || u.port || u.username || u.password)
      throw new TikTokError('TIKTOK_PUBLIC_HTTPS_REQUIRED');
    return u.href;
  }
}
