import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { connectionSchema } from '@zalo/shared';
import {
  ArrowRight,
  Check,
  ExternalLink,
  Link2,
  LockKeyhole,
  MessageSquareText,
  RefreshCw,
  Unplug,
  Webhook,
} from 'lucide-react';
import { useConnection } from '@/features/zalo/queries';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Avatar } from '@/components/avatar';
import { ErrorNotice, Loading } from '@/components/feedback';
import { formatTime } from '@/lib/utils';
const oauthMessages: Record<string, string> = {
  INVALID_OAUTH_STATE: 'Yêu cầu kết nối đã hết hạn. Vui lòng kết nối lại.',
  OAUTH_SESSION_EXPIRED:
    'Phiên quản trị đã hết hạn. Vui lòng đăng nhập và kết nối lại.',
  OAUTH_DENIED: 'Bạn đã hủy cấp quyền. Có thể kết nối lại khi sẵn sàng.',
  OA_MISMATCH: 'OA được chọn chưa khớp với yêu cầu kết nối. Vui lòng thử lại.',
  ZALO_PERMISSION_DENIED:
    'Cấp quyền thông tin OA và tin nhắn trong Zalo Developers rồi kết nối lại.',
  OAUTH_FAILED:
    'Chưa hoàn tất cấp quyền Zalo. Vui lòng kiểm tra thiết lập ứng dụng và thử lại.',
};
export function ConnectionPage() {
  const status = useConnection();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const connect = useMutation({
    mutationFn: async () => {
      const result = await api(
        '/zalo/connect',
        z.object({ authorizationUrl: z.string().url() }),
      );
      const target = new URL(result.authorizationUrl);
      if (target.origin !== 'https://oauth.zaloapp.com')
        throw new Error('Địa chỉ cấp quyền chưa hợp lệ.');
      window.location.assign(target.toString());
    },
  });
  const disconnect = useMutation({
    mutationFn: () =>
      api('/zalo/connection', z.object({ disconnected: z.boolean() }), {
        method: 'DELETE',
      }),
    onSuccess: () => {
      setConfirmDisconnect(false);
      void client.invalidateQueries({ queryKey: ['connection'] });
      void client.invalidateQueries({ queryKey: ['inbox-accounts'] });
      void client.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
  const refresh = useMutation({
    mutationFn: () => api('/zalo/profile', connectionSchema),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['inbox-accounts'] });
      return client.invalidateQueries({ queryKey: ['connection'] });
    },
  });
  const conn = status.data?.connection;
  const connected = conn?.status === 'CONNECTED';
  const oauth = params.get('oauth');
  return (
    <main className="mx-auto min-h-0 w-full max-w-5xl flex-1 overflow-y-auto px-5 py-8 md:px-10 md:py-10">
      <div className="mb-8 flex items-start justify-between">
        <div>
          <Link
            to="/apps"
            className="mb-5 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-primary"
          >
            ← Tất cả ứng dụng
          </Link>
          <p className="eyebrow">Zalo · Official Account</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            Zalo Official Account
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Kết nối OA để theo dõi các cuộc trò chuyện với khách hàng.
          </p>
        </div>
        <Badge
          className={
            connected
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'border-border bg-white text-muted-foreground'
          }
        >
          <span
            className={`size-1.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-slate-400'}`}
          />
          {connected ? 'Đang kết nối' : 'Chưa kết nối'}
        </Badge>
      </div>
      {oauth ? (
        <div className="mb-5 flex items-start gap-3">
          <div className="flex-1">
            {oauth === 'connected' ? (
              <div
                role="status"
                className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"
              >
                Official Account của bạn đã được kết nối.
              </div>
            ) : (
              <ErrorNotice
                error={
                  new Error(
                    oauthMessages[oauth] ??
                      'Chưa cấp quyền được cho Zalo. Kiểm tra cấu hình ứng dụng và kết nối lại.',
                  )
                }
              />
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={() => setParams({})}>
            Đóng thông báo
          </Button>
        </div>
      ) : null}
      {status.isPending ? (
        <Loading label="Đang kiểm tra kết nối…" />
      ) : status.error ? (
        <ErrorNotice error={status.error} />
      ) : (
        <>
          <Card className="overflow-hidden">
            <div className="grid gap-8 bg-[#f1f5fb] p-7 sm:grid-cols-[1fr_auto] md:p-9">
              <div>
                <Badge className="border-blue-200 bg-white/80 text-primary">
                  <span className="text-sm font-bold">Z</span>Official Account
                </Badge>
                <h2 className="mt-6 text-3xl font-medium leading-tight tracking-tight">
                  Kết nối OA.
                  <br />
                  Theo dõi khách hàng.
                </h2>
                <p className="mt-4 max-w-md text-sm leading-6 text-muted-foreground">
                  Theo dõi tin nhắn đến và các phản hồi đã gửi từ Zalo OA
                  Manager trong cùng một hộp thư.
                </p>
              </div>
              <div className="hidden items-center sm:flex" aria-hidden="true">
                <div className="connection-art">
                  <div className="art-bubble">
                    <MessageSquareText className="size-9 text-primary" />
                  </div>
                  <span className="art-dot" />
                  <div className="art-inbox">
                    <Link2 className="size-7 text-slate-500" />
                  </div>
                </div>
              </div>
            </div>
            <div className="p-7 md:p-9">
              {conn ? (
                <div className="mb-7 flex flex-wrap items-center gap-4">
                  <Avatar
                    key={conn.avatarUrl}
                    name={conn.oaName}
                    url={conn.avatarUrl}
                    className="size-14 rounded-xl"
                  />
                  <div className="min-w-0">
                    <h3 className="font-semibold">{conn.oaName}</h3>
                    <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                      OA ID · {conn.oaId}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Hạn phiên truy cập:{' '}
                      {formatTime(conn.tokenExpiresAt, true)}
                    </p>
                  </div>
                </div>
              ) : null}
              {conn?.status === 'REAUTH_REQUIRED' ? (
                <div className="mb-5">
                  <ErrorNotice
                    error={
                      new Error(
                        'Quyền truy cập đã hết hạn. Vui lòng kết nối lại Official Account.',
                      )
                    }
                  />
                </div>
              ) : null}
              {!status.data?.configured ? (
                <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
                  Tích hợp Zalo OA chưa được cấu hình. Quản trị viên cần bổ sung
                  App ID và App Secret trên máy chủ.
                </div>
              ) : null}
              {status.data?.configured && !status.data.webhookConfigured ? (
                <div
                  role="status"
                  className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900"
                >
                  Bạn có thể kết nối OA. Để nhận tin nhắn mới, quản trị viên cần
                  hoàn tất cấu hình khóa ký và địa chỉ webhook công khai.
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                {connected ? (
                  <>
                    <Button asChild>
                      <Link to="/inbox">
                        Mở hộp thư
                        <ArrowRight />
                      </Link>
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => refresh.mutate()}
                      disabled={refresh.isPending}
                    >
                      <RefreshCw
                        className={refresh.isPending ? 'animate-spin' : ''}
                      />
                      Cập nhật thông tin
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setConfirmDisconnect(true)}
                      className="sm:ml-auto"
                    >
                      <Unplug />
                      Ngắt kết nối
                    </Button>
                  </>
                ) : (
                  <Button
                    onClick={() => connect.mutate()}
                    disabled={!status.data?.configured || connect.isPending}
                  >
                    <Link2 />
                    {connect.isPending
                      ? 'Đang mở Zalo…'
                      : 'Kết nối Zalo Official Account'}
                    <ArrowRight />
                  </Button>
                )}
              </div>
              {confirmDisconnect ? (
                <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4">
                  <p className="text-sm text-amber-900">
                    Ngắt kết nối tài khoản này? Bạn vẫn xem được lịch sử. Để
                    nhận tin mới, cần kết nối lại OA.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={disconnect.isPending}
                      onClick={() => disconnect.mutate()}
                    >
                      {disconnect.isPending
                        ? 'Đang ngắt kết nối…'
                        : 'Ngắt kết nối tài khoản'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmDisconnect(false)}
                    >
                      Hủy
                    </Button>
                  </div>
                </div>
              ) : null}
              {connect.error || disconnect.error || refresh.error ? (
                <div className="mt-5">
                  <ErrorNotice
                    error={connect.error ?? disconnect.error ?? refresh.error}
                  />
                </div>
              ) : null}
              <div className="mt-6 flex items-center gap-2 border-t pt-5 text-xs text-muted-foreground">
                <LockKeyhole className="size-3.5 shrink-0" />
                Bạn cấp quyền trên Zalo. Phiên kết nối được bảo vệ trên máy chủ.
              </div>
            </div>
          </Card>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            {[
              {
                icon: Link2,
                title: 'Cấp quyền kết nối',
                text: 'Quản trị viên OA xác nhận quyền truy cập trực tiếp trên Zalo.',
              },
              {
                icon: Webhook,
                title: 'Nhận tin nhắn mới',
                text: 'Hội thoại mới xuất hiện sau khi webhook được thiết lập.',
              },
              {
                icon: Check,
                title: 'Theo dõi hội thoại',
                text: 'Đọc tin đến và phản hồi đã gửi từ Zalo OA Manager.',
              },
            ].map(({ icon: Icon, title, text }, i) => (
              <div
                key={title}
                className="rounded-xl border border-border bg-white p-5"
              >
                <div className="mb-4 flex items-center justify-between">
                  <Icon className="size-5 text-slate-500" />
                  <span className="font-mono text-xs text-slate-300">
                    0{i + 1}
                  </span>
                </div>
                <h3 className="text-sm font-medium">{title}</h3>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {text}
                </p>
              </div>
            ))}
          </div>
          {Boolean(status.data?.failedWebhookCount) && (
            <WebhookFailures count={status.data!.failedWebhookCount} />
          )}
          <div className="mt-8 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
            <p>
              Tin nhắn mới được nhận sau khi kết nối. Lịch sử trước đó phụ thuộc
              vào quyền của Zalo.
            </p>
            <a
              href="https://developers.zalo.me/docs"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              Tài liệu Zalo
              <ExternalLink className="size-3" />
            </a>
          </div>
        </>
      )}
    </main>
  );
}
function WebhookFailures({ count }: { count: number }) {
  const client = useQueryClient();
  const retry = useMutation({
    mutationFn: async () => {
      const events = await api(
        '/zalo/webhook-events/failed',
        z.array(z.object({ id: z.string() })),
      );
      let failed = 0;
      for (const event of events) {
        try {
          await api(
            `/zalo/webhook-events/${event.id}/retry`,
            z.object({ received: z.boolean() }),
            { method: 'POST' },
          );
        } catch {
          failed++;
        }
      }
      if (failed)
        throw new Error(
          `Còn ${failed} sự kiện chưa xử lý được. Vui lòng kiểm tra cấu hình kết nối.`,
        );
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['inbox-accounts'] });
      return client.invalidateQueries({ queryKey: ['connection'] });
    },
  });
  return (
    <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5">
      <p className="text-sm text-amber-900">
        {count} sự kiện cần xử lý lại. Vui lòng kiểm tra cấu hình kết nối rồi
        thử lại.
      </p>
      <Button
        variant="outline"
        size="sm"
        className="mt-3"
        onClick={() => retry.mutate()}
        disabled={retry.isPending}
      >
        {retry.isPending
          ? 'Đang thử lại…'
          : 'Thử xử lý lại (tối đa 50 sự kiện)'}
      </Button>
      {retry.error ? (
        <div className="mt-3">
          <ErrorNotice error={retry.error} />
        </div>
      ) : null}
    </div>
  );
}
