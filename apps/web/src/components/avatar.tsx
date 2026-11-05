import { useState } from 'react';
import { cn, safeUrl } from '@/lib/utils';
export function Avatar({
  name,
  url,
  className,
  label,
}: {
  name: string;
  url?: string | null;
  className?: string;
  label?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const initials = name.slice(0, 2).toUpperCase();
  return (
    <div
      role={label ? 'img' : undefined}
      aria-label={label}
      className={cn(
        'flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-blue-100 text-xs font-semibold text-blue-800',
        className,
      )}
    >
      {safeUrl(url) && url !== failedUrl ? (
        <img
          src={safeUrl(url)}
          onError={() => setFailedUrl(url ?? undefined)}
          alt=""
          className="size-full object-cover"
          referrerPolicy="no-referrer"
        />
      ) : (
        initials
      )}
    </div>
  );
}
