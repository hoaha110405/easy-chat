import { Suspense, useState } from 'react';
import { NavLink, Link, Outlet, useLocation } from 'react-router-dom';
import {
  ArrowUpRight,
  ChevronRight,
  Inbox,
  LayoutGrid,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { ErrorNotice, Loading } from './feedback';
import { Brand } from './brand';
import { Avatar } from './avatar';
import { ProviderMark } from './provider-mark';
import { useRealtime } from '@/hooks/use-realtime';
import { useInboxAccounts } from '@/features/inbox/queries';
import { channelDefinitions } from '@/lib/channels';

export function Layout({ onLogout }: { onLogout: () => Promise<void> }) {
  useRealtime();
  const accounts = useInboxAccounts();
  const location = useLocation();
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const connected =
    accounts.data?.accounts.filter(
      (account) => account.status === 'CONNECTED',
    ) ?? [];
  const chatting = /^\/inbox\/[^/]+/.test(location.pathname);
  const inInbox = location.pathname.startsWith('/inbox');
  const focused =
    inInbox && new URLSearchParams(location.search).get('focus') === '1';
  const compact = inInbox && !expanded;
  const title = inInbox
    ? 'Hộp thư'
    : location.pathname === '/personal'
      ? 'Zalo cá nhân'
      : location.pathname === '/connection'
        ? 'Zalo Official Account'
        : location.pathname === '/facebook/page'
          ? 'Facebook Page'
          : location.pathname === '/facebook/personal'
            ? 'Messenger cá nhân · Thử nghiệm'
            : 'Kết nối ứng dụng';
  const navigation = [
    { to: '/inbox', label: 'Hộp thư', icon: Inbox },
    { to: '/apps', label: 'Kết nối ứng dụng', icon: LayoutGrid },
  ];
  async function logout() {
    setPending(true);
    try {
      await onLogout();
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="flex h-dvh min-h-0 overflow-hidden bg-background">
      <a
        href="#workspace-main"
        className="sr-only fixed left-4 top-4 z-50 rounded-lg bg-primary px-4 py-2 text-white focus:not-sr-only"
      >
        Đến nội dung chính
      </a>
      {!focused ? (
        <aside
          aria-label="Thanh điều hướng"
          className={cn(
            'hidden shrink-0 flex-col border-r bg-white lg:flex',
            compact ? 'w-16' : 'w-[224px]',
          )}
        >
          <Link
            to="/inbox"
            aria-label="easyChat - Hộp thư"
            title="easyChat"
            className={cn(compact ? 'mx-auto pb-6 pt-4' : 'px-6 pb-8 pt-7')}
          >
            <Brand iconOnly={compact} />
          </Link>
          {!compact ? (
            <>
              <div className="mx-4 mb-6 flex items-center gap-3 rounded-xl border bg-slate-50/70 p-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white text-xs font-semibold text-primary shadow-sm">
                  W
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold">Không gian của bạn</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    Tài khoản quản trị
                  </p>
                </div>
              </div>
              <p className="px-7 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                Không gian làm việc
              </p>
            </>
          ) : null}
          <nav
            aria-label="Điều hướng chính"
            className={cn('space-y-1', compact ? 'px-2' : 'mt-3 px-3')}
          >
            {navigation.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                title={label}
                aria-label={label}
                className={({ isActive }) =>
                  cn(
                    'flex items-center rounded-xl font-medium text-slate-500 transition-colors hover:bg-slate-50 hover:text-foreground',
                    compact
                      ? 'h-11 justify-center'
                      : 'gap-3 px-3.5 py-3 text-[13px]',
                    (isActive || (to === '/apps' && !inInbox)) &&
                      'bg-teal-50 text-primary hover:bg-teal-50 hover:text-primary',
                  )
                }
              >
                <Icon className="size-[18px]" />
                {!compact ? (
                  <>
                    <span>{label}</span>
                    {to === '/inbox' && accounts.data ? (
                      <span
                        title="Tổng số hội thoại đã lưu"
                        className="ml-auto rounded-md bg-white/80 px-1.5 py-0.5 text-[10px] tabular-nums"
                      >
                        {accounts.data.accounts.reduce(
                          (sum, a) => sum + a.conversationCount,
                          0,
                        )}
                      </span>
                    ) : null}
                  </>
                ) : null}
              </NavLink>
            ))}
          </nav>
          <div className={cn('mt-6', compact ? 'px-2' : 'px-3')}>
            {!compact ? (
              <div className="mb-3 flex items-center justify-between px-3.5">
                <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Kênh của bạn
                </p>
                <Link
                  to="/apps"
                  aria-label="Thêm ứng dụng"
                  className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-primary"
                >
                  <Plus className="size-3.5" />
                </Link>
              </div>
            ) : (
              <div className="mx-auto mb-4 h-px w-6 bg-border" />
            )}
            {Object.entries(channelDefinitions).map(([type, channel]) => {
              const count = connected.filter(
                (account) => account.channelType === type,
              ).length;
              return (
                <NavLink
                  key={type}
                  to={channel.settingsPath}
                  title={`${channel.label} · ${count} tài khoản kết nối`}
                  aria-label={channel.label}
                  className={({ isActive }) =>
                    cn(
                      'relative mb-2 flex items-center rounded-xl text-xs text-slate-500 hover:bg-slate-50',
                      compact ? 'h-11 justify-center' : 'gap-2.5 px-3 py-2.5',
                      isActive && 'bg-slate-50 text-foreground',
                    )
                  }
                >
                  <ProviderMark provider={channel.providerId} small />
                  {compact ? (
                    <span className="absolute bottom-0.5 right-0.5 rounded bg-white px-0.5 text-[7px] font-semibold text-slate-500">
                      {channel.shortLabel
                        .split(' ')
                        .map((word) => word[0])
                        .join('')
                        .slice(0, 2)}
                    </span>
                  ) : (
                    <>
                      <span className="flex-1">
                        {channel.label.replace('Official Account', 'OA')}
                      </span>
                      <span
                        className={cn(
                          'size-1.5 rounded-full',
                          count ? 'bg-emerald-500' : 'bg-slate-300',
                        )}
                      />
                      <span className="min-w-2 text-[10px] tabular-nums">
                        {count}
                      </span>
                    </>
                  )}
                </NavLink>
              );
            })}
          </div>
          <div className={cn('mt-auto', compact ? 'px-2 pb-3' : 'p-4')}>
            {!compact ? (
              <Link
                to="/apps"
                className="mb-5 block rounded-xl border border-teal-100 bg-gradient-to-br from-teal-50/80 to-white p-3.5"
              >
                <div className="flex items-center justify-between text-primary">
                  <LayoutGrid className="size-4" />
                  <ArrowUpRight className="size-3.5" />
                </div>
                <p className="mt-2.5 text-xs font-semibold">
                  Thêm một kết nối mới
                </p>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                  Gom các kênh trò chuyện về cùng một nơi.
                </p>
              </Link>
            ) : null}
            <div
              className={cn(
                'flex items-center gap-2.5 border-t pt-4',
                compact && 'flex-col gap-2',
              )}
            >
              <Avatar
                name="Quản trị viên"
                className="size-8 bg-slate-100 text-slate-600"
              />
              {!compact ? (
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold">Quản trị viên</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    Không gian riêng tư
                  </p>
                </div>
              ) : null}
              <button
                onClick={logout}
                disabled={pending}
                title="Đăng xuất"
                aria-label="Đăng xuất"
                className="rounded-lg p-2 text-slate-500 hover:bg-slate-50 hover:text-foreground disabled:opacity-50"
              >
                <LogOut className="size-4" />
              </button>
            </div>
          </div>
        </aside>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!focused ? (
          <header
            className={cn(
              'flex shrink-0 items-center justify-between gap-3 border-b bg-white/90 px-3',
              inInbox ? 'h-12 lg:px-4' : 'h-14 lg:h-[68px] lg:px-7',
            )}
          >
            <Link
              to="/inbox"
              className="lg:hidden"
              aria-label="easyChat - Hộp thư"
            >
              <Brand compact />
            </Link>
            <div className="hidden items-center gap-2 text-xs text-muted-foreground lg:flex">
              {inInbox ? (
                <button
                  type="button"
                  onClick={() => setExpanded(!expanded)}
                  aria-label={
                    compact
                      ? 'Mở rộng thanh điều hướng'
                      : 'Thu gọn thanh điều hướng'
                  }
                  aria-expanded={!compact}
                  className="mr-1 rounded-lg p-2 text-slate-500 hover:bg-slate-50"
                >
                  {compact ? (
                    <PanelLeftOpen className="size-[18px]" />
                  ) : (
                    <PanelLeftClose className="size-[18px]" />
                  )}
                </button>
              ) : null}
              <span>Không gian làm việc</span>
              <ChevronRight className="size-3" />
              <span className="font-medium text-foreground">{title}</span>
            </div>
            <div className="flex items-center gap-3">
              <Link
                to="/apps"
                className="hidden items-center gap-2 text-[11px] text-muted-foreground sm:flex"
              >
                <span className="flex -space-x-2">
                  {connected.slice(0, 3).map((account) => (
                    <Avatar
                      key={account.key}
                      name={account.name}
                      url={account.avatarUrl}
                      className="size-6 border-2 border-white text-[8px]"
                    />
                  ))}
                </span>
                {connected.length} tài khoản kết nối
              </Link>
              <span className="hidden h-5 w-px bg-border sm:block" />
              <Button
                asChild
                variant="outline"
                size="sm"
                className="rounded-lg text-[11px]"
              >
                <Link to="/apps">
                  <Plus />
                  Kết nối kênh
                </Link>
              </Button>
              <button
                onClick={logout}
                disabled={pending}
                aria-label="Đăng xuất"
                title="Đăng xuất"
                className="rounded-lg p-2 text-slate-500 hover:bg-slate-50 lg:hidden"
              >
                <LogOut className="size-4" />
              </button>
            </div>
          </header>
        ) : null}
        {error ? (
          <div className="p-4">
            <ErrorNotice error={error} />
          </div>
        ) : null}
        <div
          id="workspace-main"
          tabIndex={-1}
          className="flex min-h-0 flex-1 flex-col focus:outline-none"
        >
          <Suspense fallback={<Loading label="Đang mở trang…" />}>
            <Outlet />
          </Suspense>
        </div>
        {!chatting && !focused ? (
          <nav
            aria-label="Điều hướng trên điện thoại"
            className="flex shrink-0 border-t bg-white px-3 pb-[env(safe-area-inset-bottom)] lg:hidden"
          >
            {navigation.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  cn(
                    'flex min-h-14 flex-1 items-center justify-center gap-2 text-xs font-medium text-slate-400',
                    (isActive || (to === '/apps' && !inInbox)) &&
                      'text-primary',
                  )
                }
              >
                <Icon className="size-[18px]" />
                {label}
              </NavLink>
            ))}
          </nav>
        ) : null}
      </div>
    </div>
  );
}
