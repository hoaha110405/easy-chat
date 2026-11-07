type FacebookSDK = {
  init(input: {
    appId: string;
    version: string;
    autoLogAppEvents: boolean;
    xfbml: boolean;
  }): void;
  login(
    callback: (response: { authResponse?: { code?: string } }) => void,
    input: {
      config_id: string;
      response_type: 'code';
      override_default_response_type: true;
      extras: { setup: Record<string, never> };
    },
  ): void;
};
declare global {
  interface Window {
    FB?: FacebookSDK;
    fbAsyncInit?: () => void;
  }
}
let loaded: Promise<void> | undefined,
  identity = '';
export function facebookOrigin(origin: string) {
  try {
    const u = new URL(origin);
    return (
      u.protocol === 'https:' &&
      !u.port &&
      (u.hostname === 'facebook.com' || u.hostname.endsWith('.facebook.com'))
    );
  } catch {
    return false;
  }
}
export function loadWhatsAppSignup(appId: string, version: string) {
  if (loaded) {
    if (identity !== appId + ':' + version)
      return Promise.reject(
        new Error('Cấu hình Meta đã thay đổi. Tải lại trang để tiếp tục.'),
      );
    return loaded;
  }
  identity = appId + ':' + version;
  loaded = new Promise<void>((resolve, reject) => {
    const initialize = () => {
      if (!window.FB) {
        reject(new Error('Chưa tải được SDK Meta.'));
        return;
      }
      window.FB.init({ appId, version, autoLogAppEvents: false, xfbml: false });
      resolve();
    };
    if (window.FB) {
      initialize();
      return;
    }
    window.fbAsyncInit = initialize;
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () =>
      reject(new Error('Chưa tải được cửa sổ cấp quyền Meta.'));
    document.head.append(script);
  });
  return loaded;
}
export function launchWhatsAppSignup(
  configId: string,
  onAssets: (data: { wabaId?: string; phoneNumberId?: string }) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const done = (code?: string, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      window.removeEventListener('message', listener);
      if (code) resolve(code);
      else reject(error ?? new Error('Bạn chưa hoàn tất cấp quyền Meta.'));
    };
    const listener = (event: MessageEvent) => {
      if (
        !facebookOrigin(event.origin) ||
        typeof event.data !== 'string' ||
        event.data.length > 32768
      )
        return;
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;
      if (data.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') {
        done(
          undefined,
          new Error('Coexistence chưa được bật. Hãy dùng số Cloud API riêng.'),
        );
        return;
      }
      if (data.event === 'CANCEL' || data.event === 'ERROR') {
        done();
        return;
      }
      if (typeof data.event === 'string' && data.event.startsWith('FINISH')) {
        onAssets({
          ...(typeof data.data?.waba_id === 'string' &&
          /^\d+$/.test(data.data.waba_id)
            ? { wabaId: data.data.waba_id }
            : {}),
          ...(typeof data.data?.phone_number_id === 'string' &&
          /^\d+$/.test(data.data.phone_number_id)
            ? { phoneNumberId: data.data.phone_number_id }
            : {}),
        });
      }
    };
    const timer = setTimeout(
      () =>
        done(
          undefined,
          new Error('Phiên cấp quyền đã hết thời gian. Bắt đầu lại.'),
        ),
      300000,
    );
    window.addEventListener('message', listener);
    if (!window.FB) {
      done();
      return;
    }
    try {
      window.FB.login((r) => done(r.authResponse?.code), {
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {} },
      });
    } catch {
      done(
        undefined,
        new Error('Cửa sổ Meta chưa sẵn sàng. Tải lại trang rồi thử lại.'),
      );
    }
  });
}
