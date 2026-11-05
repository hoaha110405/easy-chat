import { MessagesSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
export function Brand({
  compact = false,
  iconOnly = false,
  className,
}: {
  compact?: boolean;
  iconOnly?: boolean;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-white shadow-sm shadow-teal-900/10">
        <MessagesSquare className="size-5" />
      </span>
      {!iconOnly ? (
        <span className="text-[19px] font-bold tracking-[-0.05em] text-foreground">
          easyChat
          {!compact ? (
            <span className="mt-0.5 block text-[9px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Không gian kết nối
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
