import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams, Link } from 'react-router-dom';
import { z } from 'zod';
import {
  tiktokStatusSchema,
  channelSyncResultSchema,
  type TikTokStatus,
} from '@zalo/shared';
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  Link2,
  RefreshCw,
  ShieldCheck,
  Unplug,
  AlertCircle,
} from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { connectionLabel, sendBlockedMessage } from '@/lib/channels';
import { Avatar } from '@/components/avatar';
import { ProviderMark } from '@/components/provider-mark';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Loading, ErrorNotice } from '@/components/feedback';
import { formatTime } from '@/lib/utils';
export function TikTokBusinessConnectionPage() {
  return <TikTokConnectionPage provider="tiktok-business" />;
}
export function TikTokShopConnectionPage() {
  return <TikTokConnectionPage provider="tiktok-shop" />;
}
export function trustedTikTokAuthorizationUrl(
  value: string,
  provider: 'tiktok-business' | 'tiktok-shop',
) {
  const url = new URL(value);
  const valid =
    provider === 'tiktok-business'
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
    throw new Error('URL cấp quyền TikTok chưa hợp lệ. Hãy thử kết nối lại.');
  return url.href;
}
function TikTokConnectionPage({
  provider,
}: {
  provider: 'tiktok-business' | 'tiktok-shop';
}) {
  const isShop = provider === 'tiktok-shop';
  const name = isShop ? 'TikTok Shop' : 'TikTok Business';
  const client = useQueryClient();
  const [params] = useSearchParams();
  const data = useQuery({
    queryKey: ['tiktok', provider],
    queryFn: () => api(`/channels/${provider}`, tiktokStatusSchema),
    refetchInterval: 5000,
  });
  function refresh() {
    for (const key of ['tiktok', 'inbox-accounts', 'conversations'])
      void client.invalidateQueries({ queryKey: [key] });
  }
  const connect = useMutation({
    mutationFn: async () => {
      const result = await api(
        `/channels/${provider}/connect`,
        z.object({ authorizationUrl: z.string() }),
        { method: 'POST' },
      );
      window.location.assign(
        trustedTikTokAuthorizationUrl(result.authorizationUrl, provider),
      );
    },
  });
  const choose = useMutation({
    mutationFn: (externalAccountId: string) =>
      api(
        `/channels/${provider}/select`,
        tiktokStatusSchema.shape.accounts.element,
        {
          method: 'POST',
          body: JSON.stringify({
            authorizationId: data.data?.selection?.id,
            externalAccountId,
          }),
        },
      ),
    onSuccess: refresh,
  });
  const callbackError = params.get('error');
  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <Link
          to="/apps"
          className="text-xs text-muted-foreground hover:text-primary"
        >
          Ứng dụng / {name}
        </Link>
        <div className="mb-6 mt-5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <ProviderMark provider={provider} />
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {isShop
                  ? 'Chăm sóc khách hàng mua sắm trong cùng hộp thư.'
                  : 'Theo dõi và trả lời tin nhắn tài khoản Business.'}
              </p>
            </div>
          </div>
          <Button
            className="w-full sm:w-auto"
            disabled={!data.data?.configured || connect.isPending}
            onClick={() => connect.mutate()}
          >
            <Link2 />
            {connect.isPending ? 'Đang mở TikTok…' : `Kết nối ${name}`}
          </Button>
        </div>
        {data.isPending ? (
          <Loading label="Đang tải trạng thái TikTok…" />
        ) : data.error ? (
          <ErrorNotice error={data.error} />
        ) : null}
        {connect.error ? (
          <div className="mb-4">
            <ErrorNotice error={connect.error} />
          </div>
        ) : null}
        {callbackError ? (
          <div
            role="alert"
            className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900"
          >
            Chưa hoàn tất cấp quyền. {sendBlockedMessage(callbackError)}
          </div>
        ) : null}
        {data.data ? (
          <>
            {!data.data.enabled || !data.data.configured ? (
              <Card className="mb-5 flex items-start gap-3 p-5">
                <AlertCircle className="mt-0.5 size-5 shrink-0 text-amber-600" />
                <div>
                  <h2 className="text-sm font-semibold">
                    {!data.data.enabled
                      ? 'Kênh đang tắt'
                      : 'Chưa cấu hình ứng dụng TikTok'}
                  </h2>
                  <p className="mt-2 text-xs leading-6 text-muted-foreground">
                    Quản trị viên cần bổ sung thông tin ứng dụng và URL cấp
                    quyền chính thức ở máy chủ. TikTok cần duyệt quyền{' '}
                    {isShop ? 'Customer Service' : 'Business Messaging'} trước
                    khi tài khoản có thể đồng bộ và trả lời.
                  </p>
                </div>
              </Card>
            ) : null}
            {!data.data.workerOnline ? (
              <p
                role="status"
                className="mb-5 rounded-xl bg-amber-50 p-4 text-xs leading-6 text-amber-900"
              >
                Bộ xử lý tin nhắn đang ngoại tuyến. Khởi động worker để đồng bộ
                và trả lời sau khi kết nối.
              </p>
            ) : null}
            {data.data.selection ? (
              <Card className="mb-6 p-5">
                <h2 className="text-base font-semibold">
                  Chọn {isShop ? 'shop' : 'tài khoản'} đã cấp quyền
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Chỉ những tài khoản được TikTok xác nhận mới xuất hiện ở đây.
                  Hết hạn lúc {formatTime(data.data.selection.expiresAt)}.
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {data.data.selection.accounts.map((account) => (
                    <div
                      key={account.id}
                      className="flex min-w-0 items-center gap-3 rounded-xl border p-3"
                    >
                      <Avatar name={account.name} url={account.avatarUrl} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {account.name}
                        </p>
                        <p className="truncate text-[10px] text-muted-foreground">
                          {account.region ? `${account.region} · ` : ''}
                          {account.id}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        disabled={choose.isPending}
                        onClick={() => choose.mutate(account.id)}
                      >
                        Kết nối
                      </Button>
                    </div>
                  ))}
                </div>
                {choose.error ? (
                  <div className="mt-4">
                    <ErrorNotice error={choose.error} />
                  </div>
                ) : null}
              </Card>
            ) : null}
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">Tài khoản của bạn</h2>
              <span className="text-xs text-muted-foreground">
                {data.data.accounts.length} tài khoản
              </span>
            </div>
            <div className="grid min-w-0 gap-4">
              {data.data.accounts.map((account) => (
                <TikTokAccount
                  key={account.id}
                  account={account}
                  provider={provider}
                  refresh={refresh}
                />
              ))}
              {!data.data.accounts.length ? (
                <Card className="grid justify-items-center gap-3 px-5 py-10 text-center">
                  <Clock3 className="size-7 text-muted-foreground" />
                  <h3 className="text-sm font-semibold">Chưa kết nối {name}</h3>
                  <p className="max-w-md text-xs leading-6 text-muted-foreground">
                    Sau khi ứng dụng được duyệt quyền, kết nối và chọn đúng{' '}
                    {isShop ? 'shop của bạn' : 'tài khoản Business'} để bắt đầu.
                    Các tin nhắn đã lưu của kênh khác vẫn ở trong hộp thư chung.
                  </p>
                </Card>
              ) : null}
            </div>
            <Card className="mt-6 p-5">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <ShieldCheck className="size-4" />
                Quyền và phạm vi đồng bộ
              </div>
              <p className="mt-2 text-xs leading-6 text-muted-foreground">
                {data.data.approvalStatus === 'VERIFIED'
                  ? 'Quyền đã được kiểm tra khi kết nối tài khoản.'
                  : 'Quyền ứng dụng chưa được xác minh qua tài khoản đã kết nối.'}{' '}
                Token được giữ tại máy chủ; easyChat không yêu cầu mật khẩu
                TikTok.
              </p>
              <ul className="mt-3 space-y-2 text-xs leading-6 text-muted-foreground">
                {data.data.restrictions.map((text) => (
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
function TikTokAccount({
  account,
  provider,
  refresh,
}: {
  account: TikTokStatus['accounts'][number];
  provider: 'tiktok-business' | 'tiktok-shop';
  refresh: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const action = useMutation({
    mutationFn: async (kind: 'sync' | 'disconnect'): Promise<unknown> =>
      kind === 'sync'
        ? api(`/channels/${account.id}/sync`, channelSyncResultSchema, {
            method: 'POST',
          })
        : api(
            `/channels/${account.id}`,
            z.object({ disconnected: z.boolean() }),
            { method: 'DELETE' },
          ),
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
            {provider === 'tiktok-shop' ? 'TikTok Shop' : 'TikTok Business'} ·{' '}
            {account.externalAccountId}
          </p>
        </div>
        <span className="rounded-full bg-slate-50 px-3 py-1.5 text-[10px] font-medium">
          {connectionLabel(account.connectionStatus)}
        </span>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {[
          ['receiveMessages', 'Nhận tin'],
          ['sendMessages', 'Trả lời'],
          ['syncConversations', 'Đồng bộ'],
          ['readReceipts', 'Trạng thái xem'],
        ].map(([key, label]) => (
          <span
            key={key}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] ${account.capabilities[key as keyof typeof account.capabilities] ? 'bg-teal-50 text-teal-700' : 'bg-slate-50 text-slate-500'}`}
          >
            {account.capabilities[key as keyof typeof account.capabilities] ? (
              <CheckCircle2 className="size-3" />
            ) : (
              <Clock3 className="size-3" />
            )}
            {label}
            {account.capabilities[key as keyof typeof account.capabilities]
              ? ''
              : ' · chưa có quyền/dữ liệu'}
          </span>
        ))}
      </div>
      <p className="mt-4 text-xs leading-6 text-muted-foreground">
        {account.lastSyncAt
          ? `Đồng bộ gần nhất: ${formatTime(account.lastSyncAt, true)}.`
          : 'Chưa đồng bộ lịch sử.'}{' '}
        {account.syncComplete
          ? 'Đã tải phần dữ liệu API cho phép trong lượt này.'
          : 'Đồng bộ có thể tiếp tục từ phần đã lưu.'}
      </p>
      {account.lastError || account.lastSyncError ? (
        <p
          role="alert"
          className="mt-3 rounded-xl bg-amber-50 p-3 text-xs leading-6 text-amber-900"
        >
          {sendBlockedMessage(account.lastError ?? account.lastSyncError)}
        </p>
      ) : null}
      {action.error ? (
        <div className="mt-3">
          <ErrorNotice error={action.error} />
        </div>
      ) : null}
      {action.isSuccess && action.variables === 'sync' ? (
        <p role="status" className="mt-3 text-xs text-primary">
          Đã xếp lịch đồng bộ. Hộp thư sẽ cập nhật sau khi xử lý.
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" asChild>
          <Link
            to={`/inbox?account=${encodeURIComponent(provider + ':' + account.id)}`}
          >
            Mở hộp thư
            <ArrowRight />
          </Link>
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={
            action.isPending ||
            !account.workerOnline ||
            account.connectionStatus !== 'CONNECTED' ||
            !account.capabilities.syncConversations
          }
          onClick={() => action.mutate('sync')}
        >
          <RefreshCw />
          Đồng bộ
        </Button>
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
      {confirm ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs leading-6">
            Ngắt kết nối {account.name}? Thông tin xác thực sẽ được xóa khỏi
            easyChat; lịch sử đã lưu vẫn được giữ.
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
