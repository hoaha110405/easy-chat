import { apiBaseUrl } from '@/lib/api';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
export function normalizeSearch(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLocaleLowerCase('vi')
    .trim();
}
export function safeUrl(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}
export function formatTime(value: string | null, full = false) {
  if (!value) return '';
  return new Intl.DateTimeFormat(
    'vi-VN',
    full
      ? { dateStyle: 'medium', timeStyle: 'short' }
      : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  ).format(new Date(value));
}

export function attachmentUrl(a: {
  url: string | null;
  authenticatedPath?: string;
}) {
  if (
    a.authenticatedPath &&
    /^\/(?:channels\/whatsapp\/)?messages\/[a-z0-9]+\/media$/.test(
      a.authenticatedPath,
    )
  )
    return apiBaseUrl + a.authenticatedPath;
  return safeUrl(a.url);
}
