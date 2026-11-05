import { Link } from 'react-router-dom';
import {
  ArrowRight,
  FlaskConical,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { useFacebookPersonalStatus } from '@/features/facebook/queries';
import { ProviderMark } from '@/components/provider-mark';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorNotice, Loading } from '@/components/feedback';

export function FacebookPersonalConnectionPage() {
  const query = useFacebookPersonalStatus();
  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 lg:px-8 lg:py-8">
      <div className="mx-auto max-w-4xl">
        <Link
          to="/apps"
          className="text-xs text-muted-foreground hover:text-primary"
        >
          Ứng dụng / Messenger
        </Link>
        <div className="mb-7 mt-5 flex items-center gap-4">
          <ProviderMark provider="messenger" />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                Messenger cá nhân
              </h1>
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-[10px] text-amber-800">
                <FlaskConical className="size-3" />
                Thử nghiệm
              </span>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Trạng thái và khả năng hỗ trợ tài khoản Messenger cá nhân.
            </p>
          </div>
        </div>
        {query.isPending ? (
          <Loading label="Đang kiểm tra khả năng hỗ trợ…" />
        ) : null}
        {query.error ? (
          <>
            <ErrorNotice error={query.error} />
            <Button
              variant="outline"
              className="mt-3"
              onClick={() => void query.refetch()}
            >
              <RefreshCw />
              Thử lại
            </Button>
          </>
        ) : null}
        {query.data ? (
          <>
            <Card className="border-amber-200 bg-amber-50/50 p-5 sm:p-6">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-800">
                Chưa hỗ trợ kết nối
              </p>
              <h2 className="mt-3 text-lg font-semibold">
                Messenger cá nhân chưa sẵn sàng trong phiên bản này
              </h2>
              <p className="mt-3 text-xs leading-6 text-slate-600">
                {query.data.message}
              </p>
              <p className="mt-3 text-xs leading-6 text-slate-600">
                {query.data.enabled
                  ? 'Tính năng thử nghiệm đã được bật trong cấu hình. Khả năng kết nối vẫn chưa được hỗ trợ.'
                  : 'Tính năng thử nghiệm đang tắt trong cấu hình máy chủ.'}
              </p>
              <Button className="mt-5" disabled>
                Kết nối Messenger cá nhân · Chưa hỗ trợ
              </Button>
            </Card>
            <section
              aria-label="Khả năng Messenger cá nhân"
              className="mt-6 overflow-hidden rounded-2xl border bg-white"
            >
              <h2 className="border-b px-5 py-4 text-sm font-semibold">
                Khả năng hỗ trợ hiện tại
              </h2>
              <dl className="divide-y">
                {[
                  [
                    'Kết nối và khôi phục phiên',
                    query.data.capabilities.connect,
                  ],
                  [
                    'Danh sách hội thoại',
                    query.data.capabilities.listConversations,
                  ],
                  ['Đồng bộ lịch sử', query.data.capabilities.history],
                  ['Nhận tin nhắn trực tiếp', query.data.capabilities.receive],
                  ['Gửi tin nhắn văn bản', query.data.capabilities.sendText],
                  [
                    'Hội thoại mã hóa đầu cuối (E2EE)',
                    query.data.capabilities.e2ee,
                  ],
                ].map(([label, available]) => (
                  <div
                    key={String(label)}
                    className="flex items-center justify-between gap-4 px-5 py-3.5 text-xs"
                  >
                    <dt>{label}</dt>
                    <dd className="shrink-0 text-slate-500">
                      {available ? 'Đã hỗ trợ' : 'Chưa hỗ trợ'}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <Card className="p-5">
                <LockKeyhole className="size-5 text-primary" />
                <h3 className="mt-3 text-sm font-semibold">
                  Không nhập mật khẩu hay cookie
                </h3>
                <p className="mt-2 text-xs leading-6 text-muted-foreground">
                  Phiên bản này không thu thập mật khẩu, cookie hoặc AppState
                  Facebook. Chưa có phương thức đăng nhập cá nhân được kiểm
                  chứng để sử dụng tại đây.
                </p>
              </Card>
              <Card className="p-5">
                <ShieldCheck className="size-5 text-primary" />
                <h3 className="mt-3 text-sm font-semibold">
                  Bạn có thể kết nối Facebook Page
                </h3>
                <p className="mt-2 text-xs leading-6 text-muted-foreground">
                  Nếu quản lý một Page, bạn có thể cấp quyền qua Facebook để
                  nhận và trả lời tin nhắn của Page bằng API chính thức.
                </p>
                <Button asChild variant="outline" size="sm" className="mt-4">
                  <Link to="/facebook/page">
                    Kết nối Facebook Page
                    <ArrowRight />
                  </Link>
                </Button>
              </Card>
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}
