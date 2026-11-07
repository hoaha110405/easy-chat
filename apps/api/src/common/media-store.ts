import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { ConfigService } from '../config/config.service';
import { ApiError } from './api-error';

export type StoredMedia = {
  bytes: Buffer;
  name: string;
  mime: string;
  size: number;
  sha256: string;
};
export const MEDIA_RETENTION_MS = 30 * 86400000;
export const MEDIA_MAX_BYTES = 20_000_000;
const magic = Buffer.from('ECM1');
@Injectable()
export class MediaStore {
  constructor(
    readonly db: PrismaService,
    readonly config: ConfigService,
  ) {}
  private encrypt(bytes: Buffer, messageId: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv(
        'aes-256-gcm',
        Buffer.from(this.config.env.TOKEN_ENCRYPTION_KEY, 'hex'),
        iv,
      );
    cipher.setAAD(Buffer.from(messageId));
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([magic, iv, cipher.getAuthTag(), encrypted]);
  }
  private decrypt(value: Uint8Array, messageId: string) {
    const bytes = Buffer.from(value);
    if (bytes.length < 32 || !bytes.subarray(0, 4).equals(magic))
      throw Error('Invalid media envelope');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(this.config.env.TOKEN_ENCRYPTION_KEY, 'hex'),
      bytes.subarray(4, 16),
    );
    decipher.setAuthTag(bytes.subarray(16, 32));
    decipher.setAAD(Buffer.from(messageId));
    return Buffer.concat([
      decipher.update(bytes.subarray(32)),
      decipher.final(),
    ]);
  }
  async put(
    tx: Prisma.TransactionClient,
    messageId: string,
    media: Omit<StoredMedia, 'sha256'>,
  ) {
    if (
      media.bytes.length < 1 ||
      media.bytes.length > MEDIA_MAX_BYTES ||
      media.bytes.length !== media.size
    )
      throw new ApiError(
        413,
        'MEDIA_TOO_LARGE',
        'Tệp rỗng hoặc vượt quá dung lượng cho phép.',
      );
    const message = await tx.message.findUniqueOrThrow({
      where: { id: messageId },
      select: {
        connectionId: true,
        channelAccount: { select: { ownerId: true } },
      },
    });
    if (!message.channelAccount && !message.connectionId)
      throw new ApiError(
        409,
        'MEDIA_ACCOUNT_REQUIRED',
        'Tệp cần gắn với tài khoản gửi.',
      );
    const ownerId = message.channelAccount?.ownerId ?? 'administrator';
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(240017, hashtext(${ownerId}))`;
    const existing = await tx.messageMedia.findUnique({
      where: { messageId },
      select: { expiresAt: true },
    });
    if (existing && existing.expiresAt > new Date()) return;
    const used = await tx.messageMedia.aggregate({
      where: {
        expiresAt: { gt: new Date() },
        message: {
          OR: [
            { channelAccount: { ownerId } },
            ...(ownerId === 'administrator'
              ? [{ connectionId: { not: null } }]
              : []),
          ],
        },
      },
      _sum: { size: true },
    });
    if ((used._sum.size ?? 0) + media.size > 1_000_000_000)
      throw new ApiError(
        413,
        'MEDIA_QUOTA_EXCEEDED',
        'Dung lượng tệp lưu của workspace đã đạt giới hạn 1 GB.',
      );
    const data = {
      name:
        media.name.replace(/[^\p{L}\p{N}_. -]/gu, '_').slice(0, 150) ||
        'attachment',
      mime: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(media.mime)
        ? media.mime
        : 'application/octet-stream',
      size: media.size,
      sha256: createHash('sha256').update(media.bytes).digest('hex'),
      encryptedBytes: this.encrypt(media.bytes, messageId),
      expiresAt: new Date(Date.now() + MEDIA_RETENTION_MS),
    };
    return tx.messageMedia.upsert({
      where: { messageId },
      create: { messageId, ...data },
      update: data,
    });
  }
  async read(messageId: string): Promise<StoredMedia> {
    const value = await this.db.messageMedia.findUnique({
      where: { messageId },
    });
    if (!value || value.expiresAt < new Date())
      throw new ApiError(
        410,
        'MEDIA_EXPIRED',
        'Tệp không còn được lưu. Hãy chọn tệp và gửi lại nếu cần.',
      );
    try {
      const bytes = this.decrypt(value.encryptedBytes, messageId);
      if (
        bytes.length !== value.size ||
        createHash('sha256').update(bytes).digest('hex') !== value.sha256
      )
        throw Error('Invalid digest');
      return {
        bytes,
        name: value.name,
        mime: value.mime,
        size: value.size,
        sha256: value.sha256,
      };
    } catch {
      throw new ApiError(503, 'MEDIA_UNAVAILABLE', 'Chưa đọc được tệp đã lưu.');
    }
  }
  async exists(messageId: string) {
    return Boolean(
      await this.db.messageMedia.findFirst({
        where: { messageId, expiresAt: { gt: new Date() } },
        select: { id: true },
      }),
    );
  }
  async cleanup() {
    // Delete bounded batches, retaining the surrounding message/history.
    const expired = await this.db.messageMedia.findMany({
      where: { expiresAt: { lt: new Date() } },
      take: 25,
      select: { id: true },
    });
    if (expired.length)
      await this.db.messageMedia.deleteMany({
        where: { id: { in: expired.map((v) => v.id) } },
      });
  }
}
