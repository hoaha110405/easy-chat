import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { personalAccountSchema, type PersonalAccount } from '@zalo/shared';
import {
  Smartphone,
  QrCode,
  RefreshCw,
  Unplug,
  ArrowRight,
} from 'lucide-react';
import { api } from '@/lib/api';
import { usePersonalAccounts } from '@/features/zalo-personal/queries';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ErrorNotice, Loading } from '@/components/feedback';
import { Avatar } from '@/components/avatar';
const statusText: Record<PersonalAccount['connectionStatus'], string> = {
  DISCONNECTED: 'Chưa kết nối',
  QR_PENDING: 'Chờ quét mã QR',
  CONNECTING: 'Chờ xác nhận trên điện thoại',
  CONNECTED: 'Đang kết nối',
  RECONNECTING: 'Đang kết nối lại',
  REAUTH_REQUIRED: 'Cần đăng nhập lại',
  ERROR: 'Cần kiểm tra kết nối',
};
const errors: Record<string, string> = {
  ZALO_QR_EXPIRED: 'Mã QR đã hết hạn. Vui lòng lấy mã mới.',
  ZALO_QR_DECLINED: 'Yêu cầu đăng nhập đã bị từ chối. Bạn có thể thử lại.',
  ZALO_SESSION_EXPIRED: 'Phiên đăng nhập đã hết hạn. Vui lòng quét mã QR mới.',
  ZALO_LOGIN_FAILED: 'Chưa đăng nhập được vào Zalo. Vui lòng thử lại.',
  ZALO_CONNECTION_LOST:
    'Kết nối đã bị gián đoạn. Đăng nhập Zalo Web ở nơi khác có thể làm ngắt phiên này.',
  ZALO_ACCOUNT_MISMATCH:
    'Kênh này đã gắn với một tài khoản Zalo khác. Quét bằng tài khoản cũ hoặc thêm một kênh mới.',
  ZALO_INBOUND_PERSISTENCE_FAILED:
    'Chưa lưu được tin nhắn. Vui lòng kiểm tra dịch vụ đồng bộ trước khi kết nối lại.',
};
export function PersonalConnectionPage() {
  const query = usePersonalAccounts();
  const client = useQueryClient();
  const add = useMutation({
    mutationFn: async () => {
      const account = await api(
        '/channels/zalo-personal',
        personalAccountSchema,
        { method: 'POST', body: JSON.stringify({ name: 'Zalo cá nhân' }) },
      );
      await client.invalidateQueries({ queryKey: ['personal-accounts'] });
      return api(`/channels/${account.id}/login/qr`, personalAccountSchema, {
        method: 'POST',
      });
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['inbox-accounts'] });
      return client.invalidateQueries({ queryKey: ['personal-accounts'] });
    },
  });
  return (
    <main className="mx-auto min-h-0 w-full max-w-5xl flex-1 overflow-y-auto px-5 py-8 md:px-10">
      <Link
        to="/apps"
        className="mb-5 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-primary"
      >
        ← Tất cả ứng dụng
      </Link>
      <p className="eyebrow">Zalo · Tài khoản cá nhân</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        Zalo cá nhân
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Quét mã QR bằng Zalo trên điện thoại để nhận và trả lời tin nhắn tại
        easyChat.
      </p>
      <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
        Kết nối cá nhân sử dụng thư viện không chính thức. Zalo có thể hạn chế
        tài khoản; mỗi tài khoản chỉ giữ được một phiên Zalo Web hoạt động.
      </div>
      {query.isPending ? (
        <Loading label="Đang tải tài khoản…" />
      ) : query.error ? (
        <div className="mt-5">
          <ErrorNotice error={query.error} />
        </div>
      ) : (
        <>
          {!query.data?.enabled ? (
            <div className="mt-5">
              <ErrorNotice
                error={
                  new Error(
                    'Kết nối Zalo cá nhân đang được tắt. Liên hệ quản trị viên để bật tính năng này.',
                  )
                }
              />
            </div>
          ) : !query.data.workerOnline ? (
            <div
              role="status"
              className="mt-5 rounded-lg border bg-white p-4 text-sm"
            >
              Dịch vụ đồng bộ đang tạm dừng. Chạy <code>pnpm dev:worker</code>,
              hoặc dùng <code>pnpm dev</code> để khởi động đầy đủ dịch vụ.
            </div>
          ) : null}
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <Badge className="border-slate-200 bg-white">
              <Smartphone className="size-3" />
              {query.data?.accounts.length ?? 0} tài khoản cá nhân
            </Badge>
            <Button
              disabled={
                !query.data?.enabled ||
                !query.data.workerOnline ||
                add.isPending ||
                (query.data?.accounts.length ?? 0) >= 5
              }
              onClick={() => add.mutate()}
            >
              <QrCode />
              {add.isPending ? 'Đang tạo mã QR…' : 'Thêm tài khoản'}
            </Button>
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Tối đa 5 tài khoản. Mỗi tài khoản có mã QR và phiên kết nối riêng.
          </p>
          {add.error ? (
            <div className="mt-4">
              <ErrorNotice error={add.error} />
            </div>
          ) : null}
          <div className="mt-6 grid gap-5 xl:grid-cols-2">
            {query.data?.accounts.map((account) => (
              <AccountCard key={account.id} account={account} />
            ))}
          </div>
          {query.data?.accounts.length === 0 ? (
            <Card className="mt-6 p-10 text-center">
              <Smartphone className="mx-auto mb-4 size-8 text-slate-400" />
              <h2 className="font-medium">Kết nối tài khoản đầu tiên</h2>
              <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-muted-foreground">
                Mở Zalo trên điện thoại, quét mã QR rồi xác nhận đăng nhập.
                Phiên kết nối được mã hóa và lưu trên máy chủ.
              </p>
            </Card>
          ) : null}
        </>
      )}
      <p className="mt-7 text-xs leading-5 text-muted-foreground">
        Tin nhắn mới được cập nhật khi tài khoản đang kết nối. Lịch sử đầy đủ và
        tin nhắn nhóm chưa được đồng bộ.
      </p>
    </main>
  );
}
function AccountCard({ account }: { account: PersonalAccount }) {
  const client = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const action = useMutation({
    mutationFn: (kind: 'qr' | 'cancel' | 'disconnect') =>
      api(
        `/channels/${account.id}${kind === 'qr' ? '/login/qr' : kind === 'cancel' ? '/login/cancel' : ''}`,
        personalAccountSchema,
        { method: kind === 'disconnect' ? 'DELETE' : 'POST' },
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['inbox-accounts'] });
      void client.invalidateQueries({ queryKey: ['conversations'] });
      return client.invalidateQueries({ queryKey: ['personal-accounts'] });
    },
  });
  const active = ['QR_PENDING', 'CONNECTING'].includes(
    account.connectionStatus,
  );
  const seconds = account.qrExpiresAt
    ? Math.max(
        0,
        Math.ceil((new Date(account.qrExpiresAt).getTime() - now) / 1000),
      )
    : 0;
  return (
    <Card className="rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar
            name={account.name}
            url={account.avatarUrl}
            label={`Ảnh tài khoản ${account.name}`}
          />
          <div className="min-w-0">
            <h2 className="font-semibold">{account.name}</h2>
            {account.externalAccountId ? (
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                Zalo ID · {account.externalAccountId}
              </p>
            ) : null}
          </div>
        </div>
        <Badge
          className={
            account.connectionStatus === 'CONNECTED'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'bg-slate-50'
          }
        >
          {statusText[account.connectionStatus]}
        </Badge>
      </div>
      {active ? (
        <div className="mt-6 flex flex-col items-center rounded-xl border bg-slate-50 p-6 text-center">
          {account.qrStatus === 'SCANNED' ? (
            <>
              <Smartphone className="mb-3 size-10 text-primary" />
              <p className="font-medium">
                Đã quét mã QR. Hãy xác nhận đăng nhập trên điện thoại.
              </p>
            </>
          ) : seconds === 0 ? (
            <p className="text-sm text-amber-800">
              Mã QR đã hết hạn. Vui lòng lấy mã mới.
            </p>
          ) : account.qrImage &&
            /^data:image\/png;base64,/.test(account.qrImage) ? (
            <>
              <img
                src={account.qrImage}
                alt="Quét mã QR bằng ứng dụng Zalo"
                className="size-60 max-w-full rounded-lg bg-white p-3"
              />
              <p className="mt-4 text-sm">Quét mã bằng Zalo trên điện thoại</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Mã hết hạn sau {seconds} giây
              </p>
            </>
          ) : (
            <Loading label="Đang tạo mã QR…" />
          )}
          <div className="mt-4 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={action.isPending}
              onClick={() => action.mutate('cancel')}
            >
              Hủy đăng nhập
            </Button>
            {seconds === 0 ? (
              <Button
                size="sm"
                disabled={action.isPending || !account.workerOnline}
                onClick={() => action.mutate('qr')}
              >
                Lấy mã mới
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {account.lastError ? (
        <div className="mt-4">
          <ErrorNotice
            error={
              new Error(
                errors[account.lastError] ??
                  `Lỗi kết nối: ${account.lastError}`,
              )
            }
          />
        </div>
      ) : null}
      {action.error ? (
        <div className="mt-4">
          <ErrorNotice error={action.error} />
        </div>
      ) : null}
      <div className="mt-5 flex flex-wrap gap-3">
        {account.connectionStatus === 'CONNECTED' ? (
          <>
            <Button asChild>
              <Link
                to={`/inbox?account=${encodeURIComponent(`personal:${account.id}`)}`}
              >
                Mở hộp thư
                <ArrowRight />
              </Link>
            </Button>
            <Button
              variant="outline"
              disabled={action.isPending}
              onClick={() => action.mutate('disconnect')}
            >
              <Unplug />
              Ngắt kết nối
            </Button>
          </>
        ) : !active ? (
          <>
            <Button
              disabled={action.isPending || !account.workerOnline}
              onClick={() => action.mutate('qr')}
            >
              <RefreshCw />
              Kết nối bằng QR
            </Button>
            {account.connectionStatus !== 'DISCONNECTED' ? (
              <Button
                variant="outline"
                disabled={action.isPending}
                onClick={() => action.mutate('disconnect')}
              >
                Ngắt kết nối
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
    </Card>
  );
}
