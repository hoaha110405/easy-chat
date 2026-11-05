import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { channelAccountSchema, channelSyncResultSchema } from '@zalo/shared';
import {
  ArrowRight,
  Check,
  Clock3,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  Unplug,
  Webhook,
} from 'lucide-react';
import { useFacebookPages } from '@/features/facebook/queries';
import { api } from '@/lib/api';
import { connectionLabel } from '@/lib/channels';
import { cn, formatTime } from '@/lib/utils';
import { Avatar } from '@/components/avatar';
import { ProviderMark } from '@/components/provider-mark';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorNotice, Loading } from '@/components/feedback';

const oauthMessages: Record<string, string> = {
  INVALID_OAUTH_STATE:
    'Yêu cầu cấp quyền không còn hợp lệ. Vui lòng kết nối Facebook Page lại.',
  OAUTH_SESSION_EXPIRED:
    'Phiên quản trị đã hết hạn. Vui lòng đăng nhập và kết nối lại.',
  OAUTH_DENIED: 'Bạn đã hủy cấp quyền. Bạn có thể kết nối lại khi sẵn sàng.',
  FACEBOOK_PAGE_PERMISSION_DENIED:
    'Chưa được cấp đủ quyền cho Page. Kết nối lại và cho phép truy cập danh sách Page, tin nhắn và webhook.',
  FACEBOOK_PAGE_TOKEN_EXPIRED:
    'Quyền truy cập Facebook đã hết hạn. Vui lòng kết nối lại.',
  FACEBOOK_PAGE_NO_PAGES:
    'Không tìm thấy Page có quyền quản lý phù hợp. Kiểm tra tài khoản Facebook và các Page đã chọn khi cấp quyền.',
  OAUTH_FAILED:
    'Chưa hoàn tất kết nối Facebook. Kiểm tra cấu hình ứng dụng Meta và thử lại.',
};

