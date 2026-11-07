import { WhatsAppTemplates } from '@/features/inbox/whatsapp-templates';
import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
} from 'react';
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import {
  ArrowLeft,
  ArrowUpRight,
  Info,
  Maximize2,
  Minimize2,
  Plus,
  Settings2,
  ShieldCheck,
  ArrowRight,
  ChevronDown,
  Inbox,
  LockKeyhole,
  MessageSquareText,
  Search,
  X,
} from 'lucide-react';
import type { Conversation, InboxMessage } from '@zalo/shared';
import {
  useConversations,
  useMessages,
  useConversation,
  useInboxAccounts,
} from '@/features/inbox/queries';
import { useInboxRead } from '@/features/inbox/use-inbox-read';
import { AccountFilter } from '@/features/inbox/account-filter';
import {
  channelDefinitions,
  channelInfo,
  conversationPreview,
  sendBlockedMessage,
} from '@/lib/channels';
import { ProviderMark } from '@/components/provider-mark';
import { ConversationDetails } from '@/features/inbox/conversation-details';
import { MessageAttachment } from '@/features/inbox/message-attachment';
import { ConversationComposer, DeliveryState } from '@/features/inbox/composer';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorNotice, Loading } from '@/components/feedback';
import { cn, formatTime, normalizeSearch } from '@/lib/utils';
export function InboxPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const focused = searchParams.get('focus') === '1';
  const account = searchParams.get('account') || undefined;
  const channelTypeParam = searchParams.get('channelType');
  const channelType =
    channelTypeParam && channelTypeParam in channelDefinitions
      ? channelTypeParam
      : undefined;
  const conversations = useConversations(account, channelType);
  const accounts = useInboxAccounts();
  const navigate = useNavigate();
  const { conversationId } = useParams();
  const [search, setSearch] = useState('');
  const items = [
    ...new Map(
      (conversations.data?.pages.flatMap((page) => page.items) ?? []).map(
        (item) => [item.id, item],
      ),
    ).values(),
  ];
  const term = normalizeSearch(search);
  const filtered = items.filter((conversation) =>
    normalizeSearch(
      `${conversation.customerName ?? ''} ${conversation.externalUserId} ${conversation.accountName ?? ''} ${conversation.accountExternalId ?? ''} ${conversationPreview(conversation.lastMessagePreview)}`,
    ).includes(term),
  );
  const selectedAccount = accounts.data?.accounts.find(
    (item) => item.key === account,
  );
  const visibleAccounts = (accounts.data?.accounts ?? []).filter(
    (item) => !channelType || item.channelType === channelType,
  );
  const unreadTotal = visibleAccounts
    .filter((item) => !account || item.key === account)
    .reduce((sum, item) => sum + (item.unreadMessageCount ?? 0), 0);
  const selected = items.find((item) => item.id === conversationId);
  const suffix = searchParams.toString() ? `?${searchParams.toString()}` : '';
  const total =
    selectedAccount?.conversationCount ??
    visibleAccounts.reduce((sum, item) => sum + item.conversationCount, 0);
  return (
    <main
      className={cn(
        'flex min-h-0 flex-1 flex-col',
        focused ? 'p-0' : 'p-2 lg:p-3',
      )}
    >
      <div
        className={cn(
          'flex shrink-0 items-center gap-2',
          focused ? 'px-3 py-2' : 'mb-2',
        )}
      >
        <div className="hidden shrink-0 items-center gap-2 sm:flex">
          <h1 className="text-lg font-semibold tracking-tight">Hộp thư</h1>
          <span className="rounded-md border bg-white px-1.5 py-0.5 text-[10px] tabular-nums text-slate-500">
            {total ?? '—'}
          </span>
        </div>
        <AccountFilter
          compact
          accounts={visibleAccounts}
          value={account}
          loading={accounts.isPending}
          onChange={(key) => {
            setSearch('');
            const params = new URLSearchParams(searchParams);
            if (key) params.set('account', key);
            else params.delete('account');
            navigate(
              `/inbox${params.toString() ? `?${params.toString()}` : ''}`,
            );
          }}
        />
        <label className="sr-only" htmlFor="inbox-channel-filter">
          Lọc kênh
        </label>
        <select
          id="inbox-channel-filter"
          value={channelType ?? ''}
          onChange={(event) => {
            setSearch('');
            const params = new URLSearchParams(searchParams);
            params.delete('account');
            if (event.target.value)
              params.set('channelType', event.target.value);
            else params.delete('channelType');
            navigate(
              `/inbox${params.toString() ? `?${params.toString()}` : ''}`,
            );
          }}
          className="h-9 w-[104px] shrink-0 rounded-lg border bg-white px-2 text-[10px] text-slate-600 focus:outline-none focus:ring-2 focus:ring-primary sm:w-[142px] sm:text-[11px]"
        >
          <option value="">Tất cả kênh</option>
          {Object.entries(channelDefinitions).map(([type, channel]) => (
            <option key={type} value={type}>
              {channel.label}
            </option>
          ))}
        </select>
        <span className="hidden items-center gap-1.5 text-[10px] text-slate-500 lg:inline-flex">
          <span
            className={cn(
              'size-1.5 rounded-full',
              conversations.isError ? 'bg-amber-400' : 'bg-emerald-500',
            )}
          />
          {conversations.isError ? 'Đang cập nhật lại' : 'Tự động cập nhật'}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="hidden size-8 text-muted-foreground sm:inline-flex"
          >
            <Link
              to="/apps"
              title="Quản lý kết nối"
              aria-label="Quản lý kết nối"
            >
              <Settings2 />
            </Link>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={focused ? 'Thu nhỏ hội thoại' : 'Phóng to hội thoại'}
            aria-pressed={focused}
            title={
              focused
                ? 'Trở về bố cục thường'
                : 'Mở rộng toàn bộ khu vực làm việc'
            }
            onClick={() => {
              const params = new URLSearchParams(searchParams);
              if (focused) params.delete('focus');
              else params.set('focus', '1');
              setSearchParams(params, { replace: true });
            }}
            className="h-9 px-2.5"
          >
            {focused ? <Minimize2 /> : <Maximize2 />}
            <span className="hidden xl:inline">
              {focused ? 'Thu nhỏ' : 'Phóng to'}
            </span>
          </Button>
        </div>
      </div>
      {accounts.error ? (
        <div className="mb-3">
          <ErrorNotice error={accounts.error} />
        </div>
      ) : null}
      <div
        className={cn(
          'flex min-h-0 flex-1 overflow-hidden bg-white',
          focused
            ? 'border-t'
            : 'rounded-xl border shadow-sm shadow-slate-900/[0.025]',
        )}
      >
        <section
          aria-label="Danh sách hội thoại"
          className={cn(
            'flex w-full shrink-0 flex-col border-r md:w-[280px] lg:w-[320px] xl:w-[360px]',
            conversationId && 'hidden md:flex',
          )}
        >
          <div className="border-b px-4 py-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold">Trò chuyện</h2>
                {unreadTotal > 0 ? (
                  <span
                    aria-label={`Tổng ${unreadTotal} tin chưa đọc`}
                    title="Tin chưa đọc trong easyChat, theo tài khoản và kênh đang chọn"
                    className="rounded-full bg-teal-50 px-2 py-1 text-[10px] font-semibold tabular-nums text-teal-800"
                  >
                    {unreadTotal} chưa đọc
                  </span>
                ) : null}
              </div>
              <span
                className="text-[10px] tabular-nums text-slate-500"
                title="Số hội thoại đã tải"
              >
                {items.length} đã tải
              </span>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-2.5 size-4 text-slate-500" />
              <Input
                aria-label="Tìm hội thoại đã tải"
                placeholder="Tìm tên hoặc tin nhắn gần nhất…"
                className="h-9 rounded-lg border-slate-200/80 bg-slate-50/70 pl-9 pr-8 text-[11px]"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {search ? (
                <button
                  aria-label="Xóa tìm kiếm"
                  className="absolute right-2 top-2 rounded p-0.5 text-slate-500"
                  onClick={() => setSearch('')}
                >
                  <X className="size-3.5" />
                </button>
              ) : null}
            </div>
            {search ? (
              <p className="mt-2 text-[10px] text-slate-500">
                Tìm trong các hội thoại đã tải.
              </p>
            ) : null}
          </div>
          <div
            role="region"
            aria-label="Cuộn danh sách hội thoại"
            tabIndex={0}
            className="min-h-0 flex-1 overflow-y-auto p-1.5 focus:outline-none"
            onScroll={(event) => {
              const element = event.currentTarget;
              if (
                element.scrollTop + element.clientHeight >=
                  element.scrollHeight - 96 &&
                conversations.hasNextPage &&
                !conversations.isFetchingNextPage &&
                !conversations.isError
              )
                void conversations.fetchNextPage();
            }}
          >
            {conversations.isPending ? (
              <Loading label="Đang tải hội thoại…" />
            ) : null}
            {conversations.error ? (
              <div className="p-2">
                <ErrorNotice error={conversations.error} />
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => void conversations.refetch()}
                >
                  Thử lại
                </Button>
              </div>
            ) : null}
            {filtered.map((conversation) => (
              <button
                key={conversation.id}
                onClick={() => navigate(`/inbox/${conversation.id}${suffix}`)}
                aria-current={
                  conversationId === conversation.id ? 'true' : undefined
                }
                className={cn(
                  'mb-1 flex w-full gap-3 rounded-xl border border-transparent px-3 py-2.5 text-left transition-colors hover:bg-slate-50',
                  (conversation.inboxUnreadCount ?? 0) > 0 && 'bg-teal-50/40',
                  conversationId === conversation.id &&
                    'border-teal-100 bg-teal-50/70 hover:bg-teal-50/70',
                )}
              >
                <div className="relative h-fit">
                  <Avatar
                    name={
                      conversation.customerName ?? conversation.externalUserId
                    }
                    url={conversation.customerAvatar}
                    label={`Ảnh người liên hệ ${conversation.customerName ?? conversation.externalUserId}`}
                    className="size-11 ring-2 ring-white"
                  />
                  {(conversation.inboxUnreadCount ?? 0) > 0 ? (
                    <span
                      aria-hidden="true"
                      className="absolute -left-0.5 -top-0.5 size-3 rounded-full border-2 border-white bg-primary"
                    />
                  ) : null}
                  <span className="absolute -bottom-1 -right-1 rounded-md border-2 border-white">
                    <ProviderMark
                      provider={
                        channelInfo(conversation.channelType).providerId
                      }
                      className="size-4 rounded text-[7px]"
                      small
                    />
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p
                      className={cn(
                        'truncate text-sm',
                        (conversation.inboxUnreadCount ?? 0) > 0
                          ? 'font-semibold text-slate-950'
                          : 'font-medium text-slate-700',
                      )}
                    >
                      {conversation.customerName ?? conversation.externalUserId}
                    </p>
                    <span className="shrink-0 text-[9px] text-slate-500">
                      {conversation.lastMessageAt
                        ? new Intl.DateTimeFormat('vi-VN', {
                            month: '2-digit',
                            day: '2-digit',
                          }).format(new Date(conversation.lastMessageAt))
                        : ''}
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <p
                      className={cn(
                        'min-w-0 flex-1 truncate text-xs leading-5',
                        (conversation.inboxUnreadCount ?? 0) > 0
                          ? 'font-medium text-slate-700'
                          : 'text-muted-foreground',
                      )}
                    >
                      {conversationPreview(conversation.lastMessagePreview)}
                    </p>
                    {(conversation.inboxUnreadCount ?? 0) > 0 ? (
                      <span
                        aria-label={`${conversation.inboxUnreadCount} tin chưa đọc`}
                        title={`${conversation.inboxUnreadCount} tin chưa đọc trong easyChat`}
                        className="min-w-5 shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-center text-[10px] font-semibold leading-4 tabular-nums text-white"
                      >
                        {conversation.inboxUnreadCount! > 99
                          ? '99+'
                          : conversation.inboxUnreadCount}
                      </span>
                    ) : null}
                  </div>
                  <div
                    className="mt-1.5 flex items-center gap-1.5"
                    title={`${conversation.accountName ?? 'Tài khoản'} · ${conversation.accountExternalId ?? ''}`}
                  >
                    <Avatar
                      name={conversation.accountName ?? 'Tài khoản'}
                      url={conversation.accountAvatar}
                      className="size-4 text-[7px]"
                    />
                    <span className="truncate text-[10px] font-medium text-slate-500">
                      {conversation.accountName ?? 'Tài khoản'}
                    </span>
                    <span className="ml-auto shrink-0 rounded border border-slate-200/80 bg-white/80 px-1 py-0.5 text-[9px] text-slate-500">
                      {channelInfo(conversation.channelType).shortLabel}
                    </span>
                  </div>
                </div>
              </button>
            ))}
            {!conversations.isPending &&
            !conversations.error &&
            !filtered.length ? (
              <div className="px-5 py-12 text-center">
                <Inbox className="mx-auto mb-3 size-7 text-slate-300" />
                <h3 className="text-sm font-medium">
                  {search
                    ? 'Không tìm thấy hội thoại'
                    : account
                      ? 'Tài khoản này chưa có hội thoại'
                      : 'Hộp thư đang chờ tin nhắn đầu tiên'}
                </h3>
                <p className="mt-2 text-xs leading-6 text-muted-foreground">
                  {search
                    ? 'Thử tên, mã liên hệ hoặc tài khoản khác.'
                    : 'Tin nhắn mới từ tài khoản đã kết nối sẽ xuất hiện tại đây.'}
                </p>
              </div>
            ) : null}
            {conversations.hasNextPage ? (
              <div className="p-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled={conversations.isFetchingNextPage}
                  onClick={() => void conversations.fetchNextPage()}
                >
                  {conversations.isFetchingNextPage
                    ? 'Đang tải…'
                    : 'Tải thêm hội thoại'}
                  <ChevronDown />
                </Button>
              </div>
            ) : null}
          </div>
        </section>
        <section
          aria-label="Nội dung hội thoại"
          className={cn(
            'relative flex min-w-0 flex-1',
            !conversationId && 'hidden md:flex',
          )}
        >
          {conversationId ? (
            <MessageViewer
              key={conversationId}
              id={conversationId}
              conversation={selected}
              backTo={`/inbox${suffix}`}
            />
          ) : (
            <div className="chat-canvas flex size-full min-h-0 flex-col items-center justify-center px-8 py-12 text-center">
              <div className="relative mb-7">
                <span className="absolute -left-5 -top-4 size-16 -rotate-12 rounded-2xl border border-teal-100 bg-white/70" />
                <span className="absolute -bottom-2 -right-5 size-16 rotate-12 rounded-2xl border border-slate-200 bg-white/70" />
                <span className="relative grid size-[84px] place-items-center rounded-[26px] border border-teal-100 bg-white text-primary shadow-sm">
                  <MessageSquareText className="size-9" />
                </span>
              </div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary/70">
                Sẵn sàng cho cuộc trò chuyện tiếp theo
              </p>
              <h2 className="mt-3 text-2xl font-semibold tracking-tight">
                Một hộp thư. Mọi kết nối.
              </h2>
              <p className="mt-3 max-w-sm text-[13px] leading-6 text-muted-foreground">
                {items.length
                  ? 'Chọn một cuộc trò chuyện để xem tin nhắn. Tài khoản nhận và trả lời luôn được hiển thị rõ ràng.'
                  : 'Kết nối tài khoản của bạn để bắt đầu nhận và quản lý tin nhắn tại cùng một nơi.'}
              </p>
              {filtered.length ? (
                <Button
                  className="mt-6"
                  onClick={() => navigate(`/inbox/${filtered[0].id}${suffix}`)}
                >
                  Mở hội thoại gần nhất
                  <ArrowRight />
                </Button>
              ) : (
                <Button asChild className="mt-6">
                  <Link to="/apps">
                    <Plus />
                    Kết nối tài khoản
                  </Link>
                </Button>
              )}
              <Link
                to="/apps"
                className="mt-4 inline-flex items-center gap-1.5 text-[11px] text-slate-500 hover:text-primary"
              >
                Khám phá các ứng dụng
                <ArrowUpRight className="size-3" />
              </Link>
              <p className="mt-12 inline-flex items-center gap-1.5 text-[10px] text-slate-500">
                <ShieldCheck className="size-3.5" />
                Mỗi tài khoản một phiên kết nối riêng.
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
function MessageViewer({
  id,
  conversation,
  backTo,
}: {
  id: string;
  conversation?: Conversation;
  backTo: string;
}) {
  const query = useMessages(id);
  const detail = useConversation(id, !conversation);
  const currentConversation = conversation ?? detail.data;
  const [optimistic, setOptimistic] = useState<InboxMessage | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const infoButton = useRef<HTMLButtonElement>(null);
  const closeDetails = useCallback(() => {
    setDetailsOpen(false);
    infoButton.current?.focus();
  }, []);
  const viewport = useRef<HTMLDivElement>(null);
  const wasAtBottom = useRef(true);
  const previousHeight = useRef(0);
  const loadingOlder = useRef(false);
  const messages = [
    ...new Map(
      (query.data?.pages.flatMap((p) => p.items) ?? []).map((m) => [m.id, m]),
    ).values(),
  ].sort(
    (a, b) => a.sentAt.localeCompare(b.sentAt) || a.id.localeCompare(b.id),
  );
  if (
    optimistic &&
    !messages.some(
      (message) => message.idempotencyKey === optimistic.idempotencyKey,
    )
  )
    messages.push(optimistic);
  const read = useInboxRead(id, viewport, messages);
  const firstUnread = messages.find(
    (m) => m.inboxUnread && m.direction === 'INCOMING',
  )?.id;
  const contentKey = messages.map((m) => m.id).join(',');
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    if (loadingOlder.current) {
      el.scrollTop = el.scrollHeight - previousHeight.current;
      loadingOlder.current = false;
    } else if (wasAtBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [contentKey]);
  useEffect(() => {
    if (!query.isFetchingNextPage) loadingOlder.current = false;
  }, [query.isFetchingNextPage]);
  useEffect(() => {
    const el = viewport.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (wasAtBottom.current && !loadingOlder.current)
        el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const name =
    currentConversation?.customerName ??
    currentConversation?.externalUserId ??
    'Conversation';
  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-h-[64px] shrink-0 items-center gap-3 border-b bg-white px-4 py-2.5 lg:px-5">
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="-ml-2 size-8 md:hidden"
        >
          <Link to={backTo} aria-label="Quay lại danh sách hội thoại">
            <ArrowLeft />
          </Link>
        </Button>
        <Avatar
          name={name}
          url={currentConversation?.customerAvatar}
          label={`Ảnh người liên hệ ${name}`}
          className="size-10 ring-2 ring-slate-50"
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{name}</h2>
          <p className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
            <ProviderMark
              provider={
                channelInfo(currentConversation?.channelType).providerId
              }
              className="size-3.5 rounded-sm"
              small
            />
            <span className="truncate">
              {channelInfo(currentConversation?.channelType).label}
              <span className="md:hidden">
                {' '}
                · Nhận qua {currentConversation?.accountName ?? 'Tài khoản'}
              </span>
            </span>
          </p>
        </div>
        {currentConversation ? (
          <div
            className="hidden max-w-[42%] items-center gap-2 rounded-xl border bg-slate-50/60 px-2.5 py-2 md:flex"
            title={`${currentConversation.accountName ?? 'Tài khoản'} · ${currentConversation.accountExternalId ?? ''}`}
          >
            <Avatar
              name={currentConversation.accountName ?? 'Tài khoản'}
              url={currentConversation.accountAvatar}
              className="size-7 text-[9px]"
              label={`Ảnh tài khoản ${currentConversation.accountName ?? 'Tài khoản'}`}
            />
            <div className="min-w-0">
              <p className="truncate text-[9px] text-slate-500">
                Tài khoản nhận tin ·{' '}
                {channelInfo(currentConversation.channelType).shortLabel}
              </p>
              <p className="mt-0.5 truncate text-[11px] font-semibold">
                {currentConversation.accountName ?? 'Tài khoản'}
              </p>
            </div>
          </div>
        ) : null}
        <button
          ref={infoButton}
          type="button"
          disabled={!currentConversation}
          aria-label="Thông tin hội thoại"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen(!detailsOpen)}
          className={cn(
            'rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-50 hover:text-primary disabled:opacity-40',
            detailsOpen && 'bg-teal-50 text-primary',
          )}
        >
          <Info className="size-[18px]" />
        </button>
      </header>
      {read.error ? (
        <p
          role="status"
          className="border-b bg-amber-50 px-4 py-2 text-[11px] text-amber-900"
        >
          Chưa lưu được trạng thái đã đọc.{' '}
          <button className="underline" onClick={read.retry}>
            Thử lại
          </button>
        </p>
      ) : null}
      <div
        ref={viewport}
        role="region"
        aria-label="Cuộn tin nhắn"
        tabIndex={0}
        onScroll={() => {
          const el = viewport.current;
          if (el)
            wasAtBottom.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (
            el &&
            el.scrollTop <= 48 &&
            query.hasNextPage &&
            !query.isFetchingNextPage &&
            !query.isError &&
            !loadingOlder.current
          ) {
            previousHeight.current = el.scrollHeight;
            loadingOlder.current = true;
            void query.fetchNextPage();
          }
        }}
        className="chat-canvas min-h-0 flex-1 overflow-y-auto px-4 py-4 focus:outline-none lg:px-6"
      >
        {query.hasNextPage ? (
          <div className="mb-5 text-center">
            <Button
              variant="outline"
              size="sm"
              disabled={query.isFetchingNextPage}
              onClick={() => {
                const el = viewport.current;
                previousHeight.current = el?.scrollHeight ?? 0;
                loadingOlder.current = true;
                void query.fetchNextPage();
              }}
            >
              {query.isFetchingNextPage ? 'Đang tải…' : 'Xem tin nhắn trước'}
            </Button>
          </div>
        ) : null}
        {query.isPending ? <Loading label="Đang tải tin nhắn…" /> : null}
        {query.error ? (
          <div className="mb-4">
            <ErrorNotice error={query.error} />
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => void query.refetch()}
            >
              Thử lại
            </Button>
          </div>
        ) : null}
        {!query.isPending && !query.error && messages.length === 0 ? (
          <div className="py-20 text-center text-sm text-muted-foreground">
            Chưa có tin nhắn trong hội thoại này.
          </div>
        ) : null}
        <div className="space-y-4">
          {messages.map((message, i) => (
            <div key={message.id}>
              {i === 0 ||
              new Date(messages[i - 1].sentAt).toDateString() !==
                new Date(message.sentAt).toDateString() ? (
                <div className="mb-4 text-center">
                  <span className="rounded-full border border-slate-200/60 bg-white/90 px-3 py-1 text-[9px] text-slate-500">
                    {new Intl.DateTimeFormat('vi-VN', {
                      dateStyle: 'medium',
                    }).format(new Date(message.sentAt))}
                  </span>
                </div>
              ) : null}
              {message.id === firstUnread ? (
                <div
                  role="separator"
                  aria-label="Tin nhắn chưa đọc"
                  className="mb-4 flex items-center gap-3 text-[10px] font-medium text-primary"
                >
                  <span className="h-px flex-1 bg-teal-200" />
                  Tin nhắn chưa đọc
                  <span className="h-px flex-1 bg-teal-200" />
                </div>
              ) : null}
              <MessageBubble
                message={message}
                conversationId={id}
                conversation={currentConversation}
                onMediaLoad={() => {
                  if (
                    wasAtBottom.current &&
                    viewport.current &&
                    !loadingOlder.current
                  )
                    viewport.current.scrollTop = viewport.current.scrollHeight;
                }}
              />
            </div>
          ))}
        </div>
      </div>
      {(currentConversation &&
        [
          'ZALO_PERSONAL',
          'FACEBOOK_PAGE',
          'TIKTOK_BUSINESS',
          'TIKTOK_SHOP',
          'TELEGRAM_BOT',
          'TELEGRAM_PERSONAL',
          'WHATSAPP_BUSINESS',
        ].includes(currentConversation.channelType ?? '')) ||
      (currentConversation?.channelType === 'ZALO_OA' &&
        currentConversation.mediaSupport?.document) ? (
        <>
          <div className="flex shrink-0 items-center gap-2 border-t bg-white px-4 pt-2">
            <Avatar
              name={currentConversation.accountName ?? 'Tài khoản'}
              url={currentConversation.accountAvatar}
              className="size-5 text-[8px]"
            />
            <p className="min-w-0 truncate text-[11px] text-slate-500">
              Trả lời bằng{' '}
              <span className="font-semibold text-slate-800">
                {currentConversation.accountName ?? 'Tài khoản'}
              </span>
              {['FACEBOOK_PAGE', 'WHATSAPP_BUSINESS'].includes(
                currentConversation.channelType ?? '',
              ) && currentConversation.canSend ? (
                <span
                  className="ml-2 text-[9px] text-muted-foreground"
                  title={
                    currentConversation.messagingWindowExpiresAt
                      ? `Có thể trả lời đến ${formatTime(currentConversation.messagingWindowExpiresAt, true)}`
                      : undefined
                  }
                >
                  Trong thời gian trả lời 24 giờ
                </span>
              ) : null}
            </p>
          </div>
          {currentConversation.channelType === 'WHATSAPP_BUSINESS' ? (
            <WhatsAppTemplates
              key={currentConversation.id}
              conversation={currentConversation}
            />
          ) : null}
          <ConversationComposer
            conversationId={id}
            channelType={currentConversation.channelType}
            mediaSupport={currentConversation.mediaSupport}
            canSend={Boolean(currentConversation.canSend)}
            sendBlockedReason={currentConversation.sendBlockedReason}
            source={
              currentConversation.channelType === 'WHATSAPP_BUSINESS'
                ? 'WHATSAPP'
                : currentConversation.channelType?.startsWith('TELEGRAM_')
                  ? 'TELEGRAM'
                  : currentConversation.channelType?.startsWith('TIKTOK_')
                    ? 'TIKTOK'
                    : currentConversation.channelType === 'FACEBOOK_PAGE'
                      ? 'FACEBOOK'
                      : 'PERSONAL'
            }
            onOptimistic={setOptimistic}
          />
        </>
      ) : (
        <footer className="flex items-center justify-center gap-2 border-t bg-white px-5 py-4 text-center text-xs text-muted-foreground">
          <LockKeyhole className="size-3.5 shrink-0" />
          {currentConversation?.channelType === 'FACEBOOK_PERSONAL'
            ? sendBlockedMessage('FACEBOOK_PERSONAL_UNSUPPORTED')
            : 'Kênh chỉ xem. Bạn có thể trả lời trong Zalo OA Manager.'}
        </footer>
      )}
      {detailsOpen && currentConversation ? (
        <ConversationDetails
          conversation={currentConversation}
          messages={messages}
          onClose={closeDetails}
        />
      ) : null}
    </div>
  );
}
function MessageBubble({
  message,
  conversationId,
  conversation,
  onMediaLoad,
}: {
  message: InboxMessage;
  conversationId: string;
  conversation?: Conversation;
  onMediaLoad: () => void;
}) {
  const incoming = message.direction === 'INCOMING';
  const stickerOnly =
    !message.content &&
    message.attachments.length > 0 &&
    message.attachments.every((a) => a.type === 'sticker');
  return (
    <article
      data-inbox-message-id={message.id}
      aria-label={incoming ? 'Tin nhắn đến' : 'Tin nhắn đã gửi'}
      className={cn('flex flex-col items-start', !incoming && 'items-end')}
    >
      <span className="mb-1.5 text-[10px] text-slate-500">
        {incoming
          ? (message.senderName ?? conversation?.customerName ?? 'Contact')
          : (conversation?.accountName ??
            (message.source === 'PERSONAL' ? 'You' : 'Official Account'))}
      </span>
      <div
        className={cn(
          'max-w-[90%] sm:max-w-[78%]',
          !stickerOnly &&
            'rounded-2xl rounded-tl-sm border border-slate-200/60 bg-white px-4 py-2.5 shadow-sm shadow-slate-900/[0.02]',
          !incoming &&
            !stickerOnly &&
            'rounded-tl-2xl rounded-tr-sm border-teal-700 bg-primary text-white',
        )}
      >
        {message.deletedAt ? (
          <p className="text-sm italic">Tin nhắn đã bị xóa trên Telegram.</p>
        ) : message.content ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere]">
            {message.content}
          </p>
        ) : null}
        {!message.deletedAt &&
          message.attachments.map((attachment, i) => (
            <div
              key={`${i}:${attachment.url ?? ''}`}
              className="mt-2 first:mt-0"
            >
              <MessageAttachment attachment={attachment} onLoad={onMediaLoad} />
            </div>
          ))}
        {!message.deletedAt &&
        !message.content &&
        message.attachments.length === 0 ? (
          <p className="text-sm italic">
            {message.type === 'unsupported'
              ? 'Tin nhắn này chưa có dữ liệu để hiển thị.'
              : `[${message.type} message]`}
          </p>
        ) : null}
      </div>
      <p className="mt-1.5 text-[10px] text-slate-500">
        <time
          dateTime={message.sentAt}
          title={formatTime(message.sentAt, true)}
        >
          {new Intl.DateTimeFormat('vi-VN', {
            hour: '2-digit',
            minute: '2-digit',
          }).format(new Date(message.sentAt))}
        </time>
        {message.source === 'HISTORY' ? ' · Imported history' : ''}
        {message.editedAt && !message.deletedAt ? ' · Đã chỉnh sửa' : ''}
      </p>
      {!incoming &&
      ['PERSONAL', 'FACEBOOK', 'TIKTOK', 'TELEGRAM', 'WHATSAPP'].includes(
        message.source ?? '',
      ) ? (
        <DeliveryState message={message} conversationId={conversationId} />
      ) : null}
    </article>
  );
}
