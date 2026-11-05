import { useState, type FormEvent } from 'react';
import {
  ArrowRight,
  Check,
  LockKeyhole,
  MessageCircle,
  ShieldCheck,
} from 'lucide-react';
import { Brand } from '@/components/brand';
import { ProviderMark } from '@/components/provider-mark';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorNotice } from '@/components/feedback';

export function LoginPage({
  onLogin,
}: {
  onLogin: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await onLogin(password);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-[#123d38] px-12 py-10 text-white lg:flex lg:flex-col xl:px-20">
        <Brand className="[&>span:last-child]:text-white" />
        <div className="relative z-10 my-auto max-w-md py-16">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-[10px] font-medium text-teal-100">
            <span className="size-1.5 rounded-full bg-teal-300" />
            Không gian của những kết nối
          </span>
          <h1 className="mt-7 text-[44px] font-semibold leading-[1.2] tracking-tight xl:text-[52px]">
            Mọi tin nhắn.
            <br />
            <span className="text-teal-200">Một nơi thân quen.</span>
          </h1>
          <p className="mt-5 max-w-sm text-sm leading-7 text-teal-50/65">
            Quản lý tài khoản, theo dõi cuộc trò chuyện và giữ liên lạc trong
            cùng một không gian.
          </p>
          <div className="mt-10 space-y-4">
            {[
              'Nhận biết rõ từng tài khoản đang trò chuyện',
              'Ảnh, sticker và tin nhắn trong cùng hộp thư',
              'Thông tin kết nối được bảo vệ trên máy chủ',
            ].map((text) => (
              <p
                key={text}
                className="flex items-center gap-2.5 text-xs text-teal-50/75"
              >
                <span className="grid size-5 place-items-center rounded-full bg-white/10 text-teal-200">
                  <Check className="size-3" />
                </span>
                {text}
              </p>
            ))}
          </div>
          <div aria-hidden="true" className="mt-12 flex items-center gap-3">
            <ProviderMark
              provider="zalo"
              className="size-11 border-4 border-white/10"
            />
            <span className="w-8 border-t border-dashed border-teal-200/30" />
            <span className="grid size-14 place-items-center rounded-2xl border border-white/15 bg-white/10 text-teal-100">
              <MessageCircle className="size-6" />
            </span>
            <span className="w-8 border-t border-dashed border-teal-200/30" />
            <span className="grid size-11 place-items-center rounded-xl border border-dashed border-white/15 text-xl font-light text-teal-100/50">
              +
            </span>
          </div>
        </div>
        <p className="relative z-10 flex items-center gap-2 text-[10px] text-teal-50/45">
          <ShieldCheck className="size-3.5" />
          Không gian riêng tư. Kết nối theo cách của bạn.
        </p>
        <div
          aria-hidden="true"
          className="absolute -bottom-48 -right-48 size-[620px] rounded-full border border-white/[0.04]"
        />
        <div
          aria-hidden="true"
          className="absolute -bottom-28 -right-28 size-[450px] rounded-full border border-white/[0.04]"
        />
      </aside>
      <main className="flex min-h-dvh flex-col bg-white px-6 py-8 sm:px-12">
        <Brand compact className="lg:hidden" />
        <div className="m-auto w-full max-w-[360px] py-12">
          <div className="mb-7 grid size-12 place-items-center rounded-2xl bg-teal-50 text-primary">
            <LockKeyhole className="size-5" />
          </div>
          <p className="eyebrow">Không gian làm việc của bạn</p>
          <h2 className="mt-3 text-[30px] font-semibold tracking-tight">
            Chào mừng bạn
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Đăng nhập để tiếp tục các cuộc trò chuyện và quản lý kết nối của
            bạn.
          </p>
          <form onSubmit={submit} className="mt-8">
            <label
              htmlFor="password"
              className="mb-2.5 block text-xs font-semibold"
            >
              Mật khẩu quản trị
            </label>
            <Input
              id="password"
              autoComplete="current-password"
              type="password"
              required
              maxLength={256}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Nhập mật khẩu của bạn"
              className="h-12 rounded-xl bg-slate-50/50 text-sm"
            />
            {error ? (
              <div className="mt-4">
                <ErrorNotice error={error} />
              </div>
            ) : null}
            <Button disabled={pending} className="mt-5 h-12 w-full rounded-xl">
              {pending ? 'Đang đăng nhập…' : 'Vào không gian làm việc'}
              <ArrowRight className="ml-auto" />
            </Button>
            <p className="mt-5 text-center text-[11px] leading-6 text-muted-foreground">
              Sử dụng mật khẩu được quản trị viên cung cấp
              <br />
              cho không gian làm việc này.
            </p>
          </form>
        </div>
        <p className="text-center text-[10px] text-slate-400">
          easyChat · Kết nối gọn gàng hơn mỗi ngày.
        </p>
      </main>
    </div>
  );
}
