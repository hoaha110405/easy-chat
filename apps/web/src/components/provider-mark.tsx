import {
  Camera,
  Mail,
  MessageCircle,
  Zap,
  Music2,
  ShoppingBag,
  SendHorizontal,
} from 'lucide-react';
import { providers, type ProviderId } from '@/lib/channels';
import { cn } from '@/lib/utils';

export function ProviderMark({
  provider,
  className,
  small = false,
}: {
  provider?: ProviderId;
  className?: string;
  small?: boolean;
}) {
  const definition = providers.find((item) => item.id === provider);
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-2xl font-semibold',
        small ? 'size-6 rounded-lg text-[9px]' : 'size-12 text-base',
        className,
      )}
      style={{
        background: definition?.background ?? '#eef1f4',
        color: definition?.color ?? '#64748b',
      }}
    >
      {provider === 'zalo' ? (
        <span
          className={cn(
            'tracking-[-0.06em]',
            small ? 'text-[9px]' : 'text-[15px]',
          )}
        >
          {small ? 'Z' : 'Zalo'}
        </span>
      ) : provider === 'whatsapp' ? (
        <MessageCircle className={small ? 'size-3.5' : 'size-6'} />
      ) : provider === 'telegram' ? (
        <SendHorizontal className={small ? 'size-3.5' : 'size-6'} />
      ) : provider === 'tiktok-business' ? (
        <Music2 className={small ? 'size-3.5' : 'size-6'} />
      ) : provider === 'tiktok-shop' ? (
        <ShoppingBag className={small ? 'size-3.5' : 'size-6'} />
      ) : provider === 'instagram' ? (
        <Camera className={small ? 'size-3.5' : 'size-6'} />
      ) : provider === 'email' ? (
        <Mail className={small ? 'size-3.5' : 'size-6'} />
      ) : provider === 'messenger' ? (
        <Zap className={small ? 'size-3.5' : 'size-6'} />
      ) : (
        <MessageCircle className={small ? 'size-3.5' : 'size-6'} />
      )}
    </span>
  );
}
