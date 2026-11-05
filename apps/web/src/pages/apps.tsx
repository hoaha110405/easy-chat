import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  ChevronRight,
  Clock3,
  LayoutGrid,
  MessageCircle,
  Plug,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react';
import type { InboxAccount } from '@zalo/shared';
import { useInboxAccounts } from '@/features/inbox/queries';
import {
  providers,
  channelDefinitions,
  channelInfo,
  connectionLabel,
  type ProviderDefinition,
} from '@/lib/channels';
import { ProviderMark } from '@/components/provider-mark';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorNotice, Loading } from '@/components/feedback';
import { cn, normalizeSearch } from '@/lib/utils';

export function AppsPage() {
  const query = useInboxAccounts();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'available' | 'planned'>('all');
  const accounts = query.data?.accounts ?? [];
  const connected = accounts.filter(
    (account) => account.status === 'CONNECTED',
  );
  const activeProviders = new Set(
    connected.map((account) => channelInfo(account.channelType).providerId),
  );
  const items = providers.filter(
    (provider) =>
      normalizeSearch(`${provider.name} ${provider.description}`).includes(
        normalizeSearch(search),
      ) &&
      (filter === 'all' ||
        (filter === 'available' ? provider.available : !provider.available)),
  );
  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 lg:px-8 lg:py-7">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6">
          <p className="eyebrow">Mở rộng không gian của bạn</p>
          <h1 className="mt-2 text-[26px] font-semibold tracking-tight">
            Kết nối ứng dụng
          </h1>
          <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
            Chọn ứng dụng, kết nối tài khoản và bắt đầu trò chuyện.
          </p>
        </div>
        <div className="connection-hero relative mb-6 hidden overflow-hidden rounded-2xl border border-teal-100 p-6 sm:block sm:p-8">
          <div className="relative z-10 max-w-lg">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-teal-200/60 bg-white/80 px-2.5 py-1 text-[10px] font-semibold text-primary">
              <Sparkles className="size-3" />
              Một hộp thư, nhiều kết nối
            </span>
            <h2 className="mt-4 text-2xl font-semibold leading-snug tracking-tight sm:text-[28px]">
              Mọi cuộc trò chuyện.
              <br />
              Cùng một không gian.
            </h2>
            <p className="mt-3 max-w-sm text-xs leading-6 text-slate-500">
              Giữ liên lạc theo cách quen thuộc. easyChat giúp bạn biết ai đang
              nhắn và trả lời bằng đúng tài khoản.
            </p>
          </div>
          <div
            aria-hidden="true"
            className="absolute right-10 top-1/2 hidden -translate-y-1/2 items-center gap-4 xl:flex"
          >
            <div className="space-y-4">
              {providers.slice(0, 2).map((provider) => (
                <ProviderMark
                  key={provider.id}
                  provider={provider.id}
                  className="size-14 border-4 border-white shadow-sm"
                />
              ))}
            </div>
            <span className="h-px w-8 border-t border-dashed border-teal-300" />
            <div className="grid size-20 place-items-center rounded-3xl border-[6px] border-white bg-primary text-white shadow-lg shadow-teal-900/10">
              <MessageCircle className="size-9" />
            </div>
            <span className="h-px w-8 border-t border-dashed border-teal-300" />
            <div className="space-y-4">
              {providers.slice(2, 4).map((provider) => (
                <ProviderMark
                  key={provider.id}
                  provider={provider.id}
                  className="size-14 border-4 border-white shadow-sm"
                />
              ))}
            </div>
          </div>
        </div>
        <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-white px-4 py-3 text-[11px] text-muted-foreground sm:hidden">
          <span>
            <strong className="font-semibold text-foreground">
              {query.data ? connected.length : '—'}
            </strong>{' '}
            tài khoản kết nối
          </span>
          <span className="text-slate-300">·</span>
          <span>
            <strong className="font-semibold text-foreground">
              {query.data
                ? accounts.reduce(
                    (sum, item) => sum + item.conversationCount,
                    0,
                  )
                : '—'}
            </strong>{' '}
            hội thoại
          </span>
        </div>
        <div className="mb-8 hidden grid-cols-3 gap-4 sm:grid">
          {[
            {
              label: 'Ứng dụng hoạt động',
              value: activeProviders.size,
              icon: LayoutGrid,
            },
            {
              label: 'Tài khoản kết nối',
              value: connected.length,
              icon: Users,
            },
            {
              label: 'Hội thoại đã lưu',
              value: accounts.reduce((sum, a) => sum + a.conversationCount, 0),
              icon: MessageCircle,
            },
          ].map(({ label, value, icon: Icon }) => (
            <div
              key={label}
              className="flex items-center gap-3 rounded-xl border bg-white px-3 py-4 sm:px-5"
            >
              <span className="hidden rounded-xl bg-slate-50 p-2.5 text-slate-500 sm:block">
                <Icon className="size-[18px]" />
              </span>
              <div>
                <p className="text-xl font-semibold tabular-nums">
                  {query.data ? value : '—'}
                </p>
                <p className="mt-1 text-[10px] text-muted-foreground sm:text-xs">
                  {label}
                </p>
              </div>
            </div>
          ))}
        </div>
        <section aria-label="Danh sách ứng dụng">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold">Khám phá ứng dụng</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Các kênh hiện có và những kết nối trong kế hoạch.
              </p>
            </div>
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-2.5 size-4 text-slate-500" />
              <Input
                aria-label="Tìm ứng dụng"
                placeholder="Tìm ứng dụng…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="h-9 rounded-lg bg-white pl-9 text-xs"
              />
            </div>
          </div>
          <div className="mb-5 flex gap-1 border-b" aria-label="Lọc ứng dụng">
            {(
              [
                { key: 'all', label: 'Tất cả' },
                { key: 'available', label: 'Đang hỗ trợ' },
                { key: 'planned', label: 'Sắp hỗ trợ' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.key}
                type="button"
                aria-pressed={filter === tab.key}
                onClick={() => setFilter(tab.key)}
                className={cn(
                  'border-b-2 border-transparent px-3 py-3 text-xs font-medium text-slate-500 transition-colors hover:text-foreground',
                  filter === tab.key && 'border-primary text-primary',
                )}
              >
                {tab.label}
                {tab.key === 'all' ? (
                  <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[9px] text-slate-500">
                    {providers.length}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {items.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                accounts={accounts.filter(
                  (account) =>
                    channelInfo(account.channelType).providerId === provider.id,
                )}
              />
            ))}
          </div>
          {!items.length ? (
            <div className="rounded-xl border border-dashed px-6 py-12 text-center">
              <Search className="mx-auto mb-3 size-6 text-slate-300" />
              <p className="text-sm font-medium">Không tìm thấy ứng dụng</p>
              <p className="mt-2 text-xs text-muted-foreground">
                Thử từ khóa khác hoặc chọn “Tất cả”.
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-3"
                onClick={() => {
                  setSearch('');
                  setFilter('all');
                }}
              >
                Xóa bộ lọc
              </Button>
            </div>
          ) : null}
        </section>
        <section className="mt-9" aria-label="Tài khoản của bạn">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold">Tài khoản của bạn</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Quản lý kết nối và mở hộp thư của từng tài khoản.
              </p>
            </div>
            <span className="rounded-full border bg-white px-2.5 py-1 text-[10px] text-slate-500">
              {accounts.length} tài khoản
            </span>
          </div>
          {query.isPending ? (
            <Loading label="Đang tải tài khoản…" />
          ) : query.error ? (
            <ErrorNotice error={query.error} />
          ) : accounts.length ? (
            <div className="divide-y overflow-hidden rounded-2xl border bg-white">
              {accounts.map((account) => (
                <AccountRow key={account.key} account={account} />
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed bg-white p-8 text-center">
              <Plug className="mx-auto mb-4 size-8 text-slate-300" />
              <h3 className="text-sm font-semibold">
                Thêm kết nối đầu tiên của bạn
              </h3>
              <p className="mx-auto mt-2 max-w-md text-xs leading-6 text-muted-foreground">
                Bắt đầu với Zalo cá nhân bằng mã QR, hoặc kết nối Official
                Account của bạn.
              </p>
              <Button asChild className="mt-5">
                <Link to="/personal">
                  Kết nối Zalo cá nhân
                  <ArrowRight />
                </Link>
              </Button>
            </div>
          )}
        </section>
        <p className="my-6 flex items-center justify-center gap-2 text-[10px] text-slate-500">
          <ShieldCheck className="size-3.5" />
          Thông tin đăng nhập được bảo vệ trên máy chủ của bạn.
        </p>
      </div>
    </main>
  );
}
function ProviderCard({
  provider,
  accounts,
}: {
  provider: ProviderDefinition;
  accounts: InboxAccount[];
}) {
  const connected = accounts.filter(
    (account) => account.status === 'CONNECTED',
  ).length;
  return (
    <article
      className={cn(
        'flex flex-col rounded-2xl border bg-white p-5 transition-shadow',
        provider.available
          ? 'border-teal-200/80 shadow-sm shadow-teal-900/[0.02]'
          : 'hover:shadow-sm',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <ProviderMark provider={provider.id} />
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-1 text-[9px] font-medium',
            provider.available
              ? 'bg-emerald-50 text-emerald-700'
              : 'bg-slate-50 text-slate-500',
          )}
        >
          {provider.available ? (
            <Check className="size-2.5" />
          ) : (
            <Clock3 className="size-2.5" />
          )}
          {provider.available ? 'Đang hỗ trợ' : 'Trong kế hoạch'}
        </span>
      </div>
      <h3 className="mt-4 text-base font-semibold">{provider.name}</h3>
      <p className="mb-5 mt-2 min-h-10 text-xs leading-5 text-muted-foreground">
        {provider.description}
      </p>
      <div className="mt-auto border-t pt-3">
        {provider.available ? (
          <>
            <p className="mb-3 flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  connected ? 'bg-emerald-500' : 'bg-slate-300',
                )}
              />
              {connected
                ? `${connected} tài khoản đang kết nối`
                : 'Sẵn sàng kết nối tài khoản'}
            </p>
            <div className="space-y-2">
              {Object.entries(channelDefinitions)
                .filter(([, channel]) => channel.providerId === provider.id)
                .map(([type, channel]) => (
                  <Link
                    key={type}
                    to={channel.settingsPath}
                    className="flex items-center justify-between rounded-lg border px-3 py-2.5 text-xs font-medium transition-colors hover:border-teal-200 hover:bg-teal-50/50"
                  >
                    <span>
                      {channel.shortLabel}
                      {channel.experimental ? (
                        <span className="ml-2 text-[9px] font-normal text-amber-700">
                          Chưa hỗ trợ
                        </span>
                      ) : null}
                    </span>
                    <ChevronRight className="size-3.5 text-slate-500" />
                  </Link>
                ))}
            </div>
          </>
        ) : (
          <>
            <p className="mb-3 text-[10px] text-slate-500">
              Kết nối này chưa được tích hợp.
            </p>
            <Button
              disabled
              variant="outline"
              size="sm"
              className="w-full border-dashed bg-slate-50/50 text-slate-500"
            >
              Sắp hỗ trợ
            </Button>
          </>
        )}
      </div>
    </article>
  );
}
function AccountRow({ account }: { account: InboxAccount }) {
  const channel = channelInfo(account.channelType);
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-4 sm:px-5">
      <Avatar
        name={account.name}
        url={account.avatarUrl}
        className="size-11"
        label={`Ảnh tài khoản ${account.name}`}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{account.name}</p>
        <p className="mt-1 truncate text-[10px] text-muted-foreground">
          {channel.label} · {account.externalAccountId ?? 'Chưa đăng nhập'}
        </p>
      </div>
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px]',
          account.status === 'CONNECTED'
            ? 'bg-emerald-50 text-emerald-700'
            : 'bg-slate-100 text-slate-500',
        )}
      >
        <span
          className={cn(
            'size-1.5 rounded-full',
            account.status === 'CONNECTED' ? 'bg-emerald-500' : 'bg-slate-400',
          )}
        />
        {connectionLabel(account.status)}
      </span>
      <p className="hidden min-w-20 text-right text-[11px] text-muted-foreground sm:block">
        {account.conversationCount} hội thoại
      </p>
      <Button
        asChild
        variant="ghost"
        size="icon"
        className="size-8"
        title={`Cài đặt ${account.name}`}
      >
        <Link to={channel.settingsPath} aria-label={`Cài đặt ${account.name}`}>
          <Settings2 />
        </Link>
      </Button>
      <Button asChild variant="outline" size="sm" className="ml-auto">
        <Link to={`/inbox?account=${encodeURIComponent(account.key)}`}>
          Mở hộp thư
          <ArrowRight />
        </Link>
      </Button>
    </div>
  );
}
