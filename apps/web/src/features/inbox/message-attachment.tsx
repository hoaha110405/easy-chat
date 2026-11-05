import { useState } from 'react';
import { FileText, ImageOff, Sticker } from 'lucide-react';
import type { InboxMessage } from '@zalo/shared';
import { cn, safeUrl } from '@/lib/utils';

export function MessageAttachment({
  attachment,
  onLoad,
}: {
  attachment: InboxMessage['attachments'][number];
  onLoad?: () => void;
}) {
  const url = safeUrl(attachment.url);
  const preview = safeUrl(attachment.previewUrl);
  const [failed, setFailed] = useState<string[]>([]);
  const sticker = attachment.type === 'sticker';
  const image = ['image', 'photo', 'gif', 'sticker'].includes(attachment.type);
  const src = [url, preview].find((value): value is string =>
    Boolean(value && !failed.includes(value)),
  );
  const label = attachment.name ?? (sticker ? 'Sticker' : 'Ảnh đính kèm');
  if (image) {
    return src ? (
      <a
        href={url ?? src}
        target="_blank"
        rel="noreferrer"
        className="block"
        aria-label={sticker ? 'Mở sticker' : 'Mở ảnh gốc'}
      >
        <img
          src={src}
          alt={label}
          className={cn(
            'max-h-80 max-w-full rounded-lg object-contain',
            sticker ? 'size-36' : 'w-auto',
          )}
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={onLoad}
          onError={() => setFailed((values) => [...values, src])}
        />
      </a>
    ) : (
      <div
        className="flex items-center gap-2 rounded-lg border border-current/15 px-3 py-4 text-xs"
        role="status"
      >
        {sticker ? (
          <Sticker className="size-4 shrink-0" />
        ) : (
          <ImageOff className="size-4 shrink-0" />
        )}
        <span>
          {url || preview
            ? sticker
              ? 'Không tải được sticker.'
              : 'Ảnh không còn khả dụng.'
            : sticker
              ? 'Sticker chưa có ảnh xem trước.'
              : 'Ảnh chưa có liên kết tải.'}
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="ml-1 underline"
            >
              Mở liên kết gốc
            </a>
          ) : null}
        </span>
      </div>
    );
  }
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-2 text-sm underline underline-offset-4"
    >
      <FileText className="size-4" />
      {attachment.name ?? `${attachment.type} attachment`}
    </a>
  ) : (
    <span className="text-sm">
      {attachment.name ?? `${attachment.type} attachment`}
    </span>
  );
}
