import { z } from 'zod';

export const mediaUrl = z
  .string()
  .max(8192)
  .url()
  .refine((value) => /^https?:\/\//i.test(value));
export const personalAttachmentSchema = z.object({
  type: z.enum(['image', 'gif', 'sticker']),
  payload: z.object({
    url: mediaUrl.optional(),
    previewUrl: mediaUrl.optional(),
    name: z.string().max(500).optional(),
    stickerId: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  }),
});
export type PersonalAttachment = z.infer<typeof personalAttachmentSchema>;
function firstUrl(...values: unknown[]) {
  for (const value of values) {
    const parsed = mediaUrl.safeParse(value);
    if (parsed.success) return parsed.data;
  }
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value === 'string' && value.length <= 65536) {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function normalizePersonalContent(
  msgType: string,
  value: unknown,
): {
  type: string;
  content: string;
  attachments: PersonalAttachment[];
} {
  const kind = (
    {
      'chat.photo': 'image',
      'chat.sticker': 'sticker',
      'chat.gif': 'gif',
    } as Record<string, 'image' | 'gif' | 'sticker'>
  )[msgType];
  if (!kind)
    return {
      type: typeof value === 'string' ? 'text' : 'unsupported',
      content: typeof value === 'string' ? value : '',
      attachments: [],
    };
  const item = record(value);
  const params = record(item.params);
  const url =
    kind === 'sticker'
      ? firstUrl(
          item.stickerWebpUrl,
          item.stickerUrl,
          item.href,
          item.url,
          item.uri,
          item.thumb,
          value,
        )
      : firstUrl(
          params.hdUrl,
          item.hdUrl,
          item.href,
          item.normalUrl,
          params.normalUrl,
          item.rawUrl,
          item.oriUrl,
          item.url,
          item.thumb,
          value,
        );
  const previewUrl = firstUrl(item.thumb, item.thumbUrl, params.thumbUrl);
  const stickerId = z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .safeParse(item.id ?? item.stickerId ?? item.sticker_id);
  const description = z
    .string()
    .max(10000)
    .safeParse(item.description ?? params.desc);
  return {
    type: kind,
    content: kind !== 'sticker' && description.success ? description.data : '',
    attachments: [
      {
        type: kind,
        payload: {
          ...(url ? { url } : {}),
          ...(previewUrl ? { previewUrl } : {}),
          ...(kind === 'sticker' && stickerId.success
            ? { stickerId: stickerId.data }
            : {}),
        },
      },
    ],
  };
}
