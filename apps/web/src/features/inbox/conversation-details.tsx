import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy, ExternalLink, LockKeyhole, X } from 'lucide-react';
import {
  channelSyncResultSchema,
  type Conversation,
  type InboxMessage,
} from '@zalo/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/feedback';
import { Avatar } from '@/components/avatar';
import { ProviderMark } from '@/components/provider-mark';
import { channelInfo, sendBlockedMessage } from '@/lib/channels';
import { cn, formatTime, safeUrl, attachmentUrl } from '@/lib/utils';

export function ConversationDetails({
  conversation,
  messages,
  onClose,
}: {
  conversation: Conversation;
  messages: InboxMessage[];
  onClose: () => void;
}) {
  const client = useQueryClient();
  const historySync = useMutation({
    mutationFn: () =>
      api(`/conversations/${conversation.id}/sync`, channelSyncResultSchema, {
        method: 'POST',
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['telegram'] });
    },
  });
  const latestIncoming = [...messages]
    .filter(
      (m) => m.direction === 'INCOMING' && m.externalMessageId && !m.deletedAt,
    )
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0];
  const providerRead = useMutation({
    mutationFn: () =>
      api(
        `/conversations/${conversation.id}/whatsapp/read`,
        channelSyncResultSchema,
        {
          method: 'POST',
          body: JSON.stringify({ messageIds: [latestIncoming!.id] }),
        },
      ),
  });
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  const channel = channelInfo(conversation.channelType);
  const isTikTok =
    conversation.channelType?.startsWith('TIKTOK_') ||
    conversation.channelType?.startsWith('TELEGRAM_');
  const contactId =
    conversation.externalContactId ??
    (isTikTok ? null : conversation.externalUserId);
  const name = conversation.customerName ?? conversation.externalUserId;
  const images = messages
    .flatMap((message) => message.attachments)
    .filter(
      (attachment) =>
        ['image', 'photo', 'gif'].includes(attachment.type) &&
        attachmentUrl(attachment),
    )
    .slice(-6);
  useEffect(() => {
    close.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);
  async function copy() {
    setCopied(false);
    try {
      await navigator.clipboard.writeText(
        contactId ??
          conversation.externalConversationId ??
          conversation.externalUserId,
      );
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }
  return (
    <aside
      aria-label="Thông tin hội thoại"
      className="absolute inset-y-0 right-0 z-20 w-full overflow-y-auto border-l bg-white shadow-xl shadow-slate-900/5 sm:max-w-[300px]"
    >
      <div className="flex items-center justify-between border-b px-5 py-5">
        <h3 className="text-sm font-semibold">Thông tin hội thoại</h3>
        <button
          ref={close}
          onClick={onClose}
          aria-label="Đóng thông tin hội thoại"
          className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-50"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="px-5 py-6 text-center">
        <Avatar
          name={name}
          url={conversation.customerAvatar}
          className="mx-auto size-20 text-lg ring-4 ring-slate-50"
        />
        <h4 className="mt-4 break-words text-base font-semibold">{name}</h4>
        <span className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <ProviderMark provider={channel.providerId} small />
          {channel.label}
        </span>
      </div>
      <div className="mx-5 border-y py-4">
        <p className="mb-2 text-[10px] font-medium text-slate-500">
          {contactId ? 'Mã người liên hệ' : 'Mã hội thoại'}
        </p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 break-all text-[11px] text-slate-600">
            {contactId ??
              conversation.externalConversationId ??
              conversation.externalUserId}
          </code>
          <button
            onClick={() => void copy()}
            aria-label="Sao chép mã người liên hệ"
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-50"
          >
            {copied ? (
              <Check className="size-3.5 text-primary" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </button>
        </div>
        {copied || copyError ? (
          <p role="status" className="mt-1 text-[10px] text-muted-foreground">
            {copied
              ? 'Đã sao chép.'
              : 'Chưa thể sao chép. Bạn có thể chọn mã ở trên.'}
          </p>
        ) : null}
      </div>
      <div className="border-b px-5 py-4 text-xs text-slate-600">
        <p>{conversation.inboxUnreadCount ?? 0} tin chưa đọc trong easyChat</p>
        {conversation.unreadCount !== undefined &&
        conversation.unreadCount !== null ? (
          <p className="mt-2 text-[10px] text-muted-foreground">
            {conversation.unreadCount} tin chưa đọc trên {channel.label}. Số này
            do ứng dụng cung cấp.
          </p>
        ) : null}
      </div>
      <div className="px-5 py-5">
        <p className="mb-3 text-[10px] font-medium text-slate-500">
          Tài khoản nhận tin
        </p>
        <div className="rounded-xl border bg-slate-50/60 p-3">
          <div className="flex items-center gap-2.5">
            <Avatar
              name={conversation.accountName ?? 'Tài khoản'}
              url={conversation.accountAvatar}
              className="size-9"
            />
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold">
                {conversation.accountName ?? 'Tài khoản'}
              </p>
              <p className="mt-1 truncate text-[9px] text-muted-foreground">
                {conversation.accountExternalId ?? channel.label}
              </p>
            </div>
          </div>
          <p
            className={cn(
              'mt-3 flex items-center gap-1.5 text-[10px]',
              conversation.canSend ? 'text-emerald-600' : 'text-slate-500',
            )}
          >
            <span
              className={cn(
                'size-1.5 rounded-full',
                conversation.canSend ? 'bg-emerald-500' : 'bg-slate-300',
              )}
            />
            {conversation.canSend
              ? 'Có thể trả lời từ tài khoản này'
              : [
                    'ZALO_PERSONAL',
                    'FACEBOOK_PAGE',
                    'FACEBOOK_PERSONAL',
                    'TIKTOK_BUSINESS',
                    'TIKTOK_SHOP',
                    'TELEGRAM_BOT',
                    'TELEGRAM_PERSONAL',
                    'WHATSAPP_BUSINESS',
                  ].includes(conversation.channelType ?? '')
                ? sendBlockedMessage(conversation.sendBlockedReason)
                : 'Kênh chỉ xem hội thoại'}
          </p>
        </div>
        <Link
          to={channel.settingsPath}
          className="mt-3 inline-flex items-center gap-1 text-[10px] font-medium text-primary"
        >
          Quản lý tài khoản
          <ExternalLink className="size-3" />
        </Link>
      </div>
      {conversation.channelType === 'WHATSAPP_BUSINESS' ? (
        <div className="border-t px-5 py-4">
          <Button
            size="sm"
            variant="outline"
            disabled={!latestIncoming || providerRead.isPending}
            onClick={() => providerRead.mutate()}
          >
            Báo đã đọc trên WhatsApp
          </Button>
          <p className="mt-2 text-[10px] leading-5 text-muted-foreground">
            Gửi xác nhận đọc cho tin nhận gần nhất đang tải. Trạng thái đã đọc
            trong easyChat được quản lý riêng.
          </p>
          {providerRead.isSuccess ? (
            <p role="status" className="mt-2 text-xs text-primary">
              Đã xếp lịch báo đọc trên WhatsApp.
            </p>
          ) : null}
          {providerRead.error ? (
            <ErrorNotice error={providerRead.error} />
          ) : null}
        </div>
      ) : null}
      {conversation.channelType === 'TELEGRAM_PERSONAL' ? (
        <div className="border-t px-5 py-4">
          <Button
            size="sm"
            variant="outline"
            disabled={historySync.isPending}
            onClick={() => historySync.mutate()}
          >
            Đồng bộ lịch sử Telegram
          </Button>
          <p className="mt-2 text-[10px] leading-5 text-muted-foreground">
            Tiếp tục tải phần lịch sử Telegram có thể truy cập. Tin đã đọc trong
            easyChat giữ nguyên trạng thái.
          </p>
          {historySync.isSuccess ? (
            <p role="status" className="mt-2 text-xs text-primary">
              Đã xếp lịch đồng bộ hội thoại.
            </p>
          ) : null}
          {historySync.error ? (
            <div className="mt-2">
              <ErrorNotice error={historySync.error} />
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="border-t px-5 py-5">
        <h4 className="text-xs font-semibold">Ảnh trong tin nhắn đã tải</h4>
        {images.length ? (
          <div className="mt-3 grid grid-cols-3 gap-1.5">
            {images.map((image, i) => (
              <a
                key={`${image.url}:${i}`}
                href={attachmentUrl(image)}
                target="_blank"
                rel="noreferrer"
                aria-label="Mở ảnh gốc"
                className="aspect-square overflow-hidden rounded-lg bg-slate-50"
              >
                <img
                  src={safeUrl(image.previewUrl) ?? attachmentUrl(image)}
                  alt="Ảnh trong hội thoại"
                  className="size-full object-cover"
                  referrerPolicy="no-referrer"
                  loading="lazy"
                />
              </a>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
            Chưa có ảnh trong phần hội thoại đã tải.
          </p>
        )}
        {conversation.lastMessageAt ? (
          <p className="mt-4 text-[10px] leading-5 text-muted-foreground">
            Tin gần nhất: {formatTime(conversation.lastMessageAt, true)}
          </p>
        ) : null}
      </div>
      <p className="flex items-center gap-1.5 px-5 pb-5 text-[9px] text-slate-500">
        <LockKeyhole className="size-3" />
        Lưu trong không gian riêng tư của bạn
      </p>
    </aside>
  );
}
