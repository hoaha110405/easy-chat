import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  telegramStatusSchema,
  telegramAccountSchema,
  telegramAuthorizationSchema,
  channelSyncResultSchema,
  type TelegramStatus,
  type TelegramAuthInput,
} from '@zalo/shared';
import {
  ArrowRight,
  Link2,
  RefreshCw,
  ShieldCheck,
  Unplug,
  AlertCircle,
  KeyRound,
} from 'lucide-react';
import { api } from '@/lib/api';
import { connectionLabel, sendBlockedMessage } from '@/lib/channels';
import { Avatar } from '@/components/avatar';
import { ProviderMark } from '@/components/provider-mark';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Loading, ErrorNotice } from '@/components/feedback';
import { formatTime } from '@/lib/utils';
export function TelegramBotConnectionPage() {
  return <TelegramPage kind="bot" />;
}
export function TelegramPersonalConnectionPage() {
  return <TelegramPage kind="personal" />;
}
export function telegramConfirmationUrl(value?: string) {
  if (!value) return;
  try {
    const url = new URL(value);
    if (
      url.protocol === 'tg:' &&
      url.hostname === 'login' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      [...url.searchParams.keys()].length === 1 &&
      /^[A-Za-z0-9_=-]+$/.test(url.searchParams.get('token') ?? '')
    )
      return url.href;
  } catch {
    /* ignore malformed auth links */
  }
}
function TelegramPage({ kind }: { kind: 'bot' | 'personal' }) {
  const personal = kind === 'personal';
  const provider = personal ? 'telegram-personal' : 'telegram-bot';
  const name = personal ? 'Telegram cá nhân' : 'Telegram Bot';
  const [token, setToken] = useState('');
  const [accountName, setAccountName] = useState('Telegram cá nhân');
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['telegram', kind],
    queryFn: () => api(`/channels/${provider}`, telegramStatusSchema),
    refetchInterval: personal ? 1500 : 5000,
  });
  const refresh = () => {
    for (const key of ['telegram', 'inbox-accounts', 'conversations'])
      void client.invalidateQueries({ queryKey: [key] });
  };
  const connect = useMutation({
    mutationFn: (value: string) =>
      api(`/channels/${provider}/connect`, telegramAccountSchema, {
        method: 'POST',
        body: JSON.stringify(personal ? { name: value } : { token: value }),
      }),
    onSuccess: refresh,
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    const value = personal ? accountName : token;
    setToken('');
    connect.mutate(value);
  }
  const ready = Boolean(
    query.data?.configured &&
    (!personal || (query.data.nativeAvailable && query.data.workerOnline)),
  );
  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <Link
          to="/apps"
          className="text-xs text-muted-foreground hover:text-primary"
        >
          Ứng dụng / {name}
        </Link>
        <div className="mb-6 mt-5 flex items-center gap-3">
          <ProviderMark provider="telegram" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {personal
                ? 'Các cuộc chat của bạn trong cùng một hộp thư.'
                : 'Nhận và trả lời những cuộc chat gửi tới bot của bạn.'}
            </p>
          </div>
        </div>
        {query.isPending ? (
          <Loading label="Đang tải Telegram…" />
        ) : query.error ? (
          <ErrorNotice error={query.error} />
        ) : null}
        {query.data ? (
          <>
            {!query.data.enabled ||
            !query.data.configured ||
            (personal && !query.data.nativeAvailable) ? (
              <Card className="mb-5 flex items-start gap-3 p-5">
                <AlertCircle className="mt-0.5 size-5 shrink-0 text-amber-600" />
                <div>
                  <h2 className="text-sm font-semibold">
                    {!query.data.enabled
                      ? 'Kênh đang tắt'
                      : !query.data.configured
                        ? 'Chưa cấu hình Telegram'
                        : 'TDLib native chưa sẵn sàng'}
                  </h2>
                  <p className="mt-2 text-xs leading-6 text-muted-foreground">
                    {personal
                      ? 'Quản trị viên cần cấu hình API ID, API Hash và thư viện TDLib chính thức tại máy chủ.'
                      : 'Cần cấu hình URL webhook HTTPS công khai ở máy chủ trước khi thêm Bot Token.'}
                  </p>
                </div>
              </Card>
            ) : null}
            {!query.data.workerOnline ? (
              <p
                role="status"
                className="mb-5 rounded-xl bg-amber-50 p-4 text-xs leading-6 text-amber-900"
              >
                Worker đang ngoại tuyến. Khởi động bộ xử lý để nhận và gửi tin
                nhắn.
              </p>
            ) : null}
            <Card className="mb-6 min-w-0 p-5">
              <h2 className="text-base font-semibold">
                {personal ? 'Thêm tài khoản Telegram' : 'Kết nối bot của bạn'}
              </h2>
              <p className="mt-2 text-xs leading-6 text-muted-foreground">
                {personal
                  ? 'Đăng nhập bằng số điện thoại, mã Telegram và 2FA nếu tài khoản yêu cầu. Mã và mật khẩu chỉ dùng cho lần xác thực.'
                  : 'Lấy Bot Token từ BotFather. Token được mã hóa trên máy chủ; kết nối này đưa webhook của bot về easyChat.'}
              </p>
              <form
                onSubmit={submit}
                className="mt-4 flex flex-col gap-3 sm:flex-row"
              >
                <div className="min-w-0 flex-1">
                  <label
                    htmlFor="telegram-connect"
                    className="mb-2 block text-xs font-medium"
                  >
                    {personal ? 'Tên tài khoản' : 'Bot Token'}
                  </label>
                  <Input
                    id="telegram-connect"
                    type={personal ? 'text' : 'password'}
                    autoComplete="off"
                    value={personal ? accountName : token}
                    onChange={(e) =>
                      personal
                        ? setAccountName(e.target.value)
                        : setToken(e.target.value)
                    }
                    disabled={!ready || connect.isPending}
                    maxLength={personal ? 100 : 256}
                    required
                    placeholder={
                      personal
                        ? 'Telegram công việc'
                        : 'Nhập token được BotFather cung cấp'
                    }
                  />
                </div>
                <Button
                  disabled={!ready || connect.isPending}
                  className="sm:mt-6"
                >
                  <Link2 />
                  {connect.isPending ? 'Đang kết nối…' : `Kết nối ${name}`}
                </Button>
              </form>
              {connect.error ? (
                <div className="mt-4">
                  <ErrorNotice error={connect.error} />
                </div>
              ) : null}
            </Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">Tài khoản của bạn</h2>
              <span className="text-xs text-muted-foreground">
                {query.data.accounts.length} tài khoản
              </span>
            </div>
            <div className="grid min-w-0 gap-4">
              {query.data.accounts.map((account) => (
                <TelegramAccount
                  key={account.id}
                  account={account}
                  personal={personal}
                  refresh={refresh}
                  ready={ready}
                />
              ))}
              {!query.data.accounts.length ? (
                <Card className="p-8 text-center">
                  <p className="text-sm font-medium">Chưa kết nối {name}</p>
                  <p className="mt-2 text-xs leading-6 text-muted-foreground">
                    Tài khoản sau khi xác thực sẽ xuất hiện ở đây và trong bộ
                    lọc hộp thư.
                  </p>
                </Card>
              ) : null}
            </div>
            <Card className="mt-6 p-5">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <ShieldCheck className="size-4" />
                Phạm vi kết nối
              </h2>
              <ul className="mt-3 space-y-2 text-xs leading-6 text-muted-foreground">
                {query.data.restrictions.map((text) => (
                  <li key={text}>• {text}</li>
                ))}
              </ul>
            </Card>
          </>
        ) : null}
      </div>
    </main>
  );
}
function TelegramAccount({
  account,
  personal,
  refresh,
  ready,
}: {
  account: TelegramStatus['accounts'][number];
  personal: boolean;
  refresh: () => void;
  ready: boolean;
}) {
  const [confirm, setConfirm] = useState(false);
  const action = useMutation({
    mutationFn: async (
      kind: 'sync' | 'verify' | 'disconnect' | 'reconnect',
    ): Promise<unknown> => {
      if (kind === 'disconnect')
        return api(
          `/channels/${account.id}`,
          z.object({ disconnected: z.boolean() }),
          { method: 'DELETE' },
        );
      if (kind === 'reconnect')
        return api(
          '/channels/telegram-personal/connect',
          telegramAccountSchema,
          {
            method: 'POST',
            body: JSON.stringify({ accountId: account.id, name: account.name }),
          },
        );
      if (kind === 'verify')
        return api(
          `/channels/telegram-bot/${account.id}/verify-webhook`,
          z.object({
            verified: z.boolean(),
            pendingUpdateCount: z.number(),
            deliveryError: z.boolean(),
          }),
          { method: 'POST' },
        );
      return api(`/channels/${account.id}/sync`, channelSyncResultSchema, {
        method: 'POST',
      });
    },
    onSuccess: () => {
      setConfirm(false);
      refresh();
    },
  });
  return (
    <Card className="min-w-0 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <Avatar
          name={account.name}
          url={account.avatarUrl}
          className="size-12"
        />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{account.name}</h3>
          <p className="mt-1 truncate text-[10px] text-muted-foreground">
            {account.externalAccountId ?? 'Đang chờ xác thực tài khoản'}
          </p>
        </div>
        <span className="rounded-full bg-slate-50 px-3 py-1.5 text-[10px] font-medium">
          {connectionLabel(account.connectionStatus)}
        </span>
      </div>
      {account.lastError || account.lastSyncError ? (
        <p
          role="alert"
          className="mt-3 rounded-xl bg-amber-50 p-3 text-xs leading-6 text-amber-900"
        >
          {sendBlockedMessage(account.lastError ?? account.lastSyncError)}
        </p>
      ) : null}
      {account.rateLimitedUntil &&
      new Date(account.rateLimitedUntil) > new Date() ? (
        <p className="mt-3 text-xs text-amber-800">
          Telegram yêu cầu chờ đến {formatTime(account.rateLimitedUntil, true)}.
        </p>
      ) : null}
      {personal &&
      account.authorization &&
      account.connectionStatus !== 'CONNECTED' ? (
        <AuthForm
          key={account.authorization.tdlibState}
          account={account}
          refresh={refresh}
        />
      ) : null}
      {account.lastSyncAt ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {personal ? 'Đồng bộ' : 'Kiểm tra webhook'} gần nhất:{' '}
          {formatTime(account.lastSyncAt, true)}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" asChild>
          <Link
            to={`/inbox?account=${encodeURIComponent((personal ? 'telegram-personal:' : 'telegram-bot:') + account.id)}`}
          >
            Mở hộp thư
            <ArrowRight />
          </Link>
        </Button>
        {personal ? (
          <Button
            size="sm"
            variant="outline"
            disabled={
              action.isPending ||
              !account.workerOnline ||
              account.connectionStatus !== 'CONNECTED'
            }
            onClick={() => action.mutate('sync')}
          >
            <RefreshCw />
            Đồng bộ
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={
              action.isPending || account.connectionStatus === 'DISCONNECTED'
            }
            onClick={() => action.mutate('verify')}
          >
            <RefreshCw />
            Kiểm tra webhook
          </Button>
        )}
        {personal &&
        ['DISCONNECTED', 'REAUTH_REQUIRED', 'ERROR'].includes(
          account.connectionStatus,
        ) ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!ready || action.isPending}
            onClick={() => action.mutate('reconnect')}
          >
            Kết nối lại
          </Button>
        ) : null}
        {account.connectionStatus !== 'DISCONNECTED' ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={action.isPending}
            onClick={() => setConfirm(true)}
          >
            <Unplug />
            Ngắt kết nối
          </Button>
        ) : null}
      </div>
      {action.isSuccess && action.variables === 'sync' ? (
        <p role="status" className="mt-3 text-xs text-primary">
          Đã xếp lịch đồng bộ phần hội thoại Telegram có thể truy cập.
        </p>
      ) : null}
      {action.isSuccess && action.variables === 'verify' ? (
        <p role="status" className="mt-3 text-xs text-primary">
          Đã xác minh webhook với Telegram.
        </p>
      ) : null}
      {action.error ? (
        <div className="mt-3">
          <ErrorNotice error={action.error} />
        </div>
      ) : null}
      {confirm ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs leading-6">
            Ngắt kết nối {account.name}? Lịch sử trong easyChat vẫn được giữ.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={action.isPending}
              onClick={() => setConfirm(false)}
            >
              Giữ kết nối
            </Button>
            <Button
              size="sm"
              disabled={action.isPending}
              onClick={() => action.mutate('disconnect')}
            >
              Xác nhận ngắt
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
function AuthForm({
  account,
  refresh,
}: {
  account: TelegramStatus['accounts'][number];
  refresh: () => void;
}) {
  const [value, setValue] = useState('');
  const authorization = account.authorization!;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function authenticate(input: TelegramAuthInput) {
    setPending(true);
    setError(null);
    try {
      await api(
        `/channels/telegram-personal/${account.id}/auth`,
        telegramAuthorizationSchema,
        { method: 'POST', body: JSON.stringify(input) },
      );
      refresh();
    } catch (error) {
      setError(error);
    } finally {
      setPending(false);
    }
  }
  const fields: Record<
    string,
    {
      action: 'phone' | 'code' | 'password' | 'email' | 'email_code';
      label: string;
      type: string;
      button: string;
    }
  > = {
    PHONE_REQUIRED: {
      action: 'phone',
      label: 'Số điện thoại (có mã quốc gia)',
      type: 'tel',
      button: 'Gửi mã xác minh',
    },
    CODE_REQUIRED: {
      action: 'code',
      label: 'Mã xác minh Telegram',
      type: 'text',
      button: 'Xác minh mã',
    },
    PASSWORD_REQUIRED: {
      action: 'password',
      label: 'Mật khẩu 2FA Telegram',
      type: 'password',
      button: 'Xác minh mật khẩu',
    },
    EMAIL_REQUIRED: {
      action: 'email',
      label: 'Email xác thực',
      type: 'email',
      button: 'Gửi mã email',
    },
    EMAIL_CODE_REQUIRED: {
      action: 'email_code',
      label: 'Mã xác minh email',
      type: 'text',
      button: 'Xác minh email',
    },
  };
  const field = fields[authorization.state];
  const link = telegramConfirmationUrl(authorization.confirmationLink);
  const limited = Boolean(
    account.rateLimitedUntil && new Date(account.rateLimitedUntil) > new Date(),
  );
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!field) return;
    const input = value;
    setValue('');
    void authenticate({
      action: field.action,
      value: input,
    } as TelegramAuthInput);
  }
  return (
    <div className="mt-4 rounded-xl border bg-slate-50/70 p-4">
      <p className="mb-3 flex items-center gap-2 text-xs font-semibold">
        <KeyRound className="size-4" />
        Hoàn tất đăng nhập
      </p>
      {field ? (
        <form onSubmit={submit}>
          <label
            htmlFor={`telegram-auth-${account.id}`}
            className="mb-2 block text-xs font-medium"
          >
            {field.label}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id={`telegram-auth-${account.id}`}
              type={field.type}
              value={value}
              autoComplete="off"
              maxLength={field.action === 'password' ? 256 : 254}
              disabled={pending || limited}
              onChange={(e) => setValue(e.target.value)}
              required
              placeholder={field.action === 'phone' ? '+84…' : undefined}
            />
            <Button size="sm" disabled={pending || limited || !value.trim()}>
              {pending ? 'Đang xác minh…' : field.button}
            </Button>
          </div>
          {authorization.state === 'CODE_REQUIRED' ? (
            <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
              {authorization.codeDelivery ===
              'authenticationCodeTypeTelegramMessage'
                ? 'Kiểm tra tin nhắn Telegram trên thiết bị đang đăng nhập.'
                : 'Nhập mã theo cách Telegram vừa thông báo cho bạn.'}
            </p>
          ) : null}
          {authorization.passwordHint ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Gợi ý: {authorization.passwordHint}
            </p>
          ) : null}
        </form>
      ) : authorization.state === 'DEVICE_CONFIRMATION_REQUIRED' ? (
        <p className="text-xs leading-6">
          Xác nhận lần đăng nhập này bằng thiết bị Telegram đã đăng nhập.
          {link ? (
            <a
              href={link}
              rel="noreferrer"
              className="ml-1 font-medium text-primary underline"
            >
              Mở Telegram để xác nhận
            </a>
          ) : null}
        </p>
      ) : (
        <p className="text-xs leading-6 text-muted-foreground">
          {authorization.state === 'PREMIUM_REQUIRED'
            ? 'Telegram yêu cầu hoàn tất bước Premium trong ứng dụng chính thức trước khi đăng nhập.'
            : authorization.state === 'REGISTRATION_REQUIRED'
              ? 'Hoàn tất tạo tài khoản bằng ứng dụng Telegram chính thức, rồi kết nối lại.'
              : authorization.state === 'READY'
                ? 'Đang xác minh thông tin tài khoản…'
                : authorization.state === 'INITIALIZING'
                  ? 'Đang khởi tạo phiên Telegram…'
                  : 'Telegram yêu cầu thêm thao tác xác thực. Hãy kiểm tra ứng dụng chính thức hoặc kết nối lại.'}
        </p>
      )}
      {authorization.state === 'PHONE_REQUIRED' ? (
        <Button
          className="mt-3"
          size="sm"
          variant="ghost"
          disabled={pending || limited}
          onClick={() => {
            setValue('');
            void authenticate({ action: 'qr' });
          }}
        >
          Dùng thiết bị Telegram đã đăng nhập
        </Button>
      ) : null}
      {error ? (
        <div className="mt-3">
          <ErrorNotice error={error} />
        </div>
      ) : null}
    </div>
  );
}
