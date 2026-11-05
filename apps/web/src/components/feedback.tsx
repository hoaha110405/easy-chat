import { AlertCircle, Loader2 } from 'lucide-react';
export function ErrorNotice({ error }: { error: unknown }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <span>
        {error instanceof Error
          ? error.message
          : 'Đã có lỗi xảy ra. Vui lòng thử lại.'}
      </span>
    </div>
  );
}
export function Loading({ label = 'Đang tải…' }: { label?: string }) {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground"
    >
      <Loader2 className="size-4 animate-spin" />
      {label}
    </div>
  );
}