export function FacebookPageConnectionPage() {
  const status = useFacebookPages();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const oauth = params.get('oauth') ?? params.get('error');
  const data = status.data;
  const connect = useMutation({
    mutationFn: async () => {
      const result = await api(
        '/channels/facebook-page/connect',
        z.object({ authorizationUrl: z.string().url() }),
      );
      const target = new URL(result.authorizationUrl);
      if (
        target.origin !== 'https://www.facebook.com' ||
        !/^\/v\d+\.\d+\/dialog\/oauth$/.test(target.pathname)
      )
        throw new Error(
          'Địa chỉ cấp quyền Facebook chưa hợp lệ. Vui lòng kiểm tra cấu hình máy chủ.',
        );
      window.location.assign(target.toString());
    },
  });
  const select = useMutation({
    mutationFn: (pageId: string) =>
      api('/channels/facebook-page/select', channelAccountSchema, {
        method: 'POST',
        body: JSON.stringify({ pageId }),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['facebook-page'] });
      void client.invalidateQueries({ queryKey: ['inbox-accounts'] });
    },
  });
  const selectionActive =
    Boolean(data?.availablePages.length) &&
    (!data?.selectionExpiresAt ||
      Date.parse(data.selectionExpiresAt) > status.dataUpdatedAt);
  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 lg:px-8 lg:py-8">
      <div className="mx-auto max-w-5xl">
        <Link
          to="/apps"
          className="text-xs text-muted-foreground hover:text-primary"
        >
          Ứng dụng / Messenger
        </Link>
        <div className="mb-7 mt-5 flex flex-wrap items-center gap-4">
          <ProviderMark provider="messenger" />
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">
              Facebook Page
            </h1>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
              Nhận và trả lời tin nhắn của các Page trong hộp thư easyChat.
            </p>
          </div>
          <Button
            className="w-full sm:w-auto"
            disabled={!data?.configured || connect.isPending}
            onClick={() => connect.mutate()}
          >
            <ExternalLink />
            {connect.isPending ? 'Đang mở Facebook…' : 'Kết nối Facebook Page'}
          </Button>
        </div>
        {status.isPending ? (
          <Loading label="Đang tải kết nối Facebook…" />
        ) : null}
        {status.error ? <ErrorNotice error={status.error} /> : null}
        {connect.error ? (
          <div className="mb-4">
            <ErrorNotice error={connect.error} />
          </div>
        ) : null}
        {oauth ? (
          <div
            role="status"
            className={cn(
              'mb-5 flex items-start justify-between gap-3 rounded-xl border p-4 text-xs leading-6',
              ['success', 'connected', 'select'].includes(oauth)
                ? 'border-teal-100 bg-teal-50 text-teal-900'
                : 'border-amber-200 bg-amber-50 text-amber-900',
            )}
          >
            <p>
              {['success', 'connected', 'select'].includes(oauth)
                ? 'Đã nhận kết quả cấp quyền. Chọn Page bên dưới để hoàn tất kết nối.'
                : (oauthMessages[oauth] ??
                  'Chưa hoàn tất cấp quyền Facebook. Vui lòng kết nối lại hoặc kiểm tra thiết lập ứng dụng Meta.')}
            </p>
            <button
              className="shrink-0 font-medium underline"
              onClick={() => {
                const next = new URLSearchParams(params);
                next.delete('oauth');
                next.delete('error');
                setParams(next, { replace: true });
              }}
            >
              Đóng
            </button>
          </div>
        ) : null}
        {data ? (
          <>
            {!data.configured ? (
              <Notice
                title="Cần cấu hình ứng dụng Meta"
                icon={<ShieldCheck className="size-4" />}
              >
                Quản trị viên cần thiết lập App ID, App Secret và URL callback
                trên máy chủ. Sau đó bạn có thể cấp quyền trực tiếp trên
                Facebook; easyChat không yêu cầu mật khẩu Facebook.
              </Notice>
            ) : null}
            {!data.webhookConfigured ? (
              <Notice
                title="Chưa sẵn sàng nhận tin nhắn mới"
                icon={<Webhook className="size-4" />}
              >
                Cần cấu hình và xác minh webhook HTTPS trong ứng dụng Meta. Lịch
                sử đã lưu vẫn có thể xem trong hộp thư.
              </Notice>
            ) : null}
            {!data.workerOnline ? (
              <Notice
                title="Bộ xử lý tin nhắn đang ngoại tuyến"
                icon={<Clock3 className="size-4" />}
              >
                Chạy worker cùng API để đồng bộ hội thoại, xử lý tin đến và gửi
                trả lời.
              </Notice>
            ) : null}
            {selectionActive ? (
              <section
                aria-label="Chọn Facebook Page"
                className="mb-7 rounded-2xl border border-violet-200 bg-white p-5"
              >
                <h2 className="text-base font-semibold">
                  Chọn Page muốn kết nối
                </h2>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  Chỉ các Page bạn đã cấp quyền quản lý mới xuất hiện. Mỗi Page
                  có tài khoản và hộp thư riêng.
                </p>
                {data.selectionExpiresAt ? (
                  <p className="mt-2 text-[10px] text-slate-500">
                    Lựa chọn có hiệu lực đến{' '}
                    {formatTime(data.selectionExpiresAt, true)}.
                  </p>
                ) : null}
                {select.error ? (
                  <div className="mt-4">
                    <ErrorNotice error={select.error} />
                  </div>
                ) : null}
                <div className="mt-4 divide-y rounded-xl border">
                  {data.availablePages.map((page) => {
                    const linked = data.accounts.some(
                      (account) =>
                        account.externalAccountId === page.id &&
                        account.connectionStatus === 'CONNECTED',
                    );
                    return (
                      <div
                        key={page.id}
                        className="flex items-center gap-3 p-3"
                      >
                        <Avatar name={page.name} url={page.avatarUrl} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {page.name}
                          </p>
                          <p className="mt-1 text-[10px] text-slate-500">
                            Page ID · {page.id}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant={linked ? 'outline' : 'default'}
                          disabled={select.isPending || linked}
                          onClick={() => select.mutate(page.id)}
                        >
                          {linked ? <Check /> : null}
                          {linked
                            ? 'Đã kết nối'
                            : select.isPending && select.variables === page.id
                              ? 'Đang kết nối…'
                              : 'Kết nối Page'}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : data.availablePages.length ? (
              <Notice
                title="Lựa chọn Page đã hết hạn"
                icon={<Clock3 className="size-4" />}
              >
                Bấm “Kết nối Facebook Page” để cấp quyền và chọn Page lại.
              </Notice>
            ) : null}
            <section aria-label="Facebook Page của bạn" className="mt-7">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-base font-semibold">Page của bạn</h2>
                <span className="text-xs text-muted-foreground">
                  {data.accounts.length} Page
                </span>
              </div>
              {data.accounts.length ? (
                <div className="space-y-4">
                  {data.accounts.map((account) => (
                    <FacebookPageAccount key={account.id} account={account} />
                  ))}
                </div>
              ) : (
                <Card className="border-dashed p-8 text-center">
                  <h3 className="text-sm font-semibold">
                    Chưa có Page được kết nối
                  </h3>
                  <p className="mx-auto mt-2 max-w-md text-xs leading-6 text-muted-foreground">
                    Cấp quyền bằng tài khoản Facebook có quyền quản lý Page rồi
                    chọn Page muốn đưa vào easyChat.
                  </p>
                </Card>
              )}
            </section>
            <div className="mt-7 grid gap-4 sm:grid-cols-2">
              <Card className="p-5">
                <h3 className="flex items-center gap-2 text-xs font-semibold">
                  <Clock3 className="size-4 text-primary" />
                  Thời gian trả lời 24 giờ
                </h3>
                <p className="mt-3 text-xs leading-6 text-muted-foreground">
                  Bạn có thể trả lời trong 24 giờ sau tin nhắn của khách hàng.
                  easyChat sẽ khóa ô gửi khi thời gian này kết thúc. Tin nhắn
                  mới từ khách hàng sẽ mở lại thời gian trả lời.
                </p>
              </Card>
              <Card className="p-5">
                <h3 className="text-xs font-semibold">
                  Messenger cá nhân là một kết nối riêng
                </h3>
                <p className="mt-3 text-xs leading-6 text-muted-foreground">
                  Quyền Facebook Page chỉ áp dụng cho tin nhắn của Page. Kết nối
                  tài khoản Messenger cá nhân hiện chưa được hỗ trợ.
                </p>
                <Link
                  to="/facebook/personal"
                  className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-primary"
                >
                  Xem khả năng hỗ trợ
                  <ArrowRight className="size-3.5" />
                </Link>
              </Card>
            </div>
            <p className="my-6 flex items-center justify-center gap-2 text-[10px] text-slate-500">
              <ShieldCheck className="size-3.5" />
              Quyền truy cập được lưu mã hóa trên máy chủ.
            </p>
          </>
        ) : null}
      </div>
    </main>
  );
}

function Notice({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-3 rounded-xl border border-amber-100 bg-amber-50/70 p-4 text-amber-900"
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div>
        <p className="text-xs font-semibold">{title}</p>
        <p className="mt-1 text-xs leading-6">{children}</p>
      </div>
    </div>
  );
}

function FacebookPageAccount({
  account,
}: {
  account: z.infer<typeof channelAccountSchema>;
}) {
  const client = useQueryClient();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const action = useMutation({
    mutationFn: async (kind: 'sync' | 'disconnect') =>
      kind === 'sync'
        ? api(
            `/channels/${encodeURIComponent(account.id)}/sync`,
            channelSyncResultSchema,
            { method: 'POST' },
          )
        : api(
            `/channels/${encodeURIComponent(account.id)}`,
            z.object({ disconnected: z.boolean() }),
            { method: 'DELETE' },
          ),
    onSuccess: () => {
      setConfirmDisconnect(false);
      for (const key of ['facebook-page', 'inbox-accounts', 'conversations'])
        void client.invalidateQueries({ queryKey: [key] });
    },
  });
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center gap-3">
        <Avatar
          name={account.name}
          url={account.avatarUrl}
          className="size-12"
        />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{account.name}</h3>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Facebook Page · {account.externalAccountId}
          </p>
        </div>
        <span
          className={cn(
            'rounded-full px-2.5 py-1 text-[10px] font-medium',
            account.connectionStatus === 'CONNECTED'
              ? 'bg-emerald-50 text-emerald-700'
              : 'bg-slate-100 text-slate-600',
          )}
        >
          {connectionLabel(account.connectionStatus)}
        </span>
      </div>
      <p className="mt-4 text-[11px] leading-5 text-muted-foreground">
        {account.lastSyncAt
          ? `Đồng bộ gần nhất: ${formatTime(account.lastSyncAt, true)}.`
          : 'Lịch sử hội thoại chưa được đồng bộ.'}
        {!account.syncComplete
          ? ' Có thể tiếp tục tải phần lịch sử mà Meta cho phép truy cập.'
          : ' Đã hoàn tất phần lịch sử mà Meta cho phép truy cập.'}
      </p>
      {account.lastSyncError ? (
        <p
          role="alert"
          className="mt-3 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900"
        >
          Chưa đồng bộ được lịch sử.{' '}
          {account.lastSyncError === 'FACEBOOK_PAGE_TOKEN_EXPIRED'
            ? 'Kết nối lại Page để cấp quyền mới.'
            : 'Kiểm tra quyền của Page và thử đồng bộ lại.'}
        </p>
      ) : null}
      {account.lastError ? (
        <p role="alert" className="mt-3 text-xs leading-5 text-amber-800">
          {account.connectionStatus === 'REAUTH_REQUIRED'
            ? 'Quyền truy cập đã hết hạn hoặc bị thu hồi. Bấm kết nối Facebook Page để cấp quyền lại.'
            : 'Kết nối cần được kiểm tra. Hãy thử cấp quyền Facebook Page lại.'}
        </p>
      ) : null}
      {action.error ? (
        <div className="mt-3">
          <ErrorNotice error={action.error} />
        </div>
      ) : null}
      {action.isSuccess && action.variables === 'sync' ? (
        <p role="status" className="mt-3 text-xs text-primary">
          Đã xếp lịch đồng bộ. Hội thoại sẽ xuất hiện trong hộp thư sau khi xử
          lý.
        </p>
      ) : null}
      {confirmDisconnect ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs leading-5 text-amber-900">
            Ngắt kết nối {account.name}? Tin nhắn đã lưu vẫn được giữ, quyền
            truy cập Page sẽ được xóa khỏi easyChat.
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={action.isPending}
              onClick={() => setConfirmDisconnect(false)}
            >
              Giữ kết nối
            </Button>
            <Button
              size="sm"
              disabled={action.isPending}
              onClick={() => action.mutate('disconnect')}
            >
              Xác nhận ngắt kết nối
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link
              to={`/inbox?account=${encodeURIComponent(`facebook-page:${account.id}`)}`}
            >
              Mở hộp thư
              <ArrowRight />
            </Link>
          </Button>
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
            <RefreshCw className={cn(action.isPending && 'animate-spin')} />
            {account.syncComplete ? 'Đồng bộ mới' : 'Tiếp tục đồng bộ'}
          </Button>
          {account.connectionStatus !== 'DISCONNECTED' ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={action.isPending}
              onClick={() => setConfirmDisconnect(true)}
            >
              <Unplug />
              Ngắt kết nối
            </Button>
          ) : null}
        </div>
      )}
    </Card>
  );
}
