import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Layers3, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { InboxAccount } from '@zalo/shared';
import { channelInfo } from '@/lib/channels';
import { ProviderMark } from '@/components/provider-mark';
import { Avatar } from '@/components/avatar';
import { cn } from '@/lib/utils';

export function AccountFilter({
  accounts,
  value,
  onChange,
  loading,
  compact = false,
}: {
  accounts: InboxAccount[];
  value?: string;
  onChange: (value?: string) => void;
  loading: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = accounts.find((a) => a.key === value);
  const total = accounts.reduce((sum, a) => sum + a.conversationCount, 0);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    const option =
      root.current?.querySelector<HTMLButtonElement>(
        '[role="menuitemradio"][aria-checked="true"]',
      ) ??
      root.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]');
    option?.focus();
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  function choose(key?: string) {
    onChange(key);
    setOpen(false);
    trigger.current?.focus();
  }
  return (
    <div ref={root} className="relative min-w-0 w-full sm:max-w-[260px]">
      <button
        ref={trigger}
        type="button"
        aria-label="Chọn tài khoản"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="inbox-account-menu"
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg border bg-white text-left transition-colors hover:border-teal-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
          compact ? 'px-2.5 py-1.5' : 'p-3 shadow-sm',
          open && 'border-teal-200 ring-2 ring-teal-50',
        )}
      >
        {selected ? (
          <Avatar
            name={selected.name}
            url={selected.avatarUrl}
            className="size-8"
          />
        ) : (
          <div className="grid size-8 shrink-0 place-items-center rounded-full bg-teal-50 text-primary">
            <Layers3 className="size-4" />
          </div>
        )}
        <span className="min-w-0 flex-1">
          {!compact ? (
            <span className="block text-[9px] font-medium text-slate-500">
              Hiển thị hội thoại của
            </span>
          ) : null}
          <span className="mt-0.5 block truncate text-xs font-semibold">
            {selected?.name ??
              (value
                ? loading
                  ? 'Đang tải tài khoản…'
                  : 'Không tìm thấy tài khoản'
                : 'Tất cả tài khoản')}
          </span>
        </span>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-slate-500 transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open ? (
        <div className="absolute left-0 right-0 top-full z-30 mt-2 overflow-hidden rounded-xl border bg-white shadow-xl shadow-slate-900/10">
          <div
            id="inbox-account-menu"
            role="menu"
            aria-label="Tài khoản kết nối"
            className="max-h-80 overflow-y-auto p-1.5"
            onKeyDown={(event) => {
              const buttons = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role="menuitemradio"]',
                ),
              ];
              const index = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              if (event.key === 'Escape') {
                setOpen(false);
                trigger.current?.focus();
              } else if (
                ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
              ) {
                event.preventDefault();
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? buttons.length - 1
                      : (index +
                          (event.key === 'ArrowDown' ? 1 : -1) +
                          buttons.length) %
                        buttons.length;
                buttons[next]?.focus();
              } else if (event.key === 'Tab') {
                setOpen(false);
                trigger.current?.focus();
              }
            }}
          >
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!value}
              onClick={() => choose()}
              className="flex w-full items-center gap-3 rounded-lg p-3 text-left hover:bg-slate-50 focus:bg-teal-50 focus:outline-none"
            >
              <div className="grid size-8 shrink-0 place-items-center rounded-full bg-teal-50 text-primary">
                <Layers3 className="size-4" />
              </div>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">
                  Tất cả tài khoản
                </span>
                <span className="text-[11px] text-slate-500">
                  {accounts.length} tài khoản · {total} hội thoại
                </span>
              </span>
              {!value ? <Check className="size-4 text-primary" /> : null}
            </button>
            {accounts.map((account) => (
              <button
                key={account.key}
                type="button"
                role="menuitemradio"
                aria-checked={value === account.key}
                onClick={() => choose(account.key)}
                className="flex w-full items-center gap-3 rounded-lg p-3 text-left hover:bg-slate-50 focus:bg-teal-50 focus:outline-none"
              >
                <div className="relative shrink-0">
                  <Avatar
                    name={account.name}
                    url={account.avatarUrl}
                    label={`Ảnh tài khoản ${account.name}`}
                  />
                  <span
                    className={cn(
                      'absolute bottom-0 right-0 size-3 rounded-full border-2 border-white',
                      account.status === 'CONNECTED'
                        ? 'bg-emerald-500'
                        : 'bg-slate-300',
                    )}
                  />
                </div>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {account.name}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1 truncate text-[9px] text-slate-500">
                    <ProviderMark
                      provider={channelInfo(account.channelType).providerId}
                      className="size-3.5 rounded-sm"
                      small
                    />
                    {channelInfo(account.channelType).label} ·{' '}
                    {account.externalAccountId ?? 'Chưa đăng nhập'}
                  </span>
                </span>
                <span className="text-xs tabular-nums text-slate-500">
                  {account.conversationCount}
                </span>
                {value === account.key ? (
                  <Check className="size-4 shrink-0 text-primary" />
                ) : null}
              </button>
            ))}
          </div>
          <Link
            to="/apps"
            className="flex items-center gap-2 border-t px-5 py-3 text-xs font-medium text-primary hover:bg-teal-50"
          >
            <Plus className="size-3.5" />
            Quản lý tài khoản
          </Link>
        </div>
      ) : null}
    </div>
  );
}
