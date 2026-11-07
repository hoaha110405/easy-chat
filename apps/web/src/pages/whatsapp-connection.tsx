import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { z } from 'zod';
import {
  whatsappStatusSchema,
  whatsappAccountSchema,
  whatsappBeginSchema,
  whatsappPhonesSchema,
  channelSyncResultSchema,
  type WhatsAppStatus,
} from '@zalo/shared';
import { ArrowRight, RefreshCw, Unplug, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { connectionLabel, sendBlockedMessage } from '@/lib/channels';
import {
  loadWhatsAppSignup,
  launchWhatsAppSignup,
} from '@/lib/whatsapp-signup';
import { ProviderMark } from '@/components/provider-mark';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loading, ErrorNotice } from '@/components/feedback';
import { formatTime } from '@/lib/utils';
export function WhatsAppConnectionPage() {
  const client = useQueryClient();
  const status = useQuery({
    queryKey: ['whatsapp'],
    queryFn: () => api('/channels/whatsapp', whatsappStatusSchema),
    refetchInterval: 5000,
  });
  const [wabaId, setWaba] = useState(''),
    [phoneId, setPhone] = useState(''),
    [token, setToken] = useState(''),
    [pin, setPin] = useState(''),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(null),
    [signup, setSignup] = useState<z.infer<typeof whatsappBeginSchema> | null>(
      null,
    );
  const refresh = () => {
    for (const key of ['whatsapp', 'inbox-accounts', 'conversations'])
      void client.invalidateQueries({ queryKey: [key] });
  };
  async function direct(event: FormEvent) {
    event.preventDefault();
    const value = {
      wabaId,
      phoneNumberId: phoneId,
      accessToken: token,
      ...(pin ? { pin } : {}),
    };
    setToken('');
    setPin('');
    setPending(true);
    setError(null);
    try {
      await api('/channels/whatsapp/connect', whatsappAccountSchema, {
        method: 'POST',
        body: JSON.stringify(value),
      });
      refresh();
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }
  async function prepare() {
    setPending(true);
    setError(null);
    try {
      const data = await api(
        '/channels/whatsapp/embedded/begin',
        whatsappBeginSchema,
        { method: 'POST' },
      );
      await loadWhatsAppSignup(data.appId, data.graphVersion);
      setSignup(data);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }
  function launch() {
    if (!signup) return;
    setPending(true);
    setError(null);
    const current = signup;
    setSignup(null);
    void launchWhatsAppSignup(current.configId, (a) => {
      if (a.wabaId) setWaba(a.wabaId);
      if (a.phoneNumberId) setPhone(a.phoneNumberId);
    })
      .then((code) =>
        api(
          '/channels/whatsapp/embedded/complete',
          z.object({ authorizationId: z.string() }),
          {
            method: 'POST',
            body: JSON.stringify({
              authorizationId: current.authorizationId,
              state: current.state,
              code,
            }),
          },
        ),
      )
      .then(refresh)
      .catch(setError)
      .finally(() => setPending(false));
  }
  const selection = status.data?.selection;
  const phones = useQuery({
    queryKey: ['whatsapp-phones', selection?.id, wabaId],
    enabled: Boolean(selection && /^\d{1,30}$/.test(wabaId)),
    retry: false,
    queryFn: () =>
      api(
        `/channels/whatsapp/embedded/${selection!.id}/phones?wabaId=${encodeURIComponent(wabaId)}`,
        whatsappPhonesSchema,
      ),
  });
  async function select(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const body = {
      authorizationId: selection!.id,
      wabaId,
      phoneNumberId: phoneId,
      ...(pin ? { pin } : {}),
    };
    setPin('');
    try {
      await api('/channels/whatsapp/embedded/select', whatsappAccountSchema, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      refresh();
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <Link to="/apps" className="text-xs text-muted-foreground">
          Ứng dụng / WhatsApp Business
        </Link>
        <div className="mb-6 mt-5 flex items-center gap-3">
          <ProviderMark provider="whatsapp" />
          <div>
            <h1 className="text-2xl font-semibold">WhatsApp Business</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Nhận và trả lời khách hàng từ số doanh nghiệp của bạn.
            </p>
          </div>
        </div>
        {status.isPending ? <Loading label="Đang tải WhatsApp…" /> : null}
        {status.error ? <ErrorNotice error={status.error} /> : null}
        {status.data ? (
          <>
            <Card className="mb-5 p-5">
              <h2 className="text-sm font-semibold">
                {status.data.configured
                  ? 'Kết nối số doanh nghiệp'
                  : 'Chưa cấu hình WhatsApp Business'}
              </h2>
              <p className="mt-2 text-xs leading-6 text-muted-foreground">
                {status.data.configured
                  ? 'Kết nối Cloud API trực tiếp hoặc cấp quyền qua Meta nếu ứng dụng đã đủ điều kiện.'
                  : 'Quản trị viên cần bổ sung Meta App và webhook HTTPS ở backend trước khi kết nối.'}
              </p>
              {!status.data.workerOnline ? (
                <p className="mt-3 text-xs text-amber-800">
                  Worker đang ngoại tuyến; khởi động worker chung để xử lý tin
                  nhắn.
                </p>
              ) : null}
              <div className="mt-4 rounded-xl border bg-slate-50 p-4">
                <h3 className="text-sm font-medium">Kết nối qua Meta</h3>
                <p className="my-2 text-xs leading-6 text-muted-foreground">
                  {status.data.embeddedAvailable
                    ? 'Meta sẽ kiểm tra doanh nghiệp, quyền ứng dụng và số điện thoại của bạn trong cửa sổ cấp quyền.'
                    : 'Embedded Signup cần quyền Tech Provider, cấu hình Login for Business và miền HTTPS. Chưa bật cho ứng dụng hiện tại.'}
                </p>
                <Button
                  disabled={!status.data.embeddedAvailable || pending}
                  onClick={signup ? launch : () => void prepare()}
                >
                  {signup ? 'Tiếp tục với Meta' : 'Chuẩn bị kết nối Meta'}
                </Button>
              </div>
              {selection ? (
                <form
                  onSubmit={select}
                  className="mt-4 space-y-3 rounded-xl border p-4"
                >
                  <h3 className="text-sm font-medium">Chọn số đã cấp quyền</h3>
                  <label className="block text-xs">
                    WABA ID
                    <Input
                      aria-label="WABA ID đã cấp quyền"
                      value={wabaId}
                      onChange={(e) => setWaba(e.target.value)}
                      list="wa-authorized-wabas"
                      required
                    />
                  </label>
                  <datalist id="wa-authorized-wabas">
                    {selection.wabaIds.map((id) => (
                      <option key={id} value={id} />
                    ))}
                  </datalist>
                  {phones.error ? <ErrorNotice error={phones.error} /> : null}
                  <label className="block text-xs">
                    Số điện thoại
                    <select
                      aria-label="Số điện thoại đã cấp quyền"
                      className="mt-2 h-10 w-full rounded-lg border bg-white px-3"
                      value={phoneId}
                      onChange={(e) => setPhone(e.target.value)}
                      required
                    >
                      <option value="">Chọn số Cloud API</option>
                      {phones.data?.items.map((p) => (
                        <option
                          key={p.id}
                          value={p.id}
                          disabled={p.coexistence}
                        >
                          {p.verifiedName} · {p.displayPhoneNumber}
                          {p.coexistence ? ' · Coexistence chưa hỗ trợ' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs">
                    PIN đăng ký (chỉ khi số chưa đăng ký)
                    <Input
                      aria-label="PIN đăng ký Meta"
                      type="password"
                      autoComplete="off"
                      value={pin}
                      onChange={(e) => setPin(e.target.value)}
                      maxLength={6}
                    />
                  </label>
                  <Button disabled={pending || !phoneId}>
                    Hoàn tất kết nối số
                  </Button>
                </form>
              ) : null}
              <details
                className="mt-5 rounded-xl border p-4"
                open={!status.data.embeddedAvailable}
              >
                <summary className="cursor-pointer text-sm font-medium">
                  Kết nối trực tiếp / số thử nghiệm của Meta
                </summary>
                <p className="mt-3 text-xs leading-6 text-muted-foreground">
                  Dùng access token đã được cấp quyền WhatsApp Business. Token
                  Facebook Page không thay thế token này. PIN dùng để đăng ký số
                  đã xác minh quyền sở hữu; hãy giữ PIN ở nơi an toàn.
                </p>
                <form
                  onSubmit={direct}
                  className="mt-4 grid gap-3 sm:grid-cols-2"
                >
                  <label className="text-xs">
                    WABA ID
                    <Input
                      aria-label="WABA ID"
                      value={wabaId}
                      onChange={(e) => setWaba(e.target.value)}
                      required
                      disabled={!status.data.configured || pending}
                    />
                  </label>
                  <label className="text-xs">
                    Phone Number ID
                    <Input
                      aria-label="Phone Number ID"
                      value={phoneId}
                      onChange={(e) => setPhone(e.target.value)}
                      required
                      disabled={!status.data.configured || pending}
                    />
                  </label>
                  <label className="text-xs sm:col-span-2">
                    Access token
                    <Input
                      aria-label="Access token WhatsApp"
                      type="password"
                      autoComplete="off"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      required
                      maxLength={16384}
                      disabled={!status.data.configured || pending}
                    />
                  </label>
                  <label className="text-xs">
                    PIN 6 chữ số (nếu cần đăng ký)
                    <Input
                      aria-label="PIN đăng ký trực tiếp"
                      type="password"
                      autoComplete="off"
                      value={pin}
                      onChange={(e) => setPin(e.target.value)}
                      maxLength={6}
                      disabled={!status.data.configured || pending}
                    />
                  </label>
                  <div className="sm:self-end">
                    <Button disabled={!status.data.configured || pending}>
                      {pending ? 'Đang xác minh…' : 'Kết nối WhatsApp Business'}
                    </Button>
                  </div>
                </form>
              </details>
              {error ? (
                <div className="mt-4">
                  <ErrorNotice error={error} />
                </div>
              ) : null}
            </Card>
            <h2 className="mb-3 text-base font-semibold">
              Số doanh nghiệp của bạn
            </h2>
            <div className="space-y-4">
              {status.data.accounts.map((a) => (
                <Account key={a.id} account={a} refresh={refresh} />
              ))}
              {!status.data.accounts.length ? (
                <Card className="p-8 text-center text-sm text-muted-foreground">
                  Chưa kết nối số WhatsApp Business.
                </Card>
              ) : null}
            </div>
            <Card className="mt-6 p-5">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <ShieldCheck className="size-4" />
                Phạm vi kết nối
              </h2>
              <ul className="mt-3 space-y-2 text-xs leading-6 text-muted-foreground">
                {status.data.restrictions.map((r) => (
                  <li key={r}>• {r}</li>
                ))}
              </ul>
            </Card>
          </>
        ) : null}
      </div>
    </main>
  );
}
function Account({
  account: a,
  refresh,
}: {
  account: WhatsAppStatus['accounts'][number];
  refresh: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const action = useMutation({
    mutationFn: async (kind: 'refresh' | 'disconnect'): Promise<unknown> =>
      kind === 'disconnect'
        ? api(`/channels/${a.id}`, z.object({ disconnected: z.boolean() }), {
            method: 'DELETE',
          })
        : api(`/channels/${a.id}/sync`, channelSyncResultSchema, {
            method: 'POST',
          }),
    onSuccess: () => {
      setConfirm(false);
      refresh();
    },
  });
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{a.name}</h3>
          <p className="mt-2 text-xs text-muted-foreground">
            {a.metadata?.businessName}
          </p>
        </div>
        <span className="rounded-full bg-slate-50 px-3 py-1.5 text-xs">
          {connectionLabel(a.connectionStatus)}
        </span>
      </div>
      <dl className="mt-4 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <div>WABA · {a.metadata?.wabaId}</div>
        <div>Phone Number ID · {a.metadata?.phoneNumberId}</div>
        <div>Số điện thoại · {a.metadata?.displayPhoneNumber}</div>
        <div>
          Quyền mẫu · {a.capabilities.templates ? 'Được cấp' : 'Chưa được cấp'}
        </div>
      </dl>
      {a.metadata ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Webhook đã xác minh lúc{' '}
          {formatTime(a.metadata.webhookVerifiedAt, true)}
          {a.metadata.lastWebhookAt
            ? ` · Nhận sự kiện: ${formatTime(a.metadata.lastWebhookAt, true)}`
            : ''}
        </p>
      ) : null}
      {a.lastError || a.lastSyncError ? (
        <p
          role="alert"
          className="mt-3 rounded-lg bg-amber-50 p-3 text-xs leading-6 text-amber-900"
        >
          {sendBlockedMessage(a.lastError ?? a.lastSyncError)}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" asChild>
          <Link
            to={`/inbox?account=${encodeURIComponent('whatsapp-business:' + a.id)}`}
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
            a.connectionStatus !== 'CONNECTED' ||
            !a.workerOnline
          }
          onClick={() => action.mutate('refresh')}
        >
          <RefreshCw />
          Kiểm tra kết nối
        </Button>
        {a.connectionStatus !== 'DISCONNECTED' ? (
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
        <div className="mt-4 rounded-xl border bg-amber-50 p-3">
          <p className="text-xs leading-6">
            Ngắt số {a.metadata?.displayPhoneNumber}? Lịch sử easyChat được giữ.
            Các số khác dùng chung WABA tiếp tục hoạt động.
          </p>
          <Button
            className="mt-2"
            size="sm"
            disabled={action.isPending}
            onClick={() => action.mutate('disconnect')}
          >
            Xác nhận ngắt
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
            Giữ kết nối
          </Button>
        </div>
      ) : null}
      {action.error ? (
        <div className="mt-3">
          <ErrorNotice error={action.error} />
        </div>
      ) : null}
      {action.isSuccess && action.variables === 'refresh' ? (
        <p role="status" className="mt-3 text-xs text-primary">
          Đã xếp lịch kiểm tra token, số điện thoại và webhook.
        </p>
      ) : null}
    </Card>
  );
}
